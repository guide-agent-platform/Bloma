/**
 * PRD 裁判审查门（prd-review）——简化版 AC 对抗审计，2026-08-26。
 *
 * 方法论来源：用户指定 skill「ac-audit」（对抗-收敛文档审计，~/.claude/skills/ac-audit）。
 * 运行时按用户要求做流程精简（单轮、秒级、独立一次模型请求）：
 *
 * 保留的 AC 精髓                          砍掉的部分（时间成本）
 * - 六维攻击面 I-F-Z-U-L-G + PRD 权重      - 多轮循环（MIN_ROUNDS=3）
 * - 严重度分级 blocking/major/minor        - Defender 修复循环（裁判只判定不修复）
 * - 每个 issue 必须引用 PRD 原文证据       - 双 Arbiter / Prober / 金丝雀 / 重叠度实测
 * - 判定边界速记 + 禁止编造/禁止提修复方案  - 指纹回显 / dry-run 副本（PRD 不被修改）
 * - 诚实降级标注 simplified_ac             -
 *
 * 独立性（AC 铁律「审查者≠生成者」）：审查是单独一次模型请求，绝不并进 PRD 生成调用
 * 自查；渠道优先走 M5 类别路由的 prd 类（可在职责分工里指到快模型），解析失败回退
 * 向导轮 env，再失败降级确定性规则门——审查是门禁增强，不是硬依赖，永不阻断主流程。
 *
 * 裁决规则（代码级，不信任模型自报宽松结论）：issues 中存在 blocking/major
 * → needs_revision（退用户决策卡：忽略继续 / 我来补充）；否则 pass → PRD 确认卡（2026-08-27 起用户过目后才开草图，不过目不开工）。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput } from '../shared/types'
import { recordDecision } from './decision-log'
import { publishPrdConfirmCard } from './prd-confirm'
import type { PrdBackplane } from './sketch-engine'
import type { SDKQuery } from './orchestrator'
import { delegatedReviewEnabled, runDelegatedReview } from './review-delegation'

// =========================================================================
// 类型
// =========================================================================

export type PrdReviewDimension = 'I' | 'F' | 'Z' | 'U' | 'L' | 'G'

/** 逐题选择题的候选答案（2026-08-30：审查问题选择题化 + 零基础话术）。 */
export interface PrdReviewOption {
  id: string
  label: string
  description?: string
}

export interface PrdReviewIssue {
  dimension: PrdReviewDimension
  severity: 'blocking' | 'major' | 'minor' | 'suggestion'
  /** PRD 中的位置（功能项 id 或原句片段） */
  location: string
  /** 专业版问题描述（内部裁决/日志用，不再直接暴露给用户） */
  claim: string
  evidence: string[]
  /** 零基础大白话问题（审查时一并产出；缺省回退 claim） */
  plain_question?: string
  /** 逐题选择题的候选答案（缺省/全灭时由代码层补「这条没问题」兜底） */
  options?: PrdReviewOption[]
}

export interface PrdReviewOutcome {
  verdict: 'pass' | 'needs_revision'
  issues: PrdReviewIssue[]
  /** llm = 六维攻击审查；rules = LLM 不可用后的确定性降级 */
  mode: 'llm' | 'rules'
  /** llm 路径执行方式：delegation = 委派子 agent（可视化）；direct = 平台直连 */
  via?: 'delegation' | 'direct'
  degraded?: boolean
  /** 用户主动停止（AGENT_STOP）：调用方收到后应立即终止管线，不推进草图/卡片 */
  aborted?: true
}

/** 逐题选择题的固定兜底选项：每题必带「这条没问题」出口（不依赖模型输出）。 */
export const REVIEW_OPTION_IGNORE: PrdReviewOption = {
  id: 'ignore',
  label: '这条没问题',
  description: '不改这一条',
}

/** 全局让渡出口 id：用户不想逐题作答时一次性把决定权交给向导。 */
export const PRD_REVIEW_OPTION_DELEGATE_ALL = 'prd_review_delegate_all'

/** 审查未过后的待决状态：用户可选忽略（override→过 PRD 确认门）或补充说明（回向导）。 */
interface PendingPrdReview {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: Array<{ id: string; description: string }>
  issues: PrdReviewIssue[]
  /** 审查时的背板：override 后转 PRD 确认门要用（2026-08-27，不过目不开工） */
  backplane: PrdBackplane
  query: SDKQuery
  publish: (event: AgentEvent) => void
}

const pendingPrdReviews = new Map<string, PendingPrdReview>()

export function takePendingPrdReview(projectId: string): PendingPrdReview | undefined {
  const pending = pendingPrdReviews.get(projectId)
  pendingPrdReviews.delete(projectId)
  return pending
}

export function hasPendingPrdReview(projectId: string): boolean {
  return pendingPrdReviews.has(projectId)
}

/** PRD 审查决策卡的选项 id（卡片回传经 send-message 的 card_option 元数据识别）。 */
export const PRD_REVIEW_OPTION_OVERRIDE = 'prd_review_override'
export const PRD_REVIEW_OPTION_SUPPLEMENT = 'prd_review_supplement'

// =========================================================================
// 审查执行
// =========================================================================

/** 简化版 AC 审查 system prompt（六维攻击面 + PRD 权重 + 证据/严重度/禁编造铁律）。 */
export const PRD_REVIEW_SYSTEM_PROMPT = [
  '你是文档攻击者（Attacker）兼裁决者——简化版 AC 对抗审计（单轮）。目标：对给出的 PRD 执行六维攻击式审查，找出真实缺陷。',
  '',
  '【方法声明】对抗-收敛（AC）审计的简化运行：单轮攻击、无 Defender 修复、无独立仲裁。报告将标注 simplified_ac=true，不冒充完整方法论。',
  '判定边界速记：换名不矛盾（归 U）；「很难但有可能」只标 suggestion；需求文档不要求给实现方案。',
  '',
  '【六维攻击面】（括号为 PRD 权重，火力分配参考）',
  '- F 保真（30%）：PRD 是否忠实于【用户确认的需求清单】——缺项、改偏、擅自加戏',
  '- U 可懂（20%）：歧义、一义多解、未定义术语',
  '- L 闭环（15%）：功能路径不闭环（如只有添加没有查看/删除）',
  '- G 护栏（15%）：无可客观度量的验收（「要快」「要好用」）、缺失边界情形',
  '- I 自洽（10%）：条目间相互矛盾',
  '- Z 可造（10%）：违反工程常识（「零延迟」「无限容量」）',
  '',
  '【规则】',
  '- 每个缺陷必须引用 PRD 原文证据（功能项 id 或原句），无证据不报',
  '- 严重度：blocking（无法开工/核心缺失）> major（会做错方向）> minor > suggestion',
  '- 不许提修复方案（只指出问题，修复是用户与向导的事）',
  '- 某维找不到缺陷 → 记入 clean_dimensions；不确定 → 同样记 clean，禁止编造',
  '- blocking/major 合计通常 0~3 个；把整份需求说得一无是处通常是过度攻击，不是严格',
  '',
  '【输出】严格 JSON，不要 markdown 围栏，不要任何多余文字：',
  '{"issues":[{"dimension":"F","severity":"blocking","location":"F-001","claim":"专业问题描述","evidence":["PRD 原句或字段值"],"plain_question":"零基础大白话问题","options":[{"id":"opt-1","label":"具体答案（≤10 字）","description":"选它后会做成什么样（≤20 字）"}]}],',
  ' "clean_dimensions":["I","Z"]}',
  '',
  '【人话化要求（选择题化，2026-08-30）】',
  '- blocking/major 的 issue 必须带 plain_question 和 options；minor/suggestion 可不带。',
  '- plain_question：零基础大白话，像跟不懂技术的人说话（例：「有一个功能，你还没说清楚它到底要做什么」）；禁止出现 blocking/major/F保真/可懂/闭环/护栏/自洽/可造/验收/度量等术语。',
  '- options：用户点选后需求会改成什么样，具体、互斥、零基础可懂（例：「只在电脑上用」「手机也能用」）；label ≤10 字、description ≤20 字，2~4 条。',
  '- options 里不需要放「忽略/不改」——平台会固定追加；不要放「你帮我决定」类让渡（平台另有全局出口）。',
].join('\n')

/**
 * PRD 审查门主入口：LLM 六维攻击审查（独立一次请求）→ 代码级裁决；env 不可用或
 * LLM 失败 → 确定性规则门降级。永不抛错（门禁增强不是硬依赖）。
 */
export async function runPrdReviewGate(opts: {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  query: SDKQuery
  env: Record<string, string> | undefined
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
  /** 委派可视化（2026-08-26）：三者齐备时优先走委派子 agent，否则直连 */
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
}): Promise<PrdReviewOutcome> {
  const { backplane, confirmedRequirements, query, env, sessionId, signal, maxTokens } = opts
  if (!env) {
    // 无可用渠道 env：直接规则门（不算 degraded——渠道不可用的如实降级）
    return ruleGateReview(backplane)
  }
  // ① 委派审查（默认，协作过程经 DelegationFeed 可视化）；解析失败/委派失败落直连。
  // 例外：aborted（用户停止）不得降级直连——那会让「停止后再跑一遍」
  if (delegatedReviewEnabled() && opts.projectId && opts.requestId && opts.publish) {
    const delegated = await runDelegatedReview({
      goal: `裁判六维审查 PRD：${backplane.name ?? '未命名项目'}`,
      task: buildPrdReviewTask(backplane, confirmedRequirements),
      system: PRD_REVIEW_SYSTEM_PROMPT,
      query,
      env,
      sessionId,
      projectId: opts.projectId,
      requestId: opts.requestId,
      publish: opts.publish,
      signal: opts.signal,
    })
    if (delegated.failure === 'aborted') {
      return { verdict: 'pass', issues: [], mode: 'llm', via: 'delegation', aborted: true }
    }
    if (delegated.ok && delegated.finalText) {
      try {
        const issues = parseReviewIssues(delegated.finalText)
        return { verdict: deriveVerdict(issues), issues, mode: 'llm', via: 'delegation' }
      } catch {
        console.error('[prd-review] 委派审查输出不可解析，回退直连')
      }
    }
  }
  // ② 直连单次请求
  try {
    const issues = await attackViaLlm({ backplane, confirmedRequirements, query, env, sessionId, signal, maxTokens })
    return { verdict: deriveVerdict(issues), issues, mode: 'llm', via: 'direct' }
  } catch (error) {
    // 用户停止（abort 抛 AbortError）：不降级规则门（降级会继续往下跑卡片/草图）
    if (opts.signal?.aborted) {
      return { verdict: 'pass', issues: [], mode: 'llm', via: 'direct', aborted: true }
    }
    console.error('[prd-review] LLM 审查失败，降级规则门:', error)
    return { ...ruleGateReview(backplane), degraded: true }
  }
}

/** 代码级裁决：blocking/major 存在即 needs_revision（不信任模型自报的宽松结论）。 */
function deriveVerdict(issues: PrdReviewIssue[]): 'pass' | 'needs_revision' {
  return issues.some((issue) => issue.severity === 'blocking' || issue.severity === 'major')
    ? 'needs_revision'
    : 'pass'
}

/** 审查任务体（委派与直连共用）：PRD 全文 + 用户确认清单 + 输出指令。 */
function buildPrdReviewTask(
  backplane: PrdBackplane,
  confirmedRequirements: Array<{ id: string; description: string }>,
): string {
  return [
    '【PRD 全文（背板 JSON）】',
    JSON.stringify(
      {
        name: backplane.name,
        positioning: backplane.positioning,
        requirements: backplane.requirements,
        out_of_scope: backplane.out_of_scope,
        constraints: backplane.constraints,
      },
      null,
      2,
    ),
    '',
    '【用户确认的需求清单（F 保真维度的对照基准）】',
    confirmedRequirements.length
      ? confirmedRequirements.map((item) => `- ${item.id}: ${item.description}`).join('\n')
      : '- （无已确认清单，F 维度记 clean）',
    '',
    '现在执行六维攻击审查，按【输出】格式给出 JSON。',
  ].join('\n')
}

/** LLM 攻击轮（直连）：内联 PRD 全文 + 用户确认清单（F 维的对照基准）。 */
async function attackViaLlm(opts: {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
}): Promise<PrdReviewIssue[]> {
  const prompt = [PRD_REVIEW_SYSTEM_PROMPT, '', buildPrdReviewTask(opts.backplane, opts.confirmedRequirements)].join('\n')

  const texts: string[] = []
  for await (const message of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal ?? new AbortController().signal,
    sessionId: opts.sessionId,
    maxTokens: opts.maxTokens ?? 2048,
    temperature: 0.1,
  })) {
    if (message.type !== 'assistant' || !message.message) continue
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  return parseReviewIssues(texts.join(''))
}

/** 稳健解析：剥围栏 → 截取首尾大括号 → JSON；维度/严重度白名单校验。 */
export function parseReviewIssues(text: string): PrdReviewIssue[] {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('PRD_REVIEW_PARSE_FAILED: 输出中无 JSON 对象')
  let parsed: { issues?: unknown }
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as { issues?: unknown }
  } catch {
    throw new Error('PRD_REVIEW_PARSE_FAILED: JSON 解析失败')
  }
  const dimensions = new Set(['I', 'F', 'Z', 'U', 'L', 'G'])
  const severities = new Set(['blocking', 'major', 'minor', 'suggestion'])
  const issues: PrdReviewIssue[] = []
  for (const raw of Array.isArray(parsed.issues) ? parsed.issues : []) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const dimension = String(item.dimension ?? '')
    const severity = String(item.severity ?? '')
    const claim = typeof item.claim === 'string' ? item.claim.trim() : ''
    if (!dimensions.has(dimension) || !severities.has(severity) || !claim) continue
    const plainQuestion = typeof item.plain_question === 'string' ? item.plain_question.trim() : ''
    const options = sanitizeReviewOptions(item.options)
    issues.push({
      dimension: dimension as PrdReviewDimension,
      severity: severity as PrdReviewIssue['severity'],
      location: typeof item.location === 'string' ? item.location.trim().slice(0, 80) : '',
      claim: claim.slice(0, 200),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 3)
        : [],
      ...(plainQuestion ? { plain_question: plainQuestion.slice(0, 80) } : {}),
      ...(options.length > 0 ? { options } : {}),
    })
  }
  return issues
}

/**
 * 审查选项纠偏（与向导澄清卡同款思路）：模型输出的 options 一律不信任——
 * 占位/问句式 label 丢弃、去重、超长截断；最多保留 4 条。id 允许缺省时用 label 兑底。
 * 只处理展示层，不触碰「代码型 JSON 不可修补」红线（选项全灭时由调用方补兜底）。
 */
function sanitizeReviewOptions(raw: unknown): PrdReviewOption[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const options: PrdReviewOption[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const item = entry as Record<string, unknown>
    const label = typeof item.label === 'string' ? item.label.replace(/\s+/g, ' ').trim().slice(0, 12) : ''
    if (label.length < 2 || /[?？]$/.test(label) || seen.has(label)) continue
    if (/^(范围)?选项\s*[一二三四五六七八九十0-9a-c]?$|^option\s*[a-c]?$/i.test(label)) continue
    seen.add(label)
    const description = typeof item.description === 'string'
      ? item.description.replace(/\s+/g, ' ').trim().slice(0, 30)
      : ''
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim().slice(0, 40) : label
    options.push(description ? { id, label, description } : { id, label })
    if (options.length >= 4) break
  }
  return options
}

/** 确定性规则门（LLM 不可用降级）：只拦硬伤，宁松勿严。附带零基础话术 + 通用选项（无 LLM 生成贴合的选项，给通用出口）。 */
export function ruleGateReview(backplane: PrdBackplane): PrdReviewOutcome {
  const issues: PrdReviewIssue[] = []
  const positioning = String(backplane.positioning ?? '').trim()
  if (!positioning) {
    issues.push({
      dimension: 'F',
      severity: 'blocking',
      location: 'positioning',
      claim: 'PRD 缺少产品定位',
      evidence: ['positioning 为空'],
      plain_question: '这个产品主要是给谁用、帮他们解决什么问题？',
      options: ruleOptions([
        { id: 'tell', label: '我来说明', description: '补充用途和人群' },
        { id: 'guide', label: '你来定', description: '按常见做法补上' },
      ]),
    })
  }
  const requirements = backplane.requirements ?? []
  if (requirements.length === 0) {
    issues.push({
      dimension: 'F',
      severity: 'blocking',
      location: 'requirements',
      claim: 'PRD 没有任何功能项',
      evidence: ['requirements 为空数组'],
      plain_question: '这个产品具体要能做什么，还不太清楚。',
      options: ruleOptions([
        { id: 'tell', label: '我来说明', description: '补充具体功能' },
        { id: 'guide', label: '你来定', description: '按常见做法补上' },
      ]),
    })
  }
  const seen = new Map<string, string>()
  for (const item of requirements) {
    const description = String(item.description ?? '').trim()
    if (description.length < 4) {
      issues.push({
        dimension: 'U',
        severity: 'major',
        location: item.id,
        claim: `功能项「${item.id}」描述过短，无法理解要做什么`,
        evidence: [description || '（空）'],
        plain_question: `「${description || item.id}」这个功能说得太简单，能不能再说具体一点？`,
        options: ruleOptions([
          { id: 'tell', label: '我来说明', description: '补充具体怎么做' },
          { id: 'guide', label: '你来定', description: '按常见做法补上' },
        ]),
      })
    }
    const duplicated = seen.get(description)
    if (duplicated && description.length >= 4) {
      issues.push({
        dimension: 'I',
        severity: 'major',
        location: item.id,
        claim: `与 ${duplicated} 描述完全相同，疑似重复项`,
        evidence: [description],
        plain_question: `有两个功能看起来一样，是不是重复了？`,
        options: ruleOptions([
          { id: 'dedupe', label: '就保留一个', description: '去掉重复的' },
          { id: 'tell', label: '其实是两个', description: '我来说明区别' },
        ]),
      })
    } else {
      seen.set(description, item.id)
    }
  }
  return { verdict: deriveVerdict(issues), issues, mode: 'rules' }
}

/** 规则门选项兜底：每条保证有非空选项（通用出口）。 */
function ruleOptions(options: PrdReviewOption[]): PrdReviewOption[] {
  return sanitizeReviewOptions(options)
}

// =========================================================================
// 审查未过 → 决策卡与回传
// =========================================================================

/** 逐题选择题的单题结构（2026-08-30：审查问题选择题化）。 */
export interface ReviewQuestion {
  id: string
  /** 零基础大白话问题（plain_question，缺省回退 claim） */
  question: string
  options: PrdReviewOption[]
}

/**
 * 把 blocking/major issue 转成逐题选择题结构：每题选项重新编号为 `qN:...`，
 * 并保证每题必有「这条没问题」兜底出口（不依赖模型输出）。
 */
export function buildReviewQuestions(issues: PrdReviewIssue[]): ReviewQuestion[] {
  return issues.map((issue, index) => {
    const id = `q${index}`
    const options = (issue.options ?? []).map((option, optionIndex) => ({
      ...option,
      id: `${id}:${option.id || `opt-${optionIndex}`}`,
    }))
    const hasIgnore = options.some(
      (option) => option.id.endsWith(':ignore') || /没问题|不改|忽略/.test(option.label),
    )
    if (!hasIgnore) {
      options.push({
        id: `${id}:ignore`,
        label: REVIEW_OPTION_IGNORE.label,
        description: REVIEW_OPTION_IGNORE.description,
      })
    }
    return { id, question: issue.plain_question?.trim() || issue.claim, options }
  })
}

/** 审查未过：记录 pending + 决策日志 + 发逐题选择题决策卡。 */
export function publishPrdReviewCard(opts: {
  input: { request_id: string; session_id: string; project_id: string; mode: AgentSendMessageInput['mode']; channel_id?: string }
  requirements: Array<{ id: string; description: string }>
  issues: PrdReviewIssue[]
  outcome: PrdReviewOutcome
  backplane: PrdBackplane
  query: SDKQuery
  publish: (event: AgentEvent) => void
}): void {
  const { input, requirements, issues, outcome } = opts
  const serious = issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')

  pendingPrdReviews.set(input.project_id, {
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    requirements,
    issues,
    backplane: opts.backplane,
    query: opts.query,
    publish: opts.publish,
  })

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'prd_review',
      title: '裁判 PRD 审查未过（简化版 AC）',
      why: `六维攻击审查发现 ${serious.length} 个 blocking/major 问题，退用户决策`,
      detail: {
        simplified_ac: true,
        mode: outcome.mode,
        via: outcome.via ?? 'direct',
        degraded: outcome.degraded ?? false,
        issues,
      },
    },
  })

  // 用户可见卡片：问题摘要说人话（零基础，P0 文案规范），最多列 3 条
  const summary = serious
    .slice(0, 3)
    .map((issue) => `「${issue.plain_question?.trim() || issue.claim}」`)
    .join('；')
  opts.publish({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type: 'user_decision_required',
    payload: {
      kind: 'prd_review',
      title: '裁判发现几个地方需要你确认',
      summary,
      // 逐题选择题（2026-08-30）：每题问题 + 一组可点选项（含「这条没问题」兑底）
      review_questions: buildReviewQuestions(serious),
      // 全局出口：不想逐题作答时一次性把决定权交给向导
      global_options: [
        { id: PRD_REVIEW_OPTION_DELEGATE_ALL, label: '全部交给向导决定', description: '按常见做法统一改' },
      ],
      // 保留原 issues（内部裁决/降级兼容，前端不回退到旧两按钮时仅作追溯）
      issues: serious.map((issue) => ({
        dimension: issue.dimension,
        severity: issue.severity,
        claim: issue.claim,
        plain_question: issue.plain_question,
      })),
    },
    created_at: new Date().toISOString(),
  } as AgentEvent)
}

/**
 * 识别 PRD 审查决策卡的回传（在引导路径 resolveCardAnswer 之前调用）。
 * 仅当存在 pending 审查且 selected_option_id 是本卡选项时返回决策，其余 undefined 放行。
 */
export function resolvePrdReviewCardAnswer(
  input: AgentSendMessageInput,
): 'override' | 'supplement' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (optionId !== PRD_REVIEW_OPTION_OVERRIDE && optionId !== PRD_REVIEW_OPTION_SUPPLEMENT) {
    return undefined
  }
  // pending 校验：无 pending（重启丢失/重复点击）时不拦截，交回常规路径
  if (!hasPendingPrdReview(input.project_id)) return undefined
  return optionId === PRD_REVIEW_OPTION_OVERRIDE ? 'override' : 'supplement'
}

/** 用户选择忽略（或全部交给向导决定）：忽略审查问题≠确认过 PRD——「不过目不开工」（2026-08-27 用户拍板），
 * 转发 PRD 确认门把背板四段式摊给用户过目，确认后才开草图；决策日志留痕。
 * @param note 可选：区分「全部忽略」与「全部交给向导决定」的 reviewNote 文案（缺省按忽略处理）。 */
export async function resumePrdReviewOverride(input: AgentSendMessageInput, note?: { logTitle?: string; logWhy?: string; reviewNote?: string }): Promise<boolean> {
  const pending = takePendingPrdReview(input.project_id)
  if (!pending) return false
  const serious = pending.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_review_overridden',
      title: note?.logTitle ?? '用户忽略裁判问题，转入 PRD 过目',
      why: note?.logWhy ?? '用户在 PRD 审查决策卡选择「忽略问题，继续生成」；忽略审查问题不等于确认过 PRD，转入确认门过目后开工',
      detail: {
        ignored_issues: serious.map((issue) => issue.claim),
      },
    },
  })
  const ack = note
    ? '好的，已按你的选择处理审查发现的问题。这是按你的需求整理的 PRD，请你过目，确认无误后我再开始画草图。'
    : '好的，已按你的选择忽略审查发现的问题。这是按你的需求整理的 PRD，请你过目，确认无误后我再开始画草图。'
  pending.publish(makeReviewEvent(pending, 'message_delta', { text: ack }))
  pending.publish(makeReviewEvent(pending, 'message_completed', { subtype: 'success' }))
  publishPrdConfirmCard({
    input: {
      request_id: pending.request_id,
      session_id: pending.session_id,
      project_id: pending.project_id,
      mode: pending.mode,
      channel_id: pending.channel_id,
    },
    backplane: pending.backplane,
    requirements: pending.requirements,
    query: pending.query,
    publish: pending.publish,
    reviewNote: note?.reviewNote ?? `已忽略 ${serious.length} 个审查问题`,
  })
  return true
}

/** 用户选择补充：取走 pending（新确认弹窗会重建流程），返回待决信息供调用方发提示。 */
export function consumePrdReviewSupplement(input: AgentSendMessageInput): PendingPrdReview | undefined {
  const pending = takePendingPrdReview(input.project_id)
  if (!pending) return undefined
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_review_overridden',
      title: '用户选择补充说明，PRD 回修订',
      why: '用户在 PRD 审查决策卡选择「我来补充说明」',
      detail: {},
    },
  })
  return pending
}

/** 逐题选择题回传的判定结果（2026-08-30）。 */
export type PrdReviewAnswerDecision =
  | { kind: 'delegate_all' }
  | { kind: 'answers'; answers: Array<{ issue_id: string; option_id: string; label: string; ignored: boolean }> }

/**
 * 识别裁判审查逐题选择题的回传（在引导路径 resolveCardAnswer 之前调用）。
 * 仅当存在 pending 审查且回传是「全局让渡」或「逐题答案」时返回判定，其余 undefined 放行。
 * 逐题答案里每条按 option_id 的 `:ignore` 后缀 / 兜底文案判定是否「这条没问题」。
 */
export function resolvePrdReviewAnswers(input: AgentSendMessageInput): PrdReviewAnswerDecision | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  if (!hasPendingPrdReview(input.project_id)) return undefined
  if (input.metadata.selected_option_id === PRD_REVIEW_OPTION_DELEGATE_ALL) {
    return { kind: 'delegate_all' }
  }
  const answers = (input.metadata.review_answers ?? [])
    .filter((answer) => answer && typeof answer.issue_id === 'string' && typeof answer.option_id === 'string')
    .map((answer) => ({
      issue_id: answer.issue_id,
      option_id: answer.option_id,
      label: typeof answer.label === 'string' ? answer.label : '',
      ignored: answer.option_id.endsWith(':ignore') || /没问题|不改|忽略/.test(answer.label),
    }))
  if (answers.length === 0) return undefined
  return { kind: 'answers', answers }
}

function makeReviewEvent(
  pending: Pick<PendingPrdReview, 'session_id' | 'project_id'>,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: pending.session_id,
    project_id: pending.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

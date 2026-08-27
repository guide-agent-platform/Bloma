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
 * → needs_revision（退用户决策卡：忽略继续 / 我来补充）；否则 pass → 草图。
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

export interface PrdReviewIssue {
  dimension: PrdReviewDimension
  severity: 'blocking' | 'major' | 'minor' | 'suggestion'
  /** PRD 中的位置（功能项 id 或原句片段） */
  location: string
  claim: string
  evidence: string[]
}

export interface PrdReviewOutcome {
  verdict: 'pass' | 'needs_revision'
  issues: PrdReviewIssue[]
  /** llm = 六维攻击审查；rules = LLM 不可用后的确定性降级 */
  mode: 'llm' | 'rules'
  /** llm 路径执行方式：delegation = 委派子 agent（可视化）；direct = 平台直连 */
  via?: 'delegation' | 'direct'
  degraded?: boolean
}

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
  '{"issues":[{"dimension":"F","severity":"blocking","location":"F-001","claim":"问题描述","evidence":["PRD 原句或字段值"]}],',
  ' "clean_dimensions":["I","Z"]}',
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
  // ① 委派审查（默认，协作过程经 DelegationFeed 可视化）；解析失败/委派失败落直连
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
    })
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
    issues.push({
      dimension: dimension as PrdReviewDimension,
      severity: severity as PrdReviewIssue['severity'],
      location: typeof item.location === 'string' ? item.location.trim().slice(0, 80) : '',
      claim: claim.slice(0, 200),
      evidence: Array.isArray(item.evidence)
        ? item.evidence.filter((entry): entry is string => typeof entry === 'string').slice(0, 3)
        : [],
    })
  }
  return issues
}

/** 确定性规则门（LLM 不可用降级）：只拦硬伤，宁松勿严。 */
export function ruleGateReview(backplane: PrdBackplane): PrdReviewOutcome {
  const issues: PrdReviewIssue[] = []
  const positioning = String(backplane.positioning ?? '').trim()
  if (!positioning) {
    issues.push({ dimension: 'F', severity: 'blocking', location: 'positioning', claim: 'PRD 缺少产品定位', evidence: ['positioning 为空'] })
  }
  const requirements = backplane.requirements ?? []
  if (requirements.length === 0) {
    issues.push({ dimension: 'F', severity: 'blocking', location: 'requirements', claim: 'PRD 没有任何功能项', evidence: ['requirements 为空数组'] })
  }
  const seen = new Map<string, string>()
  for (const item of requirements) {
    const description = String(item.description ?? '').trim()
    if (description.length < 4) {
      issues.push({ dimension: 'U', severity: 'major', location: item.id, claim: `功能项「${item.id}」描述过短，无法理解要做什么`, evidence: [description || '（空）'] })
    }
    const duplicated = seen.get(description)
    if (duplicated && description.length >= 4) {
      issues.push({ dimension: 'I', severity: 'major', location: item.id, claim: `与 ${duplicated} 描述完全相同，疑似重复项`, evidence: [description] })
    } else {
      seen.set(description, item.id)
    }
  }
  return { verdict: deriveVerdict(issues), issues, mode: 'rules' }
}

// =========================================================================
// 审查未过 → 决策卡与回传
// =========================================================================

/** 审查未过：记录 pending + 决策日志 + 发决策卡（忽略继续 / 我来补充说明）。 */
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

  // 用户可见卡片：问题摘要说人话（P0 文案规范：无技术黑话），最多列 3 条
  const summary = serious
    .slice(0, 3)
    .map((issue) => `「${issue.claim}」`)
    .join('；')
  opts.publish({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type: 'user_decision_required',
    payload: {
      kind: 'prd_review',
      title: '裁判发现问题，需要你定夺',
      questions: [
        {
          id: PRD_REVIEW_OPTION_OVERRIDE,
          label: '忽略问题，继续生成',
          description: '按现在的需求过目 PRD 后再开工',
        },
        {
          id: PRD_REVIEW_OPTION_SUPPLEMENT,
          label: '我来补充说明',
          description: '向导会根据你的补充修订需求',
        },
      ],
      issues: serious.map((issue) => ({
        dimension: issue.dimension,
        severity: issue.severity,
        claim: issue.claim,
      })),
      summary,
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

/** 用户选择忽略：忽略审查问题≠确认过 PRD——「不过目不开工」（2026-08-27 用户拍板），
 * 转发 PRD 确认门把背板四段式摊给用户过目，确认后才开草图；决策日志留痕。 */
export async function resumePrdReviewOverride(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingPrdReview(input.project_id)
  if (!pending) return false
  const serious = pending.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_review_overridden',
      title: '用户忽略裁判问题，转入 PRD 过目',
      why: `用户在 PRD 审查决策卡选择「忽略问题，继续生成」；忽略审查问题不等于确认过 PRD，转入确认门过目后开工`,
      detail: {
        ignored_issues: serious.map((issue) => issue.claim),
      },
    },
  })
  const ack = `好的，已按你的选择忽略审查发现的问题。这是按你的需求整理的 PRD，请你过目，确认无误后我再开始画草图。`
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
    reviewNote: `已忽略 ${serious.length} 个审查问题`,
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

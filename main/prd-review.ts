/**
 * PRD 内审门（prd-review）——AC-Lite 攻击→修订→复核闭环，2026-09-01。
 *
 * 方法论来源：用户指定 skill「ac-audit」（对抗-收敛文档审计）；2026-08-26 首落地
 * 为单轮简化版（simplified_ac）；2026-08-30 组会决议 1/4 升级为内审闭环：
 *
 * - Attacker（攻击者）：六维攻击面 I-F-Z-U-L-G，task 携带用户对话原文摘录
 *   （F 维对照源，2026-09-01 补齐）+ read_conversation_history 工具；
 * - Defender（修订者，新增）：按铁律修订背板草稿（prd-defender，代码级校验）；
 * - 复核轮（Attacker 变体）：只验旧 issue 是否消除 + 有无新伤，不全量重扫；
 * - 裁决（代码，不信任模型自报）：deriveVerdict 口径不变，收敛判定只认复核轮输出。
 *
 * 轮次预算：quick 1 轮修复 / longterm 2 轮；超预算 → 用户知情决策卡（残留
 * blocking/major + Defender 已改什么）。降级链：委派内审（默认）→ 直连 →
 * 规则门；aborted（用户停止）永不降级、立即终止管线。
 * 修订稿重走用户过目门：user_confirmed_at 不继承（陷阱 19/42 口径）。
 */

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput } from '../shared/types'
import { recordDecision } from './decision-log'
import { publishPrdConfirmCard } from './prd-confirm'
import type { PrdBackplane } from './sketch-engine'
import type { SDKQuery } from './orchestrator'
import { delegatedReviewEnabled, runDelegatedReview } from './review-delegation'
import { buildConversationExcerpt, buildReadConversationHistoryTool } from './conversation-excerpt'
import {
  DEFENDER_SYSTEM_PROMPT,
  buildDefenderTask,
  buildWritePrdDraftTool,
  validateDefenderDraft,
  validateDispositionCoverage,
  type DefenderDisposition,
  type DefenderFailure,
} from './prd-defender'

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

/** 内审轮次元数据（decision-log 与卡面展示共用）。 */
export interface InternalAuditMeta {
  /** 内审总轮数（攻击轮 + 修订/复核轮） */
  rounds: number
  /** 复核轮后无 blocking/major 即收敛（quick 预算 1 / longterm 2） */
  converged: boolean
  /** Defender 修订稿（仅 converged 时存在；调用方应落盘 requirement_confirmed
   *  检查点并以此进确认卡——修订稿重走用户过目门，user_confirmed_at 不继承） */
  revisedBackplane?: PrdBackplane
  /** Defender 改动摘要（卡面展示：改了什么） */
  defenderSummary?: string
  /** 每条 issue 的处置（fixed/rejected + 说明） */
  dispositions?: DefenderDisposition[]
  /** 厂商隔离事实：audit 渠道与生成渠道 base_url host 是否不同（未配 audit 时缺省） */
  vendorIsolated?: boolean
  /** 内审执行方式 */
  via?: 'delegation' | 'direct'
  /** Defender 轮失败原因（未收敛路径留痕） */
  defenderFailure?: DefenderFailure | 'budget_exhausted'
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
  /** 内审闭环元数据（2026-09-01）：存在即走过攻击轮 */
  internalAudit?: InternalAuditMeta
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
  /** 内审元数据（2026-09-01）：卡面展示 Defender 已改什么/是否隔离 */
  internalAudit?: InternalAuditMeta
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

/** D1 开关（2026-09-01 待拍板口径，缺省关闭=维持现状 major 触发）：开启后 quick
 * 模式仅 blocking 触发 Defender 与退卡，major 记录不阻塞（卡面如实展示）。 */
export function internalAuditMajorGateEnabled(): boolean {
  return process.env.BLOMA_INTERNAL_AUDIT_MAJOR_GATE === '1'
}

/** 裁决口径：quick+D1 开关时只认 blocking，其余 blocking/major 都算严重。 */
function seriousIssues(issues: PrdReviewIssue[], mode?: AgentSendMessageInput['mode']): PrdReviewIssue[] {
  const blockingOnly = mode === 'quick' && internalAuditMajorGateEnabled()
  return issues.filter((issue) =>
    blockingOnly ? issue.severity === 'blocking' : issue.severity === 'blocking' || issue.severity === 'major',
  )
}

/** quick 1 轮 / longterm 2 轮（设计稿 §3.2 轮次预算）。 */
export function internalAuditBudget(mode?: AgentSendMessageInput['mode']): number {
  return mode === 'longterm' ? 2 : 1
}

const DEFENDER_DELEGATION_TIMEOUT_MS = 150_000
const DEFENDER_MAX_TURNS = 10
/** Defender 直连降级路径的输出 token 上限（背板全量 JSON 产出）。 */
const DEFENDER_DIRECT_MAX_TOKENS = 8192

// =========================================================================
// 审查执行
// =========================================================================

/** 六维攻击 system prompt（攻击轮）：六维攻击面 + PRD 权重 + 证据/严重度/禁编造铁律。 */
export const PRD_REVIEW_SYSTEM_PROMPT = [
  '你是文档攻击者（Attacker）——简化版 AC 对抗审计。目标：对给出的 PRD 执行六维攻击式审查，找出真实缺陷。',
  '',
  '【方法声明】对抗-收敛（AC）审计的简化运行。报告将标注 simplified_ac=true，不冒充完整方法论。',
  '判定边界速记：换名不矛盾（归 U）；「很难但有可能」只标 suggestion；需求文档不要求给实现方案。',
  '',
  '【六维攻击面】（括号为 PRD 权重，火力分配参考）',
  '- F 保真（30%）：PRD 是否忠实于【用户确认的需求清单】与【用户对话原文】——缺项、改偏、擅自加戏',
  '- U 可懂（20%）：歧义、一义多解、未定义术语',
  '- L 闭环（15%）：功能路径不闭环（如只有添加没有查看/删除）',
  '- G 护栏（15%）：无可客观度量的验收（「要快」「要好用」）、缺失边界情形',
  '- I 自洽（10%）：条目间相互矛盾',
  '- Z 可造（10%）：违反工程常识（「零延迟」「无限容量」）',
  '',
  '【规则】',
  '- 每个缺陷必须引用 PRD 原文证据（功能项 id 或原句）；F 维缺陷应引用用户原话对照',
  '- 严重度：blocking（无法开工/核心缺失）> major（会做错方向）> minor > suggestion',
  '- 不许提修复方案（只指出问题，修复是 Defender 的事）',
  '- 某维找不到缺陷 → 记入 clean_dimensions；不确定 → 同样记 clean，禁止编造',
  '- blocking/major 合计通常 0~3 个；把整份需求说得一无是处通常是过度攻击，不是严格',
  '',
  '【输出】严格 JSON，不要 markdown 围栏，不要任何多余文字：',
  '{"issues":[{"dimension":"F","severity":"blocking","location":"F-001","claim":"问题描述","evidence":["PRD 原句或用户原话"]}],',
  ' "clean_dimensions":["I","Z"]}',
].join('\n')

/** 复核轮 system prompt（2026-09-01）：只验旧 issue 是否消除 + 有无新伤，不全量重扫（控 token）。 */
export const PRD_REVIEW_RECHECK_SYSTEM_PROMPT = [
  '你是文档攻击者（Attacker）的复核轮——上一轮审查发现的 blocking/major 问题已经由修订者（Defender）处置，你只做两件事：',
  '1. 逐条验证旧 issue 是否真的消除（对照修订后 PRD 原文，不许凭处置说明自报消除了事）；',
  '2. 检查修订本身是否引入新缺陷（新伤：改坏了原本没问题的部分、新增项与已有项矛盾等）。',
  '',
  '【边界】',
  '- 只报「未消除的旧 issue」与「新引入的缺陷」；旧 issue 已消除且无新伤 → issues 为空数组',
  '- 修订说明里声称改了但 PRD 原文对不上的，按未消除报（不信任自报）',
  '- 不重扫六维全量（首攻轮已扫过；只盯增量）',
  '- 严重度口径与首攻轮一致；新伤用 severity 标注，claim 里注明「（修订引入）」',
  '',
  '【输出】严格 JSON，不要 markdown 围栏：',
  '{"issues":[{"dimension":"L","severity":"major","location":"F-003","claim":"（修订引入）…","evidence":["修订后 PRD 原句"]}],',
  ' "clean_dimensions":[]}',
].join('\n')

/** 内审执行选项（runPrdReviewGate 主入口）。 */
export interface InternalAuditOptions {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  query: SDKQuery
  env: Record<string, string> | undefined
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
  /** 委派可视化：三者齐备时优先走委派子 agent，否则直连 */
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
  /** 2026-09 内审闭环：轮次预算（quick 1 / longterm 2）与 D1 开关联动 */
  mode?: AgentSendMessageInput['mode']
  /** 厂商隔离事实（调用方解析后传入；如实展示，不冒充） */
  vendorIsolated?: boolean
}

/**
 * PRD 内审门主入口（AC-Lite）：攻击 →（有 blocking/major 且预算内）修订 → 复核循环，
 * 收敛判定只认复核轮输出；LLM 不可用或全链失败 → 确定性规则门降级。永不抛错
 * （门禁增强不是硬依赖）；aborted（用户停止）永不降级、立即返回。
 */
export async function runPrdReviewGate(opts: InternalAuditOptions): Promise<PrdReviewOutcome> {
  const { backplane, confirmedRequirements, query, env, sessionId, signal } = opts
  if (!env) {
    // 无可用渠道 env：直接规则门（不算 degraded——渠道不可用的如实降级）
    return ruleGateReview(backplane)
  }
  const abortWith = (via: 'delegation' | 'direct'): PrdReviewOutcome => ({
    verdict: 'pass',
    issues: [],
    mode: 'llm',
    via,
    aborted: true,
  })

  // ---- 攻击轮（Attacker）：对话摘录进 task + read_conversation_history 工具 ----
  const conversationExcerpt = safeBuildExcerpt(sessionId)
  const historyTool = buildReadConversationHistoryTool(sessionId)
  const attack = await runAttackerRound({ ...opts, conversationExcerpt, historyTool, round: 1 })
  if (attack.aborted) return abortWith(attack.via)
  if (!attack.ok) {
    // 委派+直连双失败 → 规则门（现状降级链末环）
    return { ...ruleGateReview(backplane), degraded: true }
  }
  const firstSerious = seriousIssues(attack.issues, opts.mode)
  if (firstSerious.length === 0) {
    const outcome: PrdReviewOutcome = {
      verdict: 'pass',
      issues: attack.issues,
      mode: 'llm',
      via: attack.via,
      internalAudit: { rounds: 1, converged: true, via: attack.via, vendorIsolated: opts.vendorIsolated },
    }
    if (opts.projectId) recordInternalAuditDecision(opts, outcome)
    return outcome
  }

  // ---- 修订-复核循环（Defender → 复核；预算 quick 1 / longterm 2）----
  const budget = internalAuditBudget(opts.mode)
  let currentIssues = attack.issues
  let currentBackplane = backplane
  let dispositions: DefenderDisposition[] = []
  let defenderSummary: string | undefined
  let defenderFailure: InternalAuditMeta['defenderFailure']
  let rounds = 1
  let lastVia: 'delegation' | 'direct' = attack.via

  for (let round = 1; round <= budget; round++) {
    if (signal?.aborted) return abortWith(lastVia)
    rounds = round + 1
    const serious = seriousIssues(currentIssues, opts.mode)
    // Defender 修订轮
    const defender = await runDefenderRound({
      backplane: currentBackplane,
      issues: currentIssues,
      confirmedRequirements,
      conversationExcerpt,
      query,
      env,
      sessionId,
      signal,
      projectId: opts.projectId,
      requestId: opts.requestId,
      publish: opts.publish,
    })
    if (defender.aborted) return abortWith(lastVia)
    if (!defender.ok) {
      defenderFailure = defender.failure
      break // Defender 失败/违规：视为未收敛 → 用户知情卡（不静默丢弃 issues）
    }
    currentBackplane = defender.draft!.backplane
    dispositions = defender.draft!.dispositions
    defenderSummary = defender.summary
    lastVia = 'delegation'

    if (signal?.aborted) return abortWith(lastVia)
    // 复核轮（增量：只验旧 issue 消除 + 新伤）
    const recheck = await runAttackerRound({
      ...opts,
      backplane: currentBackplane,
      conversationExcerpt,
      historyTool,
      round: round + 1,
      previousIssues: serious,
      dispositions,
    })
    if (recheck.aborted) return abortWith(recheck.via)
    if (!recheck.ok) {
      // 复核不可执行：如实按未收敛处理（绝不把「没复核」当「复核通过」）
      defenderFailure = 'budget_exhausted'
      break
    }
    lastVia = recheck.via
    currentIssues = recheck.issues
    const remainingSerious = seriousIssues(currentIssues, opts.mode)
    if (remainingSerious.length === 0) {
      const outcome: PrdReviewOutcome = {
        verdict: 'pass',
        issues: currentIssues,
        mode: 'llm',
        via: recheck.via,
        internalAudit: {
          rounds,
          converged: true,
          revisedBackplane: currentBackplane,
          defenderSummary,
          dispositions,
          vendorIsolated: opts.vendorIsolated,
          via: recheck.via,
        },
      }
      if (opts.projectId) recordInternalAuditDecision(opts, outcome)
      return outcome
    }
    // 预算内还有轮次 → 带着复核残留 issues 进下一轮 Defender
  }

  // ---- 超预算/Defender 失败：未收敛 → 用户知情决策卡（残留 blocking/major） ----
  const outcome: PrdReviewOutcome = {
    verdict: 'needs_revision',
    issues: currentIssues,
    mode: 'llm',
    via: lastVia,
    internalAudit: {
      rounds,
      converged: false,
      ...(defenderSummary ? { defenderSummary } : {}),
      ...(dispositions.length ? { dispositions } : {}),
      defenderFailure: defenderFailure ?? 'budget_exhausted',
      vendorIsolated: opts.vendorIsolated,
      via: lastVia,
    },
  }
  if (opts.projectId) recordInternalAuditDecision(opts, outcome)
  return outcome
}

/** 对话摘录安全构建（会话文件缺失/异常不阻断内审）。 */
function safeBuildExcerpt(sessionId: string): string {
  try {
    return buildConversationExcerpt(sessionId)
  } catch {
    return ''
  }
}

interface AttackerRoundResult {
  ok: boolean
  issues: PrdReviewIssue[]
  via: 'delegation' | 'direct'
  aborted?: boolean
}

/** 攻击/复核轮执行：委派优先（extraTools 带 read_conversation_history），失败降直连。 */
async function runAttackerRound(opts: {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  query: SDKQuery
  env: Record<string, string> | undefined
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
  conversationExcerpt: string
  historyTool: ReturnType<typeof buildReadConversationHistoryTool>
  round: number
  /** 复核轮：上轮 serious issues（增量验证基准） */
  previousIssues?: PrdReviewIssue[]
  dispositions?: DefenderDisposition[]
}): Promise<AttackerRoundResult> {
  const isRecheck = opts.round > 1
  const system = isRecheck ? PRD_REVIEW_RECHECK_SYSTEM_PROMPT : PRD_REVIEW_SYSTEM_PROMPT
  const goalPrefix = isRecheck ? '内审·复核 PRD' : '内审·攻击 PRD'
  const task = isRecheck
    ? buildRecheckTask(opts.backplane, opts.previousIssues ?? [], opts.dispositions ?? [], opts.conversationExcerpt)
    : buildPrdReviewTask(opts.backplane, opts.confirmedRequirements, opts.conversationExcerpt)

  // ① 委派（默认）：research 只读面 + read_conversation_history
  if (delegatedReviewEnabled() && opts.env && opts.projectId && opts.requestId && opts.publish) {
    const delegated = await runDelegatedReview({
      goal: `${goalPrefix}：${opts.backplane.name ?? '未命名项目'}`,
      task,
      system,
      query: opts.query,
      env: opts.env,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      requestId: opts.requestId,
      publish: opts.publish,
      signal: opts.signal,
      extraTools: [opts.historyTool],
    })
    if (delegated.failure === 'aborted') return { ok: false, issues: [], via: 'delegation', aborted: true }
    if (delegated.ok && delegated.finalText) {
      try {
        const issues = parseReviewIssues(delegated.finalText)
        return { ok: true, issues, via: 'delegation' }
      } catch {
        console.error('[prd-review] 委派审查输出不可解析，回退直连')
      }
    }
  }
  // ② 直连单次请求
  try {
    if (!opts.env) return { ok: false, issues: [], via: 'direct' }
    const issues = await attackViaLlm({
      backplane: opts.backplane,
      confirmedRequirements: opts.confirmedRequirements,
      conversationExcerpt: opts.conversationExcerpt,
      isRecheck,
      previousIssues: opts.previousIssues,
      dispositions: opts.dispositions,
      query: opts.query,
      env: opts.env,
      sessionId: opts.sessionId,
      signal: opts.signal,
      maxTokens: opts.maxTokens,
    })
    return { ok: true, issues, via: 'direct' }
  } catch (error) {
    // 用户停止（abort 抛 AbortError）：不降级（降级会继续往下跑卡片/草图）
    if (opts.signal?.aborted) return { ok: false, issues: [], via: 'direct', aborted: true }
    console.error('[prd-review] LLM 审查失败:', error)
    return { ok: false, issues: [], via: 'direct' }
  }
}

/** 代码级裁决：blocking/major 存在即 needs_revision（不信任模型自报的宽松结论）。 */
function deriveVerdict(issues: PrdReviewIssue[]): 'pass' | 'needs_revision' {
  return issues.some((issue) => issue.severity === 'blocking' || issue.severity === 'major')
    ? 'needs_revision'
    : 'pass'
}

/** 攻击轮任务体（委派与直连共用）：PRD 全文 + 用户确认清单 + 对话原文 + 输出指令。 */
function buildPrdReviewTask(
  backplane: PrdBackplane,
  confirmedRequirements: Array<{ id: string; description: string }>,
  conversationExcerpt?: string,
): string {
  const lines = [
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
      : '- （无已确认清单，F 维度以用户对话原文为对照基准）',
  ]
  if (conversationExcerpt) {
    lines.push('', conversationExcerpt, '', '可用 read_conversation_history 工具查阅完整对话原文（F 维度证据可引用用户原话）。')
  }
  lines.push('', '现在执行六维攻击审查，按【输出】格式给出 JSON。')
  return lines.join('\n')
}

/** 复核任务体：修订后背板 + 旧 issues + Defender 处置说明。 */
function buildRecheckTask(
  backplane: PrdBackplane,
  previousIssues: PrdReviewIssue[],
  dispositions: DefenderDisposition[],
  conversationExcerpt?: string,
): string {
  const serious = previousIssues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  const lines = [
    '【修订后 PRD 全文（背板 JSON）】',
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
    '【上轮 blocking/major 问题（逐条验证是否消除，序号即 issue_index）】',
    serious.length
      ? serious
          .map((issue, index) => `${index + 1}. [${issue.dimension}/${issue.severity}] ${issue.claim}（位置：${issue.location || '未标注'}）`)
          .join('\n')
      : '- （无）',
    '',
    '【修订者处置说明（不信任自报，须对照 PRD 原文验证）】',
    dispositions.length
      ? dispositions.map((item) => `${item.issue_index}. ${item.action === 'fixed' ? '已修' : '拒改'}：${item.note}`).join('\n')
      : '- （无）',
  ]
  if (conversationExcerpt) lines.push('', conversationExcerpt)
  lines.push('', '现在执行复核：逐条验证旧 issue 是否消除 + 检查修订是否引入新缺陷，按【输出】格式给出 JSON。')
  return lines.join('\n')
}

/** LLM 攻击/复核轮（直连）：内联 PRD 全文 + 对照基准（F 维的对照源）。 */
async function attackViaLlm(opts: {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  conversationExcerpt?: string
  isRecheck?: boolean
  previousIssues?: PrdReviewIssue[]
  dispositions?: DefenderDisposition[]
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
}): Promise<PrdReviewIssue[]> {
  const system = opts.isRecheck ? PRD_REVIEW_RECHECK_SYSTEM_PROMPT : PRD_REVIEW_SYSTEM_PROMPT
  const task = opts.isRecheck
    ? buildRecheckTask(opts.backplane, opts.previousIssues ?? [], opts.dispositions ?? [], opts.conversationExcerpt)
    : buildPrdReviewTask(opts.backplane, opts.confirmedRequirements, opts.conversationExcerpt)
  const prompt = [system, '', task].join('\n')

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

// =========================================================================
// Defender 轮执行（委派优先 → 直连降级；产物代码级校验）
// =========================================================================

interface DefenderRoundResult {
  ok: boolean
  draft?: { backplane: PrdBackplane; dispositions: DefenderDisposition[] }
  summary?: string
  failure?: DefenderFailure
  aborted?: boolean
}

async function runDefenderRound(opts: {
  backplane: PrdBackplane
  issues: PrdReviewIssue[]
  confirmedRequirements: Array<{ id: string; description: string }>
  conversationExcerpt?: string
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  signal?: AbortSignal
  projectId?: string
  requestId?: string
  publish?: (event: AgentEvent) => void
}): Promise<DefenderRoundResult> {
  const serious = opts.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  let submitted: { backplane: unknown; dispositions: DefenderDisposition[] } | undefined
  const writeTool = buildWritePrdDraftTool((draft) => {
    submitted = { backplane: draft.backplane, dispositions: draft.dispositions }
  })
  const task = buildDefenderTask({
    backplane: opts.backplane,
    issues: opts.issues,
    confirmedRequirements: opts.confirmedRequirements,
    conversationExcerpt: opts.conversationExcerpt,
  })
  const goal = `内审·修订 PRD：${opts.backplane.name ?? '未命名项目'}`

  // ① 委派（默认）：research 只读面 + read_conversation_history + write_prd_draft
  if (delegatedReviewEnabled() && opts.projectId && opts.requestId && opts.publish) {
    const delegated = await runDelegatedReview({
      goal,
      task,
      system: DEFENDER_SYSTEM_PROMPT,
      query: opts.query,
      env: opts.env,
      sessionId: opts.sessionId,
      projectId: opts.projectId,
      requestId: opts.requestId,
      publish: opts.publish,
      signal: opts.signal,
      timeoutMs: DEFENDER_DELEGATION_TIMEOUT_MS,
      maxTurns: DEFENDER_MAX_TURNS,
      extraTools: [buildReadConversationHistoryTool(opts.sessionId), writeTool.tool],
    })
    if (delegated.failure === 'aborted') return { ok: false, aborted: true }
    if (delegated.ok && submitted) {
      return settleDefenderDraft(opts.backplane, submitted.backplane, submitted.dispositions, serious)
    }
    if (delegated.ok && !submitted) {
      return { ok: false, failure: 'no_draft' }
    }
    console.error('[prd-review] Defender 委派失败，尝试直连降级:', delegated.failure)
  }

  // ② 直连降级：一次请求产出 {backplane, dispositions} JSON
  try {
    const raw = await defenderViaLlm(opts, task)
    return settleDefenderDraft(opts.backplane, raw.backplane, parseDispositionsLoose(raw.dispositions), serious)
  } catch (error) {
    if (opts.signal?.aborted) return { ok: false, aborted: true }
    console.error('[prd-review] Defender 直连修订失败:', error)
    return { ok: false, failure: 'delegation_failed' }
  }
}

/** Defender 产物统一校验收口：schema + 锚点 + id 白名单 + 处置覆盖。 */
function settleDefenderDraft(
  original: PrdBackplane,
  rawBackplane: unknown,
  dispositions: DefenderDisposition[],
  serious: PrdReviewIssue[],
): DefenderRoundResult {
  const validated = validateDefenderDraft(original, rawBackplane)
  if (!validated.ok) {
    console.error('[prd-review] Defender 修订稿违规拒收:', validated.violations)
    return { ok: false, failure: 'invalid' }
  }
  const coverage = validateDispositionCoverage(dispositions, serious)
  if (!coverage.ok) {
    console.error('[prd-review] Defender 处置不完整:', coverage.violations)
    return { ok: false, failure: 'invalid' }
  }
  const summary = buildDefenderSummary(validated.draft.backplane, dispositions)
  return { ok: true, draft: { backplane: validated.draft.backplane, dispositions }, summary }
}

/** Defender 改动摘要（卡面/决策日志用，人话）。 */
function buildDefenderSummary(backplane: PrdBackplane, dispositions: DefenderDisposition[]): string {
  const fixed = dispositions.filter((item) => item.action === 'fixed')
  const rejected = dispositions.filter((item) => item.action === 'rejected')
  const parts: string[] = []
  if (fixed.length > 0) {
    const notes = fixed
      .slice(0, 3)
      .map((item) => item.note.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    parts.push(`修复 ${fixed.length} 项${notes.length ? `（${notes.join('；')}）` : ''}`)
  }
  if (rejected.length > 0) parts.push(`拒改 ${rejected.length} 项（留复核仲裁）`)
  const itemNames = backplane.requirements.map((item) => item.id)
  return [...parts, `功能项 ${itemNames.join('、')}`].join('；')
}

/** 直连 Defender：一次请求产出结构化 JSON。 */
async function defenderViaLlm(
  opts: { query: SDKQuery; env: Record<string, string>; sessionId: string; signal?: AbortSignal },
  task: string,
): Promise<{ backplane: unknown; dispositions: unknown }> {
  const prompt = [
    DEFENDER_SYSTEM_PROMPT,
    '',
    task,
    '',
    '【直连模式】无工具可用：不要调用 write_prd_draft，直接在回复末尾输出严格 JSON（无围栏）：',
    '{"backplane":{...修订后完整背板...},"dispositions":[{"issue_index":1,"action":"fixed","note":"..."}]}',
  ].join('\n')
  const texts: string[] = []
  for await (const message of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal ?? new AbortController().signal,
    sessionId: opts.sessionId,
    maxTokens: DEFENDER_DIRECT_MAX_TOKENS,
    temperature: 0.1,
  })) {
    if (message.type !== 'assistant' || !message.message) continue
    for (const block of message.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  const cleaned = texts.join('').replace(/```(?:json)?/gi, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('DEFENDER_PARSE_FAILED: 输出中无 JSON 对象')
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { backplane?: unknown; dispositions?: unknown }
  if (!parsed.backplane) throw new Error('DEFENDER_PARSE_FAILED: 缺 backplane')
  return { backplane: parsed.backplane, dispositions: parsed.dispositions }
}

function parseDispositionsLoose(raw: unknown): DefenderDisposition[] {
  if (!Array.isArray(raw)) return []
  const out: DefenderDisposition[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const action = record.action === 'fixed' || record.action === 'rejected' ? record.action : undefined
    const index = Number(record.issue_index)
    if (!action || !Number.isFinite(index)) continue
    out.push({ issue_index: index, action, note: String(record.note ?? '').slice(0, 160) })
  }
  return out
}

/** 内审决策日志（设计稿 §3.3：轮次/issue 数/处置摘要/复核结论/厂商隔离）。 */
function recordInternalAuditDecision(opts: InternalAuditOptions, outcome: PrdReviewOutcome): void {
  if (!opts.projectId) return
  const audit = outcome.internalAudit
  if (!audit) return
  try {
    recordDecision({
      project_id: opts.projectId,
      session_id: opts.sessionId,
      entry: {
        type: 'internal_audit',
        title: audit.converged
          ? `PRD 内审收敛（${audit.rounds} 轮${audit.revisedBackplane ? '，含修订' : ''}）`
          : `PRD 内审未收敛（残留 ${seriousIssues(outcome.issues, opts.mode).length} 个 blocking/major）`,
        why: audit.converged
          ? audit.revisedBackplane
            ? `攻击轮发现问题后 Defender 修订、复核轮验证通过；${audit.defenderSummary ?? ''}`
            : '攻击轮未发现 blocking/major 问题，直接通过'
          : `轮次预算用尽或 Defender 失败（${audit.defenderFailure ?? 'unknown'}），残留问题退用户知情决策`,
        detail: {
          simplified_ac: true,
          rounds: audit.rounds,
          converged: audit.converged,
          issue_count: outcome.issues.length,
          serious_count: seriousIssues(outcome.issues, opts.mode).length,
          ...(audit.defenderSummary ? { defender_summary: audit.defenderSummary } : {}),
          ...(audit.dispositions?.length ? { dispositions: audit.dispositions } : {}),
          ...(audit.defenderFailure ? { defender_failure: audit.defenderFailure } : {}),
          vendor_isolated: audit.vendorIsolated,
          via: audit.via,
        },
      },
    })
  } catch (error) {
    console.warn('[prd-review] internal_audit 决策日志写入失败:', error)
  }
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
  const audit = outcome.internalAudit

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
    internalAudit: audit,
  })

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'prd_review',
      title: 'PRD 内审未收敛，退用户定夺',
      why: `内审 ${audit?.rounds ?? 1} 轮后仍有 ${serious.length} 个 blocking/major 问题，残留问题退用户知情决策`,
      detail: {
        simplified_ac: true,
        mode: outcome.mode,
        via: outcome.via ?? 'direct',
        degraded: outcome.degraded ?? false,
        ...(audit ? { internal_audit: { rounds: audit.rounds, converged: audit.converged, vendor_isolated: audit.vendorIsolated } } : {}),
        issues,
      },
    },
  })

  // 用户可见卡片：问题摘要说人话（P0 文案规范：无技术黑话），最多列 3 条；
  // 内审后如实展示 Defender 已改什么 + 是否厂商隔离（降级要如实，不冒充）
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
      title: '内审后仍有问题，需要你定夺',
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
      ...(audit?.defenderSummary ? { defender_summary: audit.defenderSummary } : {}),
      ...(audit?.vendorIsolated === false ? { vendor_isolated: false } : {}),
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
      title: '用户忽略内审残留问题，转入 PRD 过目',
      why: `用户在 PRD 审查决策卡选择「忽略问题，继续生成」；忽略审查问题不等于确认过 PRD，转入确认门过目后开工`,
      detail: {
        ignored_issues: serious.map((issue) => issue.claim),
      },
    },
  })
  const ack = `好的，已按你的选择忽略内审发现的残留问题。这是按你的需求整理的 PRD，请你过目，确认无误后我再开始画草图。`
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
    reviewNote: `已忽略 ${serious.length} 个内审残留问题`,
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

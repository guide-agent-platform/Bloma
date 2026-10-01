/**
 * 对抗审查门（PR4d 拆出）：runPrdReviewGate 主链、Attacker/Defender 轮次、裁决派生、决策落档。
 * 纯机械搬移；对外契约经 prd-review re-export 保持不变。
 */
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
import type { AgentEvent, AgentSendMessageInput } from '../../../shared/types'
import { recordDecision } from '../../project/decision-log'
import { publishPrdConfirmCard } from '../../guide/prd-confirm'
import type { PrdBackplane } from '../../coding/sketch-engine'
import { defaultConstraintLevel } from '../../coding/sketch-engine'
import { checkSectionCompleteness } from '../../guide/prd-sections'
import { parseEarsAssertion, renderForbiddenTermsForPrompt } from '../../guide/ears-vocabulary'
import type { SDKQuery } from '../../orchestration/orchestrator'
import { runDelegatedReview } from '../review-delegation'
import { buildConversationExcerpt, buildReadConversationHistoryTool } from '../../agent/loop/conversation-excerpt'
import {
  DEFENDER_SYSTEM_PROMPT,
  buildDefenderTask,
  buildWritePrdDraftTool,
  validateDefenderDraft,
  validateDispositionCoverage,
  type DefenderDisposition,
  type DefenderFailure,
} from '../prd-defender'

// =========================================================================
// 类型
// =========================================================================

import { DEFENDER_DELEGATION_TIMEOUT_MS, DEFENDER_DIRECT_MAX_TOKENS, DEFENDER_MAX_TURNS, InternalAuditMeta, PrdReviewIssue, PrdReviewOutcome, internalAuditBudget, seriousIssues } from './prd-review-contracts'
import { InternalAuditOptions, PRD_REVIEW_RECHECK_SYSTEM_PROMPT, PRD_REVIEW_SYSTEM_PROMPT, buildPrdReviewTask, buildRecheckTask } from './prd-review-prompts'
import { parseReviewIssues, ruleGateReview } from './prd-review-rules'

/**
 * PRD 内审门主入口（AC-Lite）：攻击 →（有 blocking/major 且预算内）修订 → 复核循环，
 * 收敛判定只认复核轮输出；LLM 不可用或全链失败 → 确定性规则门降级。永不抛错
 * （门禁增强不是硬依赖）；aborted（用户停止）永不降级、立即返回。
 */
export async function runPrdReviewGate(opts: InternalAuditOptions): Promise<PrdReviewOutcome> {
  const { backplane, confirmedRequirements, query, env, sessionId, signal } = opts
  if (!env) {
    // 无可用渠道 env：直接规则门（不算 degraded——渠道不可用的如实降级）
    return ruleGateReview(backplane, opts?.mode)
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
    return { ...ruleGateReview(backplane, opts?.mode), degraded: true }
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
      mode: opts.mode,
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
export function safeBuildExcerpt(sessionId: string): string {
  try {
    return buildConversationExcerpt(sessionId)
  } catch {
    return ''
  }
}

export interface AttackerRoundResult {
  ok: boolean
  issues: PrdReviewIssue[]
  via: 'delegation' | 'direct'
  aborted?: boolean
}

/** 攻击/复核轮执行：委派优先（extraTools 带 read_conversation_history），失败降直连。 */
export async function runAttackerRound(opts: {
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
  /** 注入点④：模式切片（quick 章节完备性 / longterm +EARS 可测性） */
  mode?: 'quick' | 'longterm'
}): Promise<AttackerRoundResult> {
  const isRecheck = opts.round > 1
  const system = isRecheck ? PRD_REVIEW_RECHECK_SYSTEM_PROMPT : PRD_REVIEW_SYSTEM_PROMPT
  const goalPrefix = isRecheck ? '内审·复核 PRD' : '内审·攻击 PRD'
  const task = isRecheck
    ? buildRecheckTask(opts.backplane, opts.previousIssues ?? [], opts.dispositions ?? [], opts.conversationExcerpt)
    : buildPrdReviewTask(opts.backplane, opts.confirmedRequirements, opts.conversationExcerpt, opts.mode)

  // ① 委派（默认）：research 只读面 + read_conversation_history
  if (opts.env && opts.projectId && opts.requestId && opts.publish) {
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
export function deriveVerdict(issues: PrdReviewIssue[]): 'pass' | 'needs_revision' {
  return issues.some((issue) => issue.severity === 'blocking' || issue.severity === 'major')
    ? 'needs_revision'
    : 'pass'
}

/** LLM 攻击/复核轮（直连）：内联 PRD 全文 + 对照基准（F 维的对照源）。 */
export async function attackViaLlm(opts: {
  backplane: PrdBackplane
  confirmedRequirements: Array<{ id: string; description: string }>
  conversationExcerpt?: string
  isRecheck?: boolean
  previousIssues?: PrdReviewIssue[]
  dispositions?: DefenderDisposition[]
  /** 注入点④：模式切片（quick 章节完备性 / longterm +EARS 可测性） */
  mode?: 'quick' | 'longterm'
  query: SDKQuery
  env: Record<string, string>
  sessionId: string
  signal?: AbortSignal
  maxTokens?: number
}): Promise<PrdReviewIssue[]> {
  const system = opts.isRecheck ? PRD_REVIEW_RECHECK_SYSTEM_PROMPT : PRD_REVIEW_SYSTEM_PROMPT
  const task = opts.isRecheck
    ? buildRecheckTask(opts.backplane, opts.previousIssues ?? [], opts.dispositions ?? [], opts.conversationExcerpt)
    : buildPrdReviewTask(opts.backplane, opts.confirmedRequirements, opts.conversationExcerpt, opts.mode)
  const prompt = [system, '', task].join('\n')

  const texts: string[] = []
  for await (const message of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal ?? new AbortController().signal,
    sessionId: opts.sessionId,
    maxTokens: opts.maxTokens ?? 640000,
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

export interface DefenderRoundResult {
  ok: boolean
  draft?: { backplane: PrdBackplane; dispositions: DefenderDisposition[] }
  summary?: string
  failure?: DefenderFailure
  aborted?: boolean
}

export async function runDefenderRound(opts: {
  backplane: PrdBackplane
  issues: PrdReviewIssue[]
  mode?: AgentSendMessageInput['mode']
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
  const serious = seriousIssues(opts.issues, opts.mode)
  let submitted: { backplane: unknown; dispositions: DefenderDisposition[] } | undefined
  const writeTool = buildWritePrdDraftTool((draft) => {
    submitted = { backplane: draft.backplane, dispositions: draft.dispositions }
  })
  const task = buildDefenderTask({
    backplane: opts.backplane,
    issues: opts.issues,
    seriousOverride: serious,
    confirmedRequirements: opts.confirmedRequirements,
    conversationExcerpt: opts.conversationExcerpt,
  })
  const goal = `内审·修订 PRD：${opts.backplane.name ?? '未命名项目'}`

  // ① 委派（默认）：research 只读面 + read_conversation_history + write_prd_draft
  if (opts.projectId && opts.requestId && opts.publish) {
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
export function settleDefenderDraft(
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
export function buildDefenderSummary(backplane: PrdBackplane, dispositions: DefenderDisposition[]): string {
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
export async function defenderViaLlm(
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

export function parseDispositionsLoose(raw: unknown): DefenderDisposition[] {
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
export function recordInternalAuditDecision(opts: InternalAuditOptions, outcome: PrdReviewOutcome): void {
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


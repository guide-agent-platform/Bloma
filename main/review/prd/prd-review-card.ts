/**
 * 审查卡片流（PR4d 拆出）：问题卡构建/发布、卡答案路由、override/supplement/答案合并。
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
import { syncDocuments } from '../../project/document-engine'
import { prdStructureIssues } from '../../model/requirements-model'
import { runPrdReviewGate } from './prd-review-gate'
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

import { PRD_REVIEW_CUSTOM_OPTION_ID, PRD_REVIEW_OPTION_DELEGATE_ALL, PRD_REVIEW_OPTION_OVERRIDE, PRD_REVIEW_OPTION_SUPPLEMENT, PendingPrdReview, PrdReviewIssue, PrdReviewOption, PrdReviewOutcome, REVIEW_OPTION_IGNORE, hasPendingPrdReview, pendingPrdReviews, takePendingPrdReview } from './prd-review-contracts'

/** 逐题选择题的单题结构（2026-08-30：审查问题选择题化）。 */
export interface ReviewQuestion {
  id: string
  /** 零基础大白话问题（plain_question，缺省回退 claim） */
  question: string
  options: PrdReviewOption[]
}

/**
 * 把 blocking/major issue 转成逐题选择题结构：每题选项重新编号为 `qN:...`，
 * 并保证每题必有「这条没问题」兑底出口（不依赖模型输出）。
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

/** 审查未过：记录 pending + 决策日志 + 发逐题选择题决策卡（内审元数据如实标注）。 */
export function publishPrdReviewCard(opts: {
  delegationExhausted?: boolean
  input: { request_id: string; session_id: string; project_id: string; mode: AgentSendMessageInput['mode']; channel_id?: string }
  requirements: Array<{ id: string; description: string }>
  issues: PrdReviewIssue[]
  outcome: PrdReviewOutcome
  backplane: PrdBackplane
  query: SDKQuery
  publish: (event: AgentEvent) => void
  /** 挂起时的生成 env：答案回流后 normalizer/PRD 重跑需复用（缺失走 fallback 污染 description） */
  env?: Record<string, string>
  /** 停止信号（m-6）：挂起方与确认卡回传后续链共享的可取消句柄 */
  signal?: AbortSignal
}): void {
  const { input, requirements, issues, outcome } = opts
  const serious = issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  const audit = outcome.internalAudit

  pendingPrdReviews.set(input.project_id, {
    delegationExhausted: opts.delegationExhausted,
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    env: opts.env,
    requirements,
    issues,
    backplane: opts.backplane,
    query: opts.query,
    publish: opts.publish,
    signal: opts.signal,
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

  // 用户可见卡片：逐题选择题（每题 plain_question + options + 兑底）；
  // 内审后如实展示 Defender 已改什么 + 是否厂商隔离（降级要如实，不冒充）
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
      title: '内审后有几个地方需要你确认',
      summary,
      // 逐题选择题（2026-08-30）：每题问题 + 一组可点选项（含「这条没问题」兑底）
      review_questions: buildReviewQuestions(serious),
      // 全局出口：不想逐题作答时一次性把决定权交给向导
      global_options: opts.delegationExhausted ? [] : [
        { id: PRD_REVIEW_OPTION_DELEGATE_ALL, label: '全部交给向导决定', description: '按常见做法统一改' },
      ],
      // 保留原 issues（内部裁决/降级兼容，前端不回退到旧两按钮时仅作追溯）
      issues: serious.map((issue) => ({
        dimension: issue.dimension,
        severity: issue.severity,
        claim: issue.claim,
        plain_question: issue.plain_question,
      })),
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

/** 用户选择忽略（或全部交给向导决定）：忽略审查问题≠确认过 PRD——「不过目不开工」（2026-08-27 用户拍板），
 * 转发 PRD 确认门把背板四段式摊给用户过目，确认后才开草图；决策日志留痕。
 * @param note 可选：区分「全部忽略」与「全部交给向导决定」的 reviewNote 文案（缺省按忽略处理）。 */
export async function resumePrdReviewOverride(input: AgentSendMessageInput, note?: { logTitle?: string; logWhy?: string; reviewNote?: string }): Promise<boolean> {
  if (note) return resumePrdReviewDelegated(input)
  const candidate = pendingPrdReviews.get(input.project_id)
  if (candidate && prdStructureIssues(candidate.backplane).length) {
    candidate.publish(makeReviewEvent(candidate, 'message_delta', { text: '正文与需求模型仍有结构问题，不能通过忽略来确认。请先补充或修订需求。' }))
    candidate.publish(makeReviewEvent(candidate, 'message_completed', { subtype: 'error' }))
    return true
  }
  const pending = takePendingPrdReview(input.project_id)
  if (!pending) return false
  const serious = pending.issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_review_overridden',
      title: '用户忽略内审残留问题，转入 PRD 过目',
      why: '用户明确选择忽略残留问题；结构问题不可豁免，仍须过目 PRD 后开工',
      detail: {
        ignored_issues: serious.map((issue) => issue.claim),
      },
    },
  })
  const ack = '好的，已按你的选择忽略内审发现的残留问题。这是按你的需求整理的 PRD，请你过目，确认无误后我再开始画草图。'
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
    signal: pending.signal,
    reviewNote: `已忽略 ${serious.length} 个内审残留问题`,
  })
  return true
}

/** Delegation means an actual bounded repair/recheck, never silent waiver of unresolved issues. */
export async function resumePrdReviewDelegated(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingPrdReview(input.project_id)
  if (!pending) return false
  if (pending.delegationExhausted) { pendingPrdReviews.set(input.project_id, pending); return true }
  pending.publish(makeReviewEvent(pending, 'message_delta', { text: '正在按你的授权修订并复核剩余问题，完成后再展示 PRD。' }))
  const outcome = await runPrdReviewGate({
    backplane: pending.backplane, confirmedRequirements: pending.backplane.requirements,
    query: pending.query, env: pending.env, sessionId: pending.session_id, projectId: pending.project_id,
    requestId: pending.request_id, publish: pending.publish, signal: pending.signal, mode: pending.mode,
  })
  if (pending.signal?.aborted || outcome.aborted) return true
  const backplane = outcome.internalAudit?.revisedBackplane ?? pending.backplane
  if (outcome.verdict === 'pass' && outcome.mode === 'llm' && !outcome.degraded && !prdStructureIssues(backplane).length) {
    try {
      syncDocuments({ request_id: pending.request_id, session_id: pending.session_id, project_id: pending.project_id, checkpoint: 'requirement_confirmed' }, backplane)
      recordDecision({ project_id: pending.project_id, session_id: pending.session_id, entry: { type: 'prd_review_delegated', title: '向导修订与复核完成', why: '用户授权处理残留问题；实际复核通过后转 PRD 过目，没有忽略问题', detail: { revised: Boolean(outcome.internalAudit?.revisedBackplane) } } })
      pending.publish(makeReviewEvent(pending, 'message_delta', { text: '复核已通过，请查看这份 PRD，确认范围与业务规则后再开工。' }))
      pending.publish(makeReviewEvent(pending, 'message_completed', { subtype: 'success' }))
      publishPrdConfirmCard({ input: pending, backplane, requirements: backplane.requirements, query: pending.query, env: pending.env, publish: pending.publish, signal: pending.signal })
      return true
    } catch {
      pending.publish(makeReviewEvent(pending, 'message_delta', { text: '修订结果没有保存成功，本次没有进入确认或开工。' }))
    }
  }
  pending.publish(makeReviewEvent(pending, 'message_delta', { text: '本轮修订尚未收敛，剩余问题没有被忽略。请对这些具体问题选择处理方式或补充说明。' }))
  pending.publish(makeReviewEvent(pending, 'message_completed', { subtype: 'success' }))
  const issues = outcome.issues.length ? outcome.issues : pending.issues
  publishPrdReviewCard({ input: pending, requirements: pending.backplane.requirements, backplane: pending.backplane, issues,
    outcome: { ...outcome, verdict: 'needs_revision', issues }, query: pending.query, env: pending.env,
    publish: pending.publish, signal: pending.signal, delegationExhausted: true })
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
 * 逐题答案里每条按 option_id 的 `:ignore` 后缀 / 兑底文案判定是否「这条没问题」。
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
      ignored: answer.option_id.endsWith(':ignore') || (answer.option_id !== PRD_REVIEW_CUSTOM_OPTION_ID && /没问题|不改|忽略/.test(answer.label)),
    }))
  if (answers.length === 0) return undefined
  return { kind: 'answers', answers }
}

export function makeReviewEvent(
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


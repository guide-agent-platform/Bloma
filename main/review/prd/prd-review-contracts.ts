/**
 * 审查契约与状态（PR4d 拆出）：六维/选项/议题/结果类型、选项常量、待审快照读写、内审门参数。
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


export type PrdReviewDimension = 'I' | 'F' | 'Z' | 'U' | 'L' | 'G'

/** 逐题选择题的候选答案（2026-08-30 队友：审查问题选择题化 + 零基础话术）。 */
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
  /** 专业版问题描述（内部裁决/日志用，不直接暴露给用户） */
  claim: string
  evidence: string[]
  /** 零基础大白话问题（审查时一并产出；缺省回退 claim） */
  plain_question?: string
  /** 逐题选择题的候选答案（缺省/全灭时由代码层补「这条没问题」兑底） */
  options?: PrdReviewOption[]
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

/** 逐题选择题的固定兑底选项：每题必带「这条没问题」出口（不依赖模型输出）。 */
export const REVIEW_OPTION_IGNORE: PrdReviewOption = {
  id: 'ignore',
  label: '这条没问题',
  description: '不改这一条',
}

/** 全局让渡出口 id：用户不想逐题作答时一次性把决定权交给向导。 */
export const PRD_REVIEW_OPTION_DELEGATE_ALL = 'prd_review_delegate_all'

/** 「其他，自己填写」选项 id（renderer ReviewChoicesDialog 回传；label=用户填写文本，不受 ignore 文案判定影响）。 */
export const PRD_REVIEW_CUSTOM_OPTION_ID = 'custom'

/** 审查未过后的待决状态：用户逐题作答（选择题卡）或让渡后回流。 */
export interface PendingPrdReview {
  delegationExhausted?: boolean
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  /** 审查挂起时的生成 env（向导轮模型 env）：答案回流后 normalizer 修订与 PRD 重跑需复用，
   *  缺失会导致 normalizer 走 fallback 把修订指令原样 append 污染 description（2026-09-05 以撒地牢） */
  env?: Record<string, string>
  requirements: Array<{ id: string; description: string }>
  issues: PrdReviewIssue[]
  /** 审查时的背板：override 后转 PRD 确认门要用（2026-08-27，不过目不开工） */
  backplane: PrdBackplane
  query: SDKQuery
  publish: (event: AgentEvent) => void
  /** 停止信号（m-6）：override 转确认门时透传——确认后 EARS 化与草图生成同样可被停止 */
  signal?: AbortSignal
  /** 内审元数据（2026-09-01）：卡面展示 Defender 已改什么/是否隔离 */
  internalAudit?: InternalAuditMeta
}

export const pendingPrdReviews = new Map<string, PendingPrdReview>()

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
export function seriousIssues(issues: PrdReviewIssue[], mode?: AgentSendMessageInput['mode']): PrdReviewIssue[] {
  const blockingOnly = mode === 'quick' && internalAuditMajorGateEnabled()
  return issues.filter((issue) =>
    blockingOnly ? issue.severity === 'blocking' : issue.severity === 'blocking' || issue.severity === 'major',
  )
}

/** quick 1 轮 / longterm 2 轮（设计稿 §3.2 轮次预算）。 */
export function internalAuditBudget(mode?: AgentSendMessageInput['mode']): number {
  return mode === 'longterm' ? 2 : 1
}

export const DEFENDER_DELEGATION_TIMEOUT_MS = 150_000
export const DEFENDER_MAX_TURNS = 10
/** Defender 直连降级路径的输出 token 上限（背板全量 JSON 产出）。 */
export const DEFENDER_DIRECT_MAX_TOKENS = 640000

// =========================================================================
// 审查执行
// =========================================================================


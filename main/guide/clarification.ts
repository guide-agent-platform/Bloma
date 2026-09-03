/**
 * guide/clarification — 加厚追问通路（②，2026-09-03 架构落地）。
 *
 * 状态机五态（设计稿：会话工作台 plan/clarification-state-machine.md）：
 * 挂起（发卡即返回，流程级挂起非线程级——对齐 prd-confirm 模式）→ 回传
 * （追问卡经 user_decision_required 事件流，复用既有通道零新 IPC）→
 * 答案落会话（user 消息经 orchestrator sendMessage 统一落 JSONL，成为下一轮
 * 接地守卫②的新 userTexts）→ 轮次上限 / 超时回退（任一触发即回退现状静默
 * 降级路径，绝不阻塞「PRD 不过目不开工」主线）。
 *
 * 不变式（F9a 五防线）：
 * - 追问是增强不是门禁：所有非 answered 出口汇入现状路径；
 * - 挂起有界：轮次上限 + 超时双保险；挂起可中断（signal/停止，不吞信号）；
 * - 会话即真相源：轮次计数与孤儿挂起检测全部从决策行推导，重启零迁移恢复
 *   （requested 决策行 detail 存 requests 原文，孤儿经检测按 timeout 语义收敛）。
 *
 * 拍板参数（2026-09-03 按建议值开工）：MAX_ROUNDS=2、TIMEOUT=10min。
 */

import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { getAgentSessionPath } from '../../storage/config-paths'
import { recordDecision } from '../decision-log'
import type { AgentEvent, AgentMessage, AgentSendMessageInput } from '../../shared/types'
import type { SDKQuery } from '../orchestrator'

/** 事件发布器（与 guide-agent-service.GuideEventPublisher 同构；本地签名避免反向依赖编排层）。 */
type ClarificationEventPublisher = (event: AgentEvent) => void

/** 追问卡回答选项 id（selected_option_id 回传识别；content=用户开放回答文本）。 */
export const ENRICHMENT_CLARIFICATION_OPTION_ANSWER = 'enrichment_clarification_answer'

/** 轮次上限（拍板①）：answered 决策行计数达到即不再挂起，静默降级走现状路径。 */
export const ENRICHMENT_CLARIFICATION_MAX_ROUNDS = 2

/** 超时回退（拍板②）：挂起后 T 内未收到回答 → 回退现状路径（迟到答案只落会话）。 */
export const ENRICHMENT_CLARIFICATION_TIMEOUT_MS = 10 * 60 * 1000

/** 单轮追问条数上限（prompt 纪律的代码侧硬守卫）：宁少勿多，防追问卡变问卷。 */
export const ENRICHMENT_CLARIFICATION_MAX_QUESTIONS = 2

/** 追问请求：for=目标功能项 id（须在冻结清单内），question=一句话开放问题。 */
export interface EnrichmentClarificationRequest {
  for: string
  question: string
}

/** 挂起上下文（对齐 PendingPrdConfirm 字段族）：answered 后整轮重跑所需全部输入。 */
export interface PendingEnrichmentClarification {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: Array<{ id: string; description: string }>
  query: SDKQuery | undefined
  env?: Record<string, string>
  publish: ClarificationEventPublisher
  signal?: AbortSignal
}

/** 内存挂起表（per project）。流程级挂起：发卡后调用栈返回，回传经 sendMessage 新栈续跑。 */
const pendingEnrichmentClarifications = new Map<string, PendingEnrichmentClarification>()

/** 挂起中的超时 timer（per project）：answered/cancelled 时清除，防重复回退。 */
const clarificationTimers = new Map<string, ReturnType<typeof setTimeout>>()

export function hasPendingEnrichmentClarification(projectId: string): boolean {
  return pendingEnrichmentClarifications.has(projectId)
}

export function takePendingEnrichmentClarification(projectId: string): PendingEnrichmentClarification | undefined {
  clearClarificationTimer(projectId)
  const pending = pendingEnrichmentClarifications.get(projectId)
  pendingEnrichmentClarifications.delete(projectId)
  return pending
}

/** 清除超时 timer（挂起终结时调用：answered/超时触发后/取消）。 */
function clearClarificationTimer(projectId: string): void {
  const timer = clarificationTimers.get(projectId)
  if (timer) {
    clearTimeout(timer)
    clarificationTimers.delete(projectId)
  }
}

// ---------------------------------------------------------------------------
// 会话决策行推导（会话即真相源）
// ---------------------------------------------------------------------------

interface DecisionLine {
  type: string
  detail?: Record<string, unknown>
}

/** 读会话 JSONL 中全部决策行（[decision] system 行的 JSON-in-JSON，裸解析容错）。 */
function readDecisionLines(sessionId: string): DecisionLine[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const decisions: DecisionLine[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.includes('enrichment_clarification')) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line.trim()) as AgentMessage
    } catch {
      continue
    }
    if (message.role !== 'system') continue
    // 决策行 content 为块数组（decision-log 同构：[{type:'text', text:'[decision] {json}'}]）
    const text = Array.isArray(message.content)
      ? message.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('')
      : typeof message.content === 'string'
        ? message.content
        : ''
    if (!text.startsWith('[decision]')) continue
    try {
      const entry = JSON.parse(text.slice('[decision]'.length).trim()) as { type?: string; detail?: Record<string, unknown> }
      if (entry?.type) decisions.push({ type: entry.type, detail: entry.detail })
    } catch {
      continue
    }
  }
  return decisions
}

/** 已回答轮次：enrichment_clarification_answered 决策行总数（追问序列天然线性，总数即轮次）。 */
export function countEnrichmentClarificationRounds(sessionId: string): number {
  return readDecisionLines(sessionId).filter((line) => line.type === 'enrichment_clarification_answered').length
}

/** 超时标记：会话中出现过 enrichment_clarification_timeout → 本项目生命周期内不再挂起。 */
export function hasEnrichmentClarificationTimeout(sessionId: string): boolean {
  return readDecisionLines(sessionId).some((line) => line.type === 'enrichment_clarification_timeout')
}

/**
 * 轮次守卫（挂起前置）：answered < MAX_ROUNDS 且无超时标记才允许挂起。
 * 上限/超时任一触发 → 调用方按现状静默降级（K-2：守卫不过=不追问，不阻塞主线）。
 */
export function shouldSuspendForEnrichmentClarification(sessionId: string): boolean {
  if (hasEnrichmentClarificationTimeout(sessionId)) return false
  return countEnrichmentClarificationRounds(sessionId) < ENRICHMENT_CLARIFICATION_MAX_ROUNDS
}

/**
 * 孤儿挂起检测（重启恢复）：尾部有 requested 决策行且其后无 answered/timeout 终结行
 * → 内存 pending 已随重启丢失，返回 requested 时存的 requests 原文（供按 timeout
 * 语义收敛：落 timeout 决策行 + 重跑管线，不再等待一个不会来的回答）。
 */
export function detectOrphanEnrichmentClarification(sessionId: string): EnrichmentClarificationRequest[] | undefined {
  const decisions = readDecisionLines(sessionId)
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const type = decisions[i].type
    if (type === 'enrichment_clarification_answered' || type === 'enrichment_clarification_timeout') return undefined
    if (type === 'enrichment_clarification_requested') {
      const requests = decisions[i].detail?.requests
      return Array.isArray(requests) ? (requests as EnrichmentClarificationRequest[]) : []
    }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// 决策行记录（T2 决策日志；requested 的 detail 存 requests 原文供孤儿恢复）
// ---------------------------------------------------------------------------

export function recordEnrichmentClarificationRequested(
  input: { project_id: string; session_id: string },
  requests: EnrichmentClarificationRequest[],
): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'enrichment_clarification_requested',
      title: '加厚追问挂起',
      why: `PRD 定稿前发现 ${requests.length} 处信息缺口，追问后重新整理（第 ${countEnrichmentClarificationRounds(input.session_id) + 1}/${ENRICHMENT_CLARIFICATION_MAX_ROUNDS} 轮）`,
      detail: { requests },
    },
  })
}

export function recordEnrichmentClarificationAnswered(
  input: { project_id: string; session_id: string },
  answer: string,
): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'enrichment_clarification_answered',
      title: '加厚追问已回答',
      why: `用户回答「${answer.slice(0, 60)}」已落会话，成为下一轮接地证据，PRD 整轮重跑`,
      detail: { answer: answer.slice(0, 200) },
    },
  })
}

export function recordEnrichmentClarificationExhausted(input: { project_id: string; session_id: string }): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'enrichment_clarification_exhausted',
      title: '加厚追问轮次达上限',
      why: `已连续追问 ${ENRICHMENT_CLARIFICATION_MAX_ROUNDS} 轮，按已确认信息整理 PRD（薄形态不阻塞），缺口留待迭代补充`,
      detail: { rounds: ENRICHMENT_CLARIFICATION_MAX_ROUNDS },
    },
  })
}

export function recordEnrichmentClarificationTimeout(input: { project_id: string; session_id: string }): void {
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'enrichment_clarification_timeout',
      title: '加厚追问超时回退',
      why: '追问等待超时（用户未回答或卡片未送达），按已确认信息整理 PRD（薄形态不阻塞）；迟到的回答将落会话成为迭代期接地证据',
      detail: { timeout_ms: ENRICHMENT_CLARIFICATION_TIMEOUT_MS },
    },
  })
}

// ---------------------------------------------------------------------------
// 卡片事件与回传识别（单一交互通道：user_decision_required + selected_option_id）
// ---------------------------------------------------------------------------

/** 构造追问卡事件（渲染端按 payload.kind='enrichment_clarification' 分流到 ClarificationCard）。 */
export function makeEnrichmentClarificationCardEvent(
  input: { session_id: string; project_id: string },
  requests: EnrichmentClarificationRequest[],
): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type: 'user_decision_required',
    payload: {
      kind: 'enrichment_clarification',
      title: '整理 PRD 前，先确认几个关键点',
      requests: requests.map((request) => ({ for: request.for, question: request.question })),
    },
    created_at: new Date().toISOString(),
  }
}

/** 追问卡回答识别：selected_option_id 命中即追问回答（content=开放回答文本）。 */
export function isEnrichmentClarificationAnswer(input: AgentSendMessageInput): boolean {
  return input.metadata?.selected_option_id === ENRICHMENT_CLARIFICATION_OPTION_ANSWER
}

/** 挂起追问（发卡 + requested 决策行 + 超时 timer 注册）。调用方此后立即返回。 */
export function suspendForEnrichmentClarification(
  pending: PendingEnrichmentClarification,
  requests: EnrichmentClarificationRequest[],
  onTimeout: (pending: PendingEnrichmentClarification) => void,
): void {
  pendingEnrichmentClarifications.set(pending.project_id, pending)
  recordEnrichmentClarificationRequested(pending, requests)
  pending.publish(makeEnrichmentClarificationCardEvent(pending, requests))
  const timer = setTimeout(() => {
    clarificationTimers.delete(pending.project_id)
    // 超时回退：pending 仍在（未回答未取消）→ 按现状降级重跑；已终结则 no-op
    if (pendingEnrichmentClarifications.delete(pending.project_id)) {
      onTimeout(pending)
    }
  }, ENRICHMENT_CLARIFICATION_TIMEOUT_MS)
  // 常驻主进程不依赖此 timer 存活；unref 防止空转 App 无法退出
  timer.unref?.()
  clarificationTimers.set(pending.project_id, timer)
}

// ---------------------------------------------------------------------------
 // 确定性清洗（enricher 输出的 clarification_requests 守卫，K-2 代码侧硬边界）
// ---------------------------------------------------------------------------

/**
 * 追问请求清洗：for 必须在冻结 id 集、question 去空白后非空且 ≤100 字、
 * 按 for+question 去重、上限 2 条（超出的丢弃——宁少勿多）。
 * 模型输出的任何形态问题都收敛为「丢弃该条」，不阻断可用部分。
 */
export function sanitizeClarificationRequests(
  raw: unknown,
  frozenIds: Set<string>,
): EnrichmentClarificationRequest[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const cleaned: EnrichmentClarificationRequest[] = []
  for (const entry of raw) {
    if (cleaned.length >= ENRICHMENT_CLARIFICATION_MAX_QUESTIONS) break
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const forId = typeof record.for === 'string' ? record.for.trim() : ''
    const question = typeof record.question === 'string' ? record.question.trim() : ''
    if (!forId || !frozenIds.has(forId)) continue
    if (!question || question.length > 100) continue
    const key = `${forId}::${question}`
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push({ for: forId, question })
  }
  return cleaned
}

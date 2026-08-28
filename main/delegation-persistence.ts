import { existsSync, readFileSync } from 'node:fs'
import { appendJsonLine } from '../storage/json-store'
import { getAgentSessionPath, getAgentSessionsIndexPath } from '../storage/config-paths'
import type { AgentSessionRecord, MessageContentBlock } from '../shared/types'
import type { ConversationTurn } from './orchestrator'

/**
 * Delegation 子会话持久化与恢复（delegation-persistence-port.md 阶段 1+2，2026-08-28）：
 * 子会话消息一直落 JSONL（数据不丢），本模块补齐「恢复通路」——
 * - 阶段 1（meta 归属，在 session-service.recordSessionActivity）：索引带
 *   source_delegation_id / parent_session_id，重启后能按 delegationId 反查子会话文件。
 * - 阶段 2（registry 恢复，本模块）：唯一性安全检查（防跨父误恢复，
 *   Proma agent-collaboration-tools.ts:441-447 同构）+ JSONL 末行 settle 推断终态，
 *   重建纯数据视图 RestoredDelegationRecord（不含 AbortController 等活体字段）。
 *
 * 设计取舍（诚实优于魔法）：JSONL 无 settle 行 = 重启时子任务仍在跑，恢复为 running
 * 态交由上层决定改 cancelled（「应用重启中断」），不假装能自动续跑。
 */

export type RestoredDelegationStatus = 'running' | 'completed' | 'failed' | 'cancelled'

export interface RestoredDelegationRecord {
  delegationId: string
  parentSessionId: string
  childSessionId: string
  status: RestoredDelegationStatus
  /** 终态（completed/failed/cancelled）= true；running 态上层应标记为「重启中断」 */
  finished: boolean
  resultSummary?: string
  error?: string
}

/** appendDelegationSettle 写入的终态标记行字段名（loadMessages 会过滤该行，不进对话流） */
const SETTLE_FIELD = 'delegation_settle'

/** 终态落盘：子 loop settle 时在子会话 JSONL 末尾追加一行终态标记（重启推断依据） */
export function appendDelegationSettle(
  childSessionId: string,
  status: Exclude<RestoredDelegationStatus, 'running'>,
  payload?: { resultSummary?: string; error?: string },
): void {
  appendJsonLine(getAgentSessionPath(childSessionId), {
    [SETTLE_FIELD]: status,
    ...(payload?.resultSummary ? { result_summary: payload.resultSummary } : {}),
    ...(payload?.error ? { error: payload.error } : {}),
    timestamp: Date.now(),
  })
}

/** 唯一性安全检查（Proma :441-447 同构）：parent 精确匹配优先；否则仅接受全局唯一命中且该命中「无父记录」 */
function findPersistedSession(
  sessions: AgentSessionRecord[],
  parentSessionId: string,
  delegationId: string,
): AgentSessionRecord | undefined {
  const scoped = sessions.filter((item) => item.source_delegation_id === delegationId)
  const matched = scoped.find((item) => item.parent_session_id === parentSessionId)
  if (matched) return matched
  if (scoped.length !== 1) return undefined // 0 个或多个（UUID 碰撞/数据异常）→ 拒绝
  const unique = scoped[0]!
  // 防跨父误恢复：只接受「无父记录」或「父一致」两种
  if (unique.parent_session_id == null || unique.parent_session_id === parentSessionId) return unique
  return undefined
}

/** 从 JSONL 末行推断子会话终态（无 settle 行 = 重启时仍在跑 → running，诚实标记） */
function inferStatusFromJsonl(jsonlPath: string): { status: RestoredDelegationStatus; resultSummary?: string; error?: string } {
  if (!existsSync(jsonlPath)) return { status: 'cancelled' }
  const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { status: 'running' }
  let last: Record<string, unknown> = {}
  try {
    last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>
  } catch {
    return { status: 'running' }
  }
  const settle = last[SETTLE_FIELD]
  if (settle === 'completed' || settle === 'failed' || settle === 'cancelled') {
    return {
      status: settle,
      resultSummary: typeof last.result_summary === 'string' ? last.result_summary : undefined,
      error: typeof last.error === 'string' ? last.error : undefined,
    }
  }
  return { status: 'running' }
}

/**
 * 重启视角恢复委派记录：读索引反查子会话 → 唯一性安全检查 → JSONL 末行推断终态。
 * 找不到 / 安全检查拒绝 / 数据异常一律返回 undefined（不抛错，由上层决定提示语义）。
 */
export function restoreDelegationRecord(parentSessionId: string, delegationId: string): RestoredDelegationRecord | undefined {
  const indexPath = getAgentSessionsIndexPath()
  if (!existsSync(indexPath)) return undefined
  let sessions: AgentSessionRecord[]
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as { sessions?: AgentSessionRecord[] }
    sessions = Array.isArray(raw.sessions) ? raw.sessions : []
  } catch {
    return undefined
  }
  const session = findPersistedSession(sessions, parentSessionId, delegationId)
  if (!session) return undefined
  const { status, resultSummary, error } = inferStatusFromJsonl(session.jsonl_path)
  return {
    delegationId,
    parentSessionId: session.parent_session_id ?? parentSessionId,
    childSessionId: session.session_id,
    status,
    finished: status !== 'running',
    ...(resultSummary ? { resultSummary } : {}),
    ...(error ? { error } : {}),
  }
}

// ==========================================================================
// 阶段 3：continue 续跑输入构造（delegation-persistence-port.md §三-阶段 3）
// ==========================================================================

export interface ChildSessionMessage {
  role: 'assistant' | 'user'
  content: MessageContentBlock[]
}

export interface ChildSessionSettle {
  status: Exclude<RestoredDelegationStatus, 'running'>
  resultSummary?: string
  error?: string
}

export interface ChildSessionSnapshot {
  messages: ChildSessionMessage[]
  /** null = 无 settle 行（重启时子任务仍在跑）——上层据此拒绝 continue */
  lastSettle: ChildSessionSettle | null
}

/**
 * 读回子会话 JSONL：对话消息与 settle 终态行分离。
 * settle 行（appendDelegationSettle 写入）不是对话消息，不进重放。
 */
export function loadChildSessionSnapshot(childSessionId: string): ChildSessionSnapshot {
  const path = getAgentSessionPath(childSessionId)
  if (!existsSync(path)) return { messages: [], lastSettle: null }
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
  const messages: ChildSessionMessage[] = []
  let lastSettle: ChildSessionSettle | null = null
  for (const line of lines) {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (typeof parsed[SETTLE_FIELD] === 'string') {
      lastSettle = {
        status: parsed[SETTLE_FIELD] as ChildSessionSettle['status'],
        resultSummary: typeof parsed.result_summary === 'string' ? parsed.result_summary : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
      }
      continue
    }
    if ((parsed.role === 'assistant' || parsed.role === 'user') && Array.isArray(parsed.content)) {
      messages.push({ role: parsed.role, content: parsed.content as MessageContentBlock[] })
    }
  }
  return { messages, lastSettle }
}

/**
 * 纯重放：子会话历史 → 模型可见轮次。新指令（follow-up）不在此追加——由 runAgentLoop
 * 的 task 承担（多厂商审查 fail 点修复：否则 follow-up 重复 + 连续双 user）。
 * 防御：首条非 user 的异常历史丢弃（防 Anthropic 首条非 user 400）；
 * 末尾悬空 tool_use 轮丢弃（无后续 tool_result 会触发配对校验失败）。
 */
export function replayTurnsFrom(messages: ChildSessionMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = messages.map((m) => ({ role: m.role, content: m.content }))
  while (turns.length > 0 && turns[0]!.role !== 'user') turns.shift()
  while (turns.length > 0) {
    const last = turns[turns.length - 1]!
    if (last.role === 'assistant' && Array.isArray(last.content) && last.content.some((b) => b.type === 'tool_use')) {
      turns.pop()
    } else break
  }
  return turns
}

/**
 * 启动对账（多厂商审查 risk-3 闭环，2026-08-28）：重启后「无 settle 行」的委派 =
 * 应用重启时子任务仍在跑——统一标记为 cancelled（「应用重启中断」）并落 settle 行，
 * 之后 restoreDelegationRecord 读到的即终态，无需每个调用方自行处理 running 态。
 * 幂等：已终态（有 settle 行）的委派不重复处理。
 */
export function reconcileRunningDelegations(parentSessionId: string): RestoredDelegationRecord[] {
  const indexPath = getAgentSessionsIndexPath()
  if (!existsSync(indexPath)) return []
  let sessions: AgentSessionRecord[]
  try {
    const raw = JSON.parse(readFileSync(indexPath, 'utf8')) as { sessions?: AgentSessionRecord[] }
    sessions = Array.isArray(raw.sessions) ? raw.sessions : []
  } catch {
    return []
  }
  const reconciled: RestoredDelegationRecord[] = []
  for (const session of sessions) {
    if (!session.source_delegation_id) continue
    if (session.parent_session_id && session.parent_session_id !== parentSessionId) continue
    const snap = loadChildSessionSnapshot(session.session_id)
    if (snap.lastSettle) continue // 已终态，不动
    const record: RestoredDelegationRecord = {
      delegationId: session.source_delegation_id,
      parentSessionId: session.parent_session_id ?? parentSessionId,
      childSessionId: session.session_id,
      status: 'cancelled',
      finished: true,
      error: '应用重启中断（启动对账自动标记）',
    }
    try {
      appendDelegationSettle(session.session_id, 'cancelled', { error: record.error })
    } catch (error) {
      console.warn('[delegation-persistence] 对账 settle 落盘失败:', error)
      continue
    }
    reconciled.push(record)
  }
  return reconciled
}

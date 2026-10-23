import { existsSync, readFileSync } from 'node:fs'
import { getAgentSessionPath } from '../../storage/config-paths'
import { replayTurnsFrom, type ChildSessionMessage } from '../agent/delegation/delegation-persistence'
import { keepRecentTurns } from '../agent/loop/agent-loop'
import { pruneDuplicateReads } from '../agent/loop/work-progress'
import type { ConversationTurn } from '../orchestration/stages/orchestration-contracts'

/** Resume the primary session in the current phase/requirements scope. */
export function loadProductionHistory(sessionId: string, since: number): ConversationTurn[] {
  const file = getAgentSessionPath(sessionId)
  if (!existsSync(file)) return []
  const messages: ChildSessionMessage[] = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let row: { timestamp?: number; role?: string; content?: ChildSessionMessage['content'] }
    try { row = JSON.parse(line) } catch { continue }
    if ((row.timestamp ?? 0) < since || !Array.isArray(row.content) || (row.role !== 'user' && row.role !== 'assistant')) continue
    messages.push({ role: row.role, content: row.content })
  }
  if (!messages.length) return []
  const intro: ConversationTurn = { role: 'user', content: '继续同一阶段。以下为近期实际调用和结果；沿用已知事实，不重新通读。历史验证仅作线索，改动后仍需核对证据新鲜度。' }
  const turns = [intro, ...replayTurnsFrom(messages)]
  pruneDuplicateReads(turns)
  return [intro, ...keepRecentTurns(turns, 12000)]
}

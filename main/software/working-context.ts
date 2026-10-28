import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { readSoftwareRunState } from './run-state'
import { softwareStatusView } from './state-view'
import { activeSoftwareCommands, redactSoftwareOutput } from './process-manager'
import { toolFailureKey } from '../agent/loop/work-progress'
import { leanBudget } from '../desktop/lean-budget'

function recentTools(sessionId?: string) {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return { available: false, tools: [] }
  const file = join(getPromaHome(), 'agent-sessions', sessionId + '.jsonl')
  if (!existsSync(file)) return { available: false, tools: [] }
  const size = statSync(file).size, count = Math.min(size, 131072), buffer = Buffer.alloc(count), fd = openSync(file, 'r')
  try { readSync(fd, buffer, 0, count, size - count) } finally { closeSync(fd) }
  let tail = buffer.toString('utf8'); if (size > count) tail = tail.slice(tail.indexOf('\n') + 1)
  const calls = new Map<string, { tool: string; path?: string }>(), tools: Array<{ tool: string; path?: string; status: string; failure?: string }> = []
  for (const line of tail.split('\n')) try {
    const message = JSON.parse(line)
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const path = typeof block.input?.path === 'string' && !/^(?:[a-z]:|[\\/])/i.test(block.input.path) && !block.input.path.split(/[\\/]/).includes('..') ? redactSoftwareOutput(block.input.path).slice(0, 160) : undefined
        calls.set(block.id, { tool: block.name.slice(0, 64), path })
      }
      if (block.type === 'tool_result' && calls.has(block.tool_use_id)) {
        const call = calls.get(block.tool_use_id)!
        tools.push({ ...call, status: block.is_error ? 'failed' : 'returned', failure: block.is_error && typeof block.content === 'string' ? toolFailureKey(call.tool, block.content)?.split(':')[0] : undefined })
      }
    }
  } catch { /* torn/oversized records are not invented as successful work */ }
  return { available: true, truncated: size > count, tools: tools.slice(-10) }
}

/** Host facts are a navigation index, not a new plan or PASS certificate. */
export function softwareWorkingContext(projectId: string, busy = true) {
  const project = findProject(projectId), brief = readPrdBackplane(projectId), state = readSoftwareRunState(projectId)
  const current = state?.operationId === project.lean_operation_id ? state : undefined
  const source = softwareVerificationFingerprint(project.root_path)
  let budget: { requests?: number; output?: number; accounting_available: boolean; error?: string }
  try { const live = leanBudget(projectId, 'desktop-implement').snapshot(); budget = { requests: live.requests, output: live.output, accounting_available: true } }
  catch { budget = { accounting_available: false, error: '当前计量记录不可读；以请求/金额准入保护为准，不从旧索引推断剩余额度。' } }
  return { project_id: projectId, operation_id: project.lean_operation_id, session_id: current?.sessionId ?? project.last_session_id,
    goal_excerpt: brief.positioning.slice(0, 600), confirmed: Boolean(brief.user_confirmed_at), scope_hash: prdScopeFingerprint(brief), feature_ids: brief.requirements.slice(0, 128).map(r => r.id), feature_count: brief.requirements.length,
    status: softwareStatusView(projectId, busy), current_source: source, checkpoint_source: current?.source,
    source_changed_since_checkpoint: source && current?.source ? source !== current.source : undefined,
    pending_commands: activeSoftwareCommands(projectId, current?.sessionId ?? project.last_session_id ?? ''),
    current_error: current?.error?.slice(0, 800), historical_failure: current?.last_failure && { ...current.last_failure, error: current.last_failure.error.slice(0, 800) },
    budget,
    recent: recentTools(current?.sessionId ?? project.last_session_id),
    instruction: '这是宿主现场索引，不是新需求或通过凭据。最近检查与失败均有对应版本；先核对当前版本和已有工具回执，未决命令用read_process接续，不重复安装、写入或其它副作用。完整目标用features/overview读取；继续不清零账本。' }
}
export function renderSoftwareWorkingContext(projectId: string) {
  const facts = softwareWorkingContext(projectId)
  // Shrink optional history, never slice a JSON record in half after compaction.
  while (JSON.stringify(facts).length > 7400 && facts.recent.tools.length) facts.recent.tools.shift()
  const encoded = JSON.stringify(facts)
  return '【宿主工作状态摘要】\n' + (encoded.length <= 7400 ? encoded : JSON.stringify({
    project_id: facts.project_id, operation_id: facts.operation_id, scope_hash: facts.scope_hash, current_source: facts.current_source,
    execution_status: facts.status.execution.status, verification_status: facts.status.verification.status, goal_status: facts.status.goal.status,
    budget: facts.budget, pending_commands: facts.pending_commands, context_truncated: true,
    instruction: '完整现场按需读取working-state；当前摘要不代表通过，不重放安装或其它副作用。',
  }))
}

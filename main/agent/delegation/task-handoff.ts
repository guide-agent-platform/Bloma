import type { AgentLoopResult } from '../loop/agent-loop'
import { safeToolFeedback, type ToolFeedback } from '../../../shared/tool-feedback'
import { persistentBudgetBlocked, retainedToolFeedback } from '../../../shared/tool-feedback-policy'
export interface TaskHandoff {
  schema_version: 1
  completion: 'unverified' | 'incomplete'
  loop_status: string
  stop_reason?: string
  changed_files: string[]
  verification: ToolFeedback[]
  pending: string[]
  recovery?: ToolFeedback['recovery']
}
export function handoffRecovery(handoff: Pick<TaskHandoff, 'verification' | 'loop_status'>): ToolFeedback['recovery'] {
  if (persistentBudgetBlocked(handoff.verification)) return 'stop'
  const budgets = handoff.verification.filter(f => f.category === 'budget')
  if (budgets.length && budgets.some(f => safeToolFeedback(f)?.recovery !== 'resume')) return 'inspect'
  if (handoff.loop_status === 'turn_limit' || handoff.loop_status === 'budget_exhausted' && budgets.length) return 'resume'
  if (handoff.loop_status === 'cancelled') return 'stop'
  return handoff.loop_status === 'completed' && !handoff.verification.some(f => f.execution === 'failed' || f.verification === 'failed') ? 'none' : 'inspect'
}
export function buildTaskHandoff(result: AgentLoopResult): TaskHandoff {
  const verification = retainedToolFeedback((result.tool_feedback ?? []).map(safeToolFeedback).filter((f): f is ToolFeedback => Boolean(f)))
  const unfinished = result.status !== 'completed' || verification.some(f => f.category === 'budget' || f.execution === 'failed' || f.verification === 'failed')
  const pending = verification.filter(f => f.category || f.verification === 'failed').map(f => `${f.scope ?? '工具'}: ${f.category ?? f.verification}; ${f.reason ?? f.recovery ?? '读取证据'}`).slice(0, 6)
  if (result.status !== 'completed') pending.unshift(`执行停止：${result.status}`)
  if (!pending.length) pending.push('目标完整性尚需宿主验收，执行结束不等于交付通过')
  return { schema_version: 1, completion: unfinished ? 'incomplete' : 'unverified', loop_status: result.status, stop_reason: result.termination_detail?.reason,
    changed_files: (result.files_changed ?? []).slice(0, 20), verification, pending, recovery: handoffRecovery({ verification, loop_status: result.status }) }
}
export function readTaskHandoff(raw: unknown): TaskHandoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as TaskHandoff
  if (r.schema_version !== 1 || !['unverified', 'incomplete'].includes(r.completion) || typeof r.loop_status !== 'string' || !Array.isArray(r.changed_files) || !Array.isArray(r.verification) || !Array.isArray(r.pending)) return undefined
  const verification = retainedToolFeedback(r.verification.map(safeToolFeedback).filter((f): f is ToolFeedback => Boolean(f)))
  return { schema_version: 1, completion: r.completion, loop_status: r.loop_status.slice(0, 40), stop_reason: typeof r.stop_reason === 'string' ? r.stop_reason.slice(0, 80) : undefined,
    changed_files: r.changed_files.filter(p => typeof p === 'string').slice(0, 20).map(p => p.slice(0, 160)),
    verification, recovery: handoffRecovery({ verification, loop_status: r.loop_status }), pending: r.pending.filter(p => typeof p === 'string').slice(0, 6).map(p => p.slice(0, 240)) }
}
export function renderTaskHandoff(handoff: TaskHandoff): string {
  return `【宿主续接事实】${JSON.stringify(handoff)}\n以上是上一段执行事实，不是当前版本的通过证明。先核对变更与证据版本，只处理未完成项；根因推测须与实际报告分开。`
}

import type { AgentLoopResult } from '../loop/agent-loop'
import { safeToolFeedback, type ToolFeedback, type ToolBudgetFact } from '../../../shared/tool-feedback'
import { hasUnresolvedToolFailure, persistentBudgetBlocked, retainedToolFeedback } from '../../../shared/tool-feedback-policy'
export interface TaskHandoff {
  schema_version: 1
  completion: 'unverified' | 'incomplete'
  loop_status: string
  stop_reason?: string
  changed_files: string[]
  verification: ToolFeedback[]
  pending: string[]
  recovery?: ToolFeedback['recovery']
  resources?: ToolBudgetFact[]
  omitted_changed_files?: number
}
export function handoffRecovery(handoff: Pick<TaskHandoff, 'verification' | 'loop_status'>): ToolFeedback['recovery'] {
  if (persistentBudgetBlocked(handoff.verification)) return 'stop'
  const budgets = handoff.verification.filter(f => f.category === 'budget')
  if (budgets.length && budgets.some(f => safeToolFeedback(f)?.recovery !== 'resume')) return 'inspect'
  if (handoff.loop_status === 'turn_limit' || handoff.loop_status === 'budget_exhausted' && budgets.length) return 'resume'
  if (handoff.loop_status === 'cancelled') return 'stop'
  return handoff.loop_status === 'completed' && !handoff.verification.some(hasUnresolvedToolFailure) ? 'none' : 'inspect'
}
export function buildTaskHandoff(result: AgentLoopResult): TaskHandoff {
  const verification = retainedToolFeedback((result.tool_feedback ?? []).map(safeToolFeedback).filter((f): f is ToolFeedback => Boolean(f)))
  const unfinished = result.status !== 'completed' || verification.some(hasUnresolvedToolFailure)
  const pending = verification.filter(f => f.category || f.verification === 'failed' || f.evidence?.freshness !== 'current' && f.evidence)
    .map(f => f.evidence?.freshness !== 'current' && f.evidence ? `${f.evidence.entry}: 验证版本 ${f.evidence.freshness}，核对变更后仅补缺失验证`
      : `${f.scope ?? '工具'}: ${f.category ?? f.verification}; ${f.reason ?? f.recovery ?? '读取证据'}`).slice(0, 6)
  if (result.status !== 'completed') pending.unshift(`执行停止：${result.status}`)
  if (!pending.length) pending.push('目标完整性尚需宿主验收，执行结束不等于交付通过')
  return { schema_version: 1, completion: unfinished ? 'incomplete' : 'unverified', loop_status: result.status, stop_reason: result.termination_detail?.reason,
    changed_files: (result.files_changed ?? []).slice(0, 20), verification, pending, recovery: handoffRecovery({ verification, loop_status: result.status }),
    ...((result.files_changed?.length ?? 0) > 20 ? { omitted_changed_files: result.files_changed!.length - 20 } : {}),
    resources: verification.filter(f => f.scope === 'execution_resources' && f.budget).map(f => f.budget!) }
}
export function readTaskHandoff(raw: unknown): TaskHandoff | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as TaskHandoff
  if (r.schema_version !== 1 || !['unverified', 'incomplete'].includes(r.completion) || typeof r.loop_status !== 'string' || !Array.isArray(r.changed_files) || !Array.isArray(r.verification) || !Array.isArray(r.pending)) return undefined
  const verification = retainedToolFeedback(r.verification.map(safeToolFeedback).filter((f): f is ToolFeedback => Boolean(f)))
  const omitted = Number.isSafeInteger(r.omitted_changed_files) && r.omitted_changed_files! > 0 ? r.omitted_changed_files! : 0
  return { schema_version: 1, completion: r.completion, loop_status: r.loop_status.slice(0, 40), stop_reason: typeof r.stop_reason === 'string' ? r.stop_reason.slice(0, 80) : undefined,
    changed_files: r.changed_files.filter(p => typeof p === 'string').slice(0, 20),
    ...(omitted || r.changed_files.length > 20 ? { omitted_changed_files: omitted + Math.max(0, r.changed_files.length - 20) } : {}),
    verification, recovery: handoffRecovery({ verification, loop_status: r.loop_status }), pending: r.pending.filter(p => typeof p === 'string').slice(0, 6).map(p => p.slice(0, 240)),
    resources: verification.filter(f => f.scope === 'execution_resources' && f.budget).map(f => f.budget!) }
}
export function renderTaskHandoff(handoff: TaskHandoff): string {
  return `【宿主续接事实】${JSON.stringify(handoff)}\n模型总结和未核对的旧记录不是当前版本的通过证明。evidence.freshness=current 仅证明该入口已报告的断言；可引用，无需因另一条启动探测或交付文档更新而全部重跑。stale/unknown、真实失败、代码/测试/输入/环境变更或缺少必需场景才补验。优先静态核对声明映射与证据，保留额度给缺口和交付收口；remaining=0 不安排新的执行。完整目标仍由宿主独立验收。`
}

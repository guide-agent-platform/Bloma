import { findProject } from '../project/project-service'
import { createProductionBudget, productionDeadlineMs, PRODUCTION_LIMITS, RUNTIME_HEARTBEAT_MS } from './production-budget'

export function leanBudget(projectId: string, phase: string) {
  const project = findProject(projectId)
  const software = project.workflow_version === 'software-v1'
  // Software has one shared allowance. A second, smaller implementation-phase
  // limit must not strand an otherwise admitted continuous task.
  return createProductionBudget(projectId, `lean-v1/${project.lean_operation_id ?? 'initial'}`, phase,
    software ? { ...PRODUCTION_LIMITS, phaseRequests: PRODUCTION_LIMITS.requests } : undefined, software ? 'lease' : 'legacy')
}

export function leanBudgetStopMessage(projectId: string, phase: string, reason: string): string {
  const state = leanBudget(projectId, phase).snapshot()
  return `${reason}：本任务累计请求 ${state.requests}/${state.limits.requests}，预留及已报告输出 ${state.output}/${state.limits.output} token。已有文件和开发数据已保留；继续不会清零用量。需调整预算或缩小剩余目标后再执行。`
}

/** Preparation, tools and host verification share active execution time. Human
 * waiting time is excluded. A failed accounting write cannot release delivery. */
export async function withLeanRuntime<T>(projectId: string, phase: string, signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const budget = leanBudget(projectId, phase)
  const total = budget.startRuntime()
  // Software work has no fixed overall deadline. Runtime leases/accounting,
  // request/output/money guards and per-tool timeouts remain authoritative.
  // Historical workflows retain their cumulative deadline for compatibility.
  const remaining = findProject(projectId).workflow_version === 'software-v1' ? undefined : productionDeadlineMs('desktop-implement') - total
  if (remaining !== undefined && remaining <= 0) { budget.finishRuntime(); throw new Error('HARNESS_DEADLINE_EXCEEDED') }
  const guard = new AbortController(), timer = remaining === undefined ? undefined
    : setTimeout(() => guard.abort(new Error('HARNESS_DEADLINE_EXCEEDED')), remaining)
  const active = signal ? AbortSignal.any([signal, guard.signal]) : guard.signal
  const heartbeat = setInterval(() => { try { budget.heartbeatRuntime() } catch (error) { guard.abort(error) } }, RUNTIME_HEARTBEAT_MS)
  try { active.throwIfAborted(); const result = await work(active); active.throwIfAborted(); return result }
  finally { clearTimeout(timer); clearInterval(heartbeat); budget.finishRuntime() }
}

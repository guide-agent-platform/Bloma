import { findProject } from '../project/project-service'
import { createProductionBudget, productionDeadlineMs, RUNTIME_HEARTBEAT_MS } from './production-budget'

export function leanBudget(projectId: string, phase: string) {
  const project = findProject(projectId)
  return createProductionBudget(projectId, `lean-v1/${project.lean_operation_id ?? 'initial'}`, phase, undefined, project.workflow_version === 'software-v1' ? 'lease' : 'legacy')
}

/** Preparation, tools and host verification share active execution time. Human
 * waiting time is excluded. A failed accounting write cannot release delivery. */
export async function withLeanRuntime<T>(projectId: string, phase: string, signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const budget = leanBudget(projectId, phase)
  const total = budget.startRuntime()
  // A new human continuation grants another active time slice, never new
  // requests/output/money. Historical workflows retain their cumulative limit.
  const remaining = productionDeadlineMs('desktop-implement') - (findProject(projectId).workflow_version === 'software-v1' ? 0 : total)
  if (remaining <= 0) { budget.finishRuntime(); throw new Error('HARNESS_DEADLINE_EXCEEDED') }
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('HARNESS_DEADLINE_EXCEEDED')), remaining)
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  const heartbeat = setInterval(() => { try { budget.heartbeatRuntime() } catch (error) { deadline.abort(error) } }, RUNTIME_HEARTBEAT_MS)
  try { active.throwIfAborted(); const result = await work(active); active.throwIfAborted(); return result }
  finally { clearTimeout(timer); clearInterval(heartbeat); budget.finishRuntime() }
}

import { findProject } from '../project/project-service'
import { createProductionBudget, productionDeadlineMs } from './production-budget'

export function leanBudget(projectId: string, phase: string) {
  const project = findProject(projectId)
  return createProductionBudget(projectId, `lean-v1/${project.lean_operation_id ?? 'initial'}`, phase)
}

/** Preparation, tools and host verification share active execution time. Human
 * waiting time is excluded. A failed accounting write cannot release delivery. */
export async function withLeanRuntime<T>(projectId: string, phase: string, signal: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const budget = leanBudget(projectId, phase)
  const remaining = productionDeadlineMs('desktop-implement') - budget.startRuntime()
  if (remaining <= 0) { budget.finishRuntime(); throw new Error('HARNESS_DEADLINE_EXCEEDED') }
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new Error('HARNESS_DEADLINE_EXCEEDED')), remaining)
  const active = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
  try { active.throwIfAborted(); return await work(active) }
  finally { clearTimeout(timer); budget.finishRuntime() }
}

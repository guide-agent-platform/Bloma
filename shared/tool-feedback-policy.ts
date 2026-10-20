import type { ToolFeedback } from './tool-feedback'

/** One recovery policy for model history, orchestration and UI. No text guessing. */
export function toolRecovery(f: ToolFeedback): ToolFeedback['recovery'] {
  if (f.category === 'budget') {
    if (f.budget?.scope === 'invocation' && f.budget.resets_on === 'new_invocation') return 'resume'
    if (f.budget && ['new_run', 'none'].includes(f.budget.resets_on)) return 'stop'
    return 'inspect' // Old or unknown reset semantics never authorize automatic resume.
  }
  if (f.category === 'product_assertion' && f.verification === 'failed') return 'repair_product'
  if (f.category === 'verification_harness') return f.recovery ?? 'inspect'
  return f.recovery
}

export function persistentBudgetBlocked(feedback: readonly ToolFeedback[]): boolean {
  return feedback.some(f => f.category === 'budget' && toolRecovery(f) === 'stop')
}

/** A completed loop cannot erase a host-reported failed or blocked operation. */
export function hasUnresolvedToolFailure(f: ToolFeedback): boolean {
  return ['failed', 'cancelled'].includes(f.execution) || f.verification === 'failed'
    || ['environment', 'verification_harness', 'budget'].includes(f.category ?? '')
}

/** Terminal budget facts cannot fall out of a bounded handoff after ordinary reads. */
export function retainedToolFeedback(facts: readonly ToolFeedback[], limit = 8): ToolFeedback[] {
  const terminal = new Map<string, ToolFeedback>()
  const evidence = new Map<string, ToolFeedback>()
  const resources = new Map<string, ToolFeedback>()
  const other: ToolFeedback[] = []
  for (const f of facts) {
    if (f.category === 'budget' && toolRecovery(f) === 'stop') terminal.set(`${f.scope}:${JSON.stringify(f.budget)}`, f)
    else if (f.evidence) { evidence.delete(f.evidence.key); evidence.set(f.evidence.key, f) }
    else if (f.scope === 'execution_resources' && f.budget) resources.set(f.budget.resource, f)
    else other.push(f)
  }
  const ordinary = [...other, ...evidence.values()]
  const failures = ordinary.filter(hasUnresolvedToolFailure)
  const kept = [...failures, ...resources.values(), ...terminal.values()].slice(-limit)
  const room = Math.max(0, limit - kept.length)
  return [...(room ? ordinary.filter(f => !hasUnresolvedToolFailure(f)).slice(-room) : []), ...kept]
}

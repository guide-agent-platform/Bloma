import type { ToolContext } from '../loop/agent-loop'
import type { DelegationRecord } from './agent-collaboration'
import { appendDelegationSettle, loadChildSessionSnapshot, restoreDelegationRecord } from './delegation-persistence'
import type { DelegationParentContext } from './delegation-context'

export function registerChildWithHost(context: DelegationParentContext, child: { delegationId: string; childSessionId: string }, rollback: () => void): void {
  try { context.onChildCreated?.(child) }
  catch (error) {
    rollback()
    appendDelegationSettle(child.childSessionId, 'cancelled', { error: '宿主委派登记失败，子循环未启动' })
    throw error
  }
}

/** A finished handoff is replayable evidence, never a resumed live process. */
export function buildCompletedDelegation(parent: Pick<ToolContext, 'projectId' | 'sessionId'>, delegationId: string,
  completion: Pick<DelegationRecord, 'completion' | 'resolveCompletion'>, askSignal: DelegationRecord['askSignal']): DelegationRecord {
  const restored = restoreDelegationRecord(parent.sessionId, delegationId)
  const snapshot = restored && loadChildSessionSnapshot(restored.childSessionId)
  if (!restored || restored.parentSessionId !== parent.sessionId || restored.status !== 'completed'
    || snapshot?.lastSettle?.status !== 'completed' || snapshot.lastSettle.taskHandoff?.loop_status !== 'completed') {
    throw new Error('EXPERIMENT_HANDOFF_NOT_COMPLETED')
  }
  completion.resolveCompletion()
  return { delegationId, parentSessionId: parent.sessionId, childSessionId: restored.childSessionId,
    projectId: parent.projectId, role: 'implement', goal: '冻结骨架交接', status: 'completed', startedAt: Date.now(),
    abort: new AbortController(), ...completion, askSignal, loopStatus: 'completed',
    taskHandoff: snapshot.lastSettle.taskHandoff, resultSummary: restored.resultSummary }
}

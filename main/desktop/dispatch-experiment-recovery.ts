import type { DelegationRecord } from '../agent/delegation/agent-collaboration'
import { handoffRecovery } from '../agent/delegation/task-handoff'
import type { DispatchExperiment } from './dispatch-experiment'
import { finishExperiment } from './dispatch-experiment-records'

function workerRecoveryFailure(record: DelegationRecord | undefined): string | undefined {
  if (!record || !(record.loopStatus === 'budget_exhausted' || record.taskHandoff?.verification.some(f => f.category === 'budget'))) return
  const recovery = record.taskHandoff ? handoffRecovery(record.taskHandoff) : 'inspect'
  if (recovery !== 'resume') return recovery === 'stop' ? 'EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED' : 'EXPERIMENT_EXECUTION_BUDGET_UNKNOWN'
}

/** Stable outputs may be handed to the next verifier/integrator. This does not
 * certify the outputs: all failed/stale receipts remain in the handoff and the
 * host delivery gates still decide product correctness. */
export function experimentWorkerExecutionFinished(record: DelegationRecord | undefined): boolean {
  return record?.status === 'completed' && record.loopStatus === 'completed' && !workerRecoveryFailure(record)
}

/** Terminal resource facts precede dependencies and retries. Finishing the receipt
 * also prevents the experiment query wrapper from sending another paid request. */
export function assertExperimentWorkerRecovery(config: DispatchExperiment, record: DelegationRecord | undefined): void {
  const reason = workerRecoveryFailure(record)
  if (!reason) return
  finishExperiment(config, 'failed', reason)
  throw new Error(reason)
}

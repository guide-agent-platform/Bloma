import type { DelegationRecord } from '../agent/delegation/agent-collaboration'
import { handoffRecovery } from '../agent/delegation/task-handoff'
import type { DispatchExperiment } from './dispatch-experiment'
import { finishExperiment } from './dispatch-experiment-records'

/** Terminal resource facts precede dependencies and retries. Finishing the receipt
 * also prevents the experiment query wrapper from sending another paid request. */
export function assertExperimentWorkerRecovery(config: DispatchExperiment, record: DelegationRecord | undefined): void {
  if (!record || !(record.loopStatus === 'budget_exhausted' || record.taskHandoff?.verification.some(f => f.category === 'budget'))) return
  const recovery = record.taskHandoff ? handoffRecovery(record.taskHandoff) : 'inspect'
  if (recovery === 'resume') return
  const reason = recovery === 'stop' ? 'EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED' : 'EXPERIMENT_EXECUTION_BUDGET_UNKNOWN'
  finishExperiment(config, 'failed', reason)
  throw new Error(reason)
}

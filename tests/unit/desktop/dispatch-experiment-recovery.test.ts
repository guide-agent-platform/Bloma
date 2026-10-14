import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DispatchExperiment } from '../../../main/desktop/dispatch-experiment'
import type { DelegationRecord } from '../../../main/agent/delegation/agent-collaboration'
import { buildTaskHandoff } from '../../../main/agent/delegation/task-handoff'
import { assertExperimentWorkerRecovery } from '../../../main/desktop/dispatch-experiment-recovery'
import { readExperimentEvents } from '../../../main/desktop/dispatch-experiment-records'
import { bindExperimentInput } from '../../../main/desktop/dispatch-experiment-runtime'
let home: string, original: string | undefined
beforeEach(() => { original = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'exp-recovery-')); process.env.PROMA_HOME = home })
afterEach(() => { if (original === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = original; rmSync(home, { recursive: true, force: true }) })
const config = () => ({ version: 1, project_id: 'p', mode: 'quick', experiment_id: 'recovery', run_id: 'run', state: 'running', tasks: [], workers: {} } as DispatchExperiment)
describe('experiment terminal resource admission', () => {
  it('records an immutable terminal reason and rejects the next binding before model access', () => {
    const c = config(), query = vi.fn()
    const taskHandoff = buildTaskHandoff({ status: 'budget_exhausted', turns: 1, finalText: '', toolCalls: [], tool_feedback: [{ schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget',
      budget: { resource: 'script_runs', scope: 'session', used: 12, limit: 12, remaining: 0, resets_on: 'new_run' } }] })
    const record = { loopStatus: 'budget_exhausted', taskHandoff } as DelegationRecord
    expect(() => assertExperimentWorkerRecovery(c, record)).toThrow('EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED')
    expect(() => assertExperimentWorkerRecovery(c, record)).toThrow('EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED')
    expect(readExperimentEvents(c).events.filter(e => e.event === 'run_finished')).toHaveLength(1)
    expect(() => bindExperimentInput({ query } as never, c, 'implement')).toThrow('EXPERIMENT_ALREADY_FINISHED')
    expect(query).not.toHaveBeenCalled()
  })
  it('does not turn a normal turn-limit continuation into terminal resource failure', () => {
    const c = config()
    expect(() => assertExperimentWorkerRecovery(c, { loopStatus: 'turn_limit', taskHandoff: buildTaskHandoff({ status: 'turn_limit', turns: 1, finalText: '', toolCalls: [] }) } as DelegationRecord)).not.toThrow()
    expect(readExperimentEvents(c).events).toEqual([])
    expect(() => assertExperimentWorkerRecovery(c, { loopStatus: 'budget_exhausted' } as DelegationRecord)).toThrow('EXPERIMENT_EXECUTION_BUDGET_UNKNOWN')
  })
})

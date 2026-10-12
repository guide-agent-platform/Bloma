import { describe, expect, it } from 'vitest'
import { buildTaskHandoff, readTaskHandoff, renderTaskHandoff } from '../../main/agent/delegation/task-handoff'
import { appendDelegationSettle, loadChildSessionSnapshot } from '../../main/agent/delegation/delegation-persistence'
import type { AgentLoopResult } from '../../main/agent/loop/agent-loop'
const base: AgentLoopResult = { status: 'completed', turns: 1, finalText: '已完成', toolCalls: [{ name: 'write_file', turn: 1, path: 'app.py' }], files_changed: ['app.py'] }
describe('host task handoff', () => {
  it('model completion and grace summaries cannot attest target completion', () => {
    expect(buildTaskHandoff(base).completion).toBe('unverified')
    expect(buildTaskHandoff({ ...base, termination_detail: { reason: 'grace_wrap_up' } }).stop_reason).toBe('grace_wrap_up')
  })
  it('planned writes without a committed result are not changed files', () => {
    expect(buildTaskHandoff({ ...base, files_changed: undefined }).changed_files).toEqual([])
  })
  it('records budget stop and failed evidence as unfinished work', () => {
    const h = buildTaskHandoff({ ...base, status: 'turn_limit', tool_feedback: [{ schema_version: 1, execution: 'completed', verification: 'failed', category: 'product_assertion', scope: 'save' }] })
    expect(h.completion).toBe('incomplete')
    expect(h.changed_files).toEqual(['app.py'])
    expect(h.pending.join(' ')).toContain('save')
    expect(renderTaskHandoff(h)).toContain('不是当前版本的通过证明')
  })
  it('persists typed pending work through restart snapshots and rejects malformed metadata', () => {
    const h = buildTaskHandoff({ ...base, status: 'budget_exhausted' })
    appendDelegationSettle('handoff-roundtrip', 'completed', { resultSummary: 'summary', loopStatus: 'budget_exhausted', taskHandoff: h })
    expect(loadChildSessionSnapshot('handoff-roundtrip').lastSettle?.taskHandoff).toEqual(h)
    expect(readTaskHandoff({ schema_version: 1, completion: 'passed' })).toBeUndefined()
  })
})

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
  it('preserves a non-resumable budget fact through host handoff serialization', () => {
    const h = buildTaskHandoff({ ...base, status: 'budget_exhausted', tool_feedback: [{ schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget',
      budget: { resource: 'script_runs', scope: 'session', used: 12, limit: 12, remaining: 0, resets_on: 'new_run' } }] })
    expect(h.recovery).toBe('stop')
    expect(readTaskHandoff(JSON.parse(JSON.stringify(h)))).toEqual(h)
    expect(renderTaskHandoff(h)).toContain('"recovery":"stop"')
    expect(buildTaskHandoff({ ...base, status: 'turn_limit' }).recovery).toBe('resume')
    expect(buildTaskHandoff({ ...base, status: 'budget_exhausted' }).recovery).toBe('inspect')
    const many = [...h.verification, ...Array.from({ length: 12 }, () => ({ schema_version: 1 as const, execution: 'completed' as const, verification: 'not_applicable' as const, scope: 'read' }))]
    const compact = buildTaskHandoff({ ...base, status: 'completed', tool_feedback: many })
    expect(compact.verification).toHaveLength(8)
    expect(compact.recovery).toBe('stop')
    expect(readTaskHandoff(JSON.parse(JSON.stringify(compact)))?.recovery).toBe('stop')
  })
  it('persists typed pending work through restart snapshots and rejects malformed metadata', () => {
    const h = buildTaskHandoff({ ...base, status: 'budget_exhausted' })
    appendDelegationSettle('handoff-roundtrip', 'completed', { resultSummary: 'summary', loopStatus: 'budget_exhausted', taskHandoff: h })
    expect(loadChildSessionSnapshot('handoff-roundtrip').lastSettle?.taskHandoff).toEqual(h)
    expect(readTaskHandoff({ schema_version: 1, completion: 'passed' })).toBeUndefined()
  })
})

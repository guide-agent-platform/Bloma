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
  it('keeps complete file identities and explicitly reports a bounded file list', () => {
    const path = 'nested/'.repeat(30) + 'important.py'
    const h = buildTaskHandoff({ ...base, files_changed: [path, ...Array.from({ length: 25 }, (_, i) => `${i}.py`)] })
    expect(h.omitted_changed_files).toBe(6)
    expect(readTaskHandoff(JSON.parse(JSON.stringify(h)))?.changed_files[0]).toBe(path)
    expect(readTaskHandoff(JSON.parse(JSON.stringify(h)))?.omitted_changed_files).toBe(6)
  })
  it('retains a failed host operation when many later successful receipts fill the handoff', () => {
    const failure = { schema_version: 1 as const, execution: 'failed' as const, verification: 'unverified' as const, category: 'permission' as const, reason: 'WRITE_ROLLED_BACK' }
    const successful = Array.from({ length: 16 }, (_, i) => ({ schema_version: 1 as const, execution: 'completed' as const, verification: 'passed' as const,
      evidence: { key: i.toString(16).padStart(64, '0'), entry: `${i}.py`, source_fingerprint: 'a'.repeat(64), environment_fingerprint: 'b'.repeat(64), freshness: 'current' as const, passed: 1, failed: 0, blocked: 0 } }))
    const h = buildTaskHandoff({ ...base, tool_feedback: [failure, ...successful] })
    expect(h.verification).toHaveLength(8)
    expect(h.verification).toContainEqual(expect.objectContaining({ reason: 'WRITE_ROLLED_BACK' }))
    expect(h.completion).toBe('incomplete')
    expect(h.recovery).toBe('inspect')
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

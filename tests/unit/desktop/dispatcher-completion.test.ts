import { describe, expect, it, vi } from 'vitest'
import { guardDispatcherCompletion } from '../../../main/desktop/dispatcher-completion'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { DelegationRecord } from '../../../main/agent/delegation/agent-collaboration'

const ctx = (): ToolContext => ({ projectId: 'p', sessionId: 'parent', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
function record(): DelegationRecord {
  return { delegationId: 'd', parentSessionId: 'parent', childSessionId: 'c', projectId: 'p', role: 'implement', goal: 'work',
    status: 'running', abort: new AbortController(), startedAt: 0, completion: Promise.resolve(), resolveCompletion: () => {},
    askSignal: { promise: new Promise(() => {}), resolve: () => {} } }
}
describe('dispatcher end response with active work', () => {
  it('awaits the child without cancelling it or deciding advancement on behalf of the model', async () => {
    const child = record(), abort = vi.spyOn(child.abort, 'abort')
    const wait = vi.fn(async () => { child.status = 'completed'; child.loopStatus = 'completed'; return [] })
    const feedback = await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait,
      summary: r => ({ delegation_id: r.delegationId, role: r.role, status: r.status, goal: r.goal, started_at: 0 }) })
    expect(wait).toHaveBeenCalledTimes(1); expect(abort).not.toHaveBeenCalled()
    expect(feedback).toContain('"status":"completed"')
    expect(feedback).toContain('推进标记必须由你依据事实给出')
    expect(await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait, summary: () => { throw Error('not called') } })).toBeUndefined()
  })
  it('surfaces pending questions without busy waiting or inventing an answer', async () => {
    const child = record(); child.pendingQuestion = '请选择'
    const wait = vi.fn(async () => [])
    const feedback = await guardDispatcherCompletion(ctx(), 1000, { list: () => [child], wait,
      summary: r => ({ delegation_id: r.delegationId, role: r.role, status: r.status, goal: r.goal, started_at: 0, pending_question: r.pendingQuestion }) })
    expect(wait).not.toHaveBeenCalled(); expect(feedback).toContain('请选择')
  })
  it('propagates cancellation and reports an exhausted wait deadline', async () => {
    const child = record(), parent = ctx(), abort = new AbortController(); parent.signal = abort.signal
    const wait = vi.fn(async () => { abort.abort(); return [] })
    await expect(guardDispatcherCompletion(parent, 1000, { list: () => [child], wait, summary: () => { throw Error('not called') } })).rejects.toThrow()
    await expect(guardDispatcherCompletion(ctx(), 0, { list: () => [child], wait, summary: () => { throw Error('not called') } })).rejects.toThrow('DISPATCHER_CHILD_COMPLETION_TIMEOUT')
  })
})

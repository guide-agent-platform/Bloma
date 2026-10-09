import { describe, expect, it, vi } from 'vitest'
import { SessionMessageQueue } from '../../main/platform/sessions/message-queue'

describe('composer project queue integration', () => {
  it('waits for the project lock across sessions and dispatches after wakePending', async () => {
    let busy = true
    const run = vi.fn(async (_session: string, _entry: import('../../main/platform/sessions/message-queue').QueueEntry) => {})
    const queue = new SessionMessageQueue({ isActive: (_session, entry) => busy && (entry?.input as { project_id: string })?.project_id === 'p', startRun: run })
    queue.enqueue('other-session', { queueMessageId: 'image-message', userMessage: '', input: { project_id: 'p', images: ['ref'] } })
    expect(run).not.toHaveBeenCalled()
    expect(queue.pendingCount('other-session')).toBe(1)
    busy = false
    queue.wakePending()
    expect(run).toHaveBeenCalledTimes(1)
    expect(run.mock.calls[0][1].input).toEqual({ project_id: 'p', images: ['ref'] })
    await Promise.resolve()
  })
  it('cancels queued attachments across a project before locks are released', () => {
    let busy = true
    const run = vi.fn(async () => {})
    const queue = new SessionMessageQueue({ isActive: () => busy, startRun: run })
    queue.enqueue('one', { queueMessageId: 'one', userMessage: 'one', input: { project_id: 'p' } })
    queue.enqueue('two', { queueMessageId: 'two', userMessage: 'two', input: { project_id: 'p' } })
    queue.cancelWhere((_session, entry) => (entry.input as { project_id: string }).project_id === 'p')
    busy = false; queue.wakePending()
    expect(run).not.toHaveBeenCalled()
    expect(queue.pendingCount('one') + queue.pendingCount('two')).toBe(0)
    queue.enqueue('one', { queueMessageId: 'new', userMessage: 'explicit new message' })
    expect(run).toHaveBeenCalledTimes(1)
  })
})

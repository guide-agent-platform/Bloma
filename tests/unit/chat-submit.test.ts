import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { submitChat } from '../../main/orchestration/stages/chat-submit'
import { importImage } from '../../main/platform/attachments/composer-store'
import { readReceipt } from '../../main/platform/attachments/send-inbox'
import type { ChatSubmitInput } from '../../shared/attachment-types'
const { run, busy, channel, steer } = vi.hoisted(() => ({ run: vi.fn(), busy: vi.fn(() => false), channel: vi.fn(), steer: vi.fn(() => false) }))
vi.mock('../../main/orchestration/stages/agent-dispatch', () => ({ runAgent: run }))
vi.mock('../../main/orchestration/stages/run-registry', () => ({ hasRunForProject: busy }))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: channel }))
vi.mock('../../main/project/project-service', () => ({ findProject: () => ({ current_stage: 'clarifying' }) }))
vi.mock('../../main/platform/sessions/session-service', () => ({ recordSessionActivity: vi.fn(), listSessions: () => ({ sessions: [] }) }))
vi.mock('../../main/agent/loop/steer-queue', () => ({ enqueueSteer: steer, registerSteer: steer, steerConfirmEnabled: () => false }))
const input = (): ChatSubmitInput => ({ request_id: 'request', client_message_id: 'client', project_id: 'p', session_id: 's', draft_id: 'draft', attachment_refs: [], content: 'hello', mode: 'quick', current_stage: 'clarifying' })
beforeEach(() => {
  vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-submit-')))
  run.mockReset(); busy.mockReturnValue(false); channel.mockReturnValue({ env: { MODEL: 'test' } }); steer.mockReturnValue(false)
  run.mockReturnValue(new Promise(() => {}))
})
afterEach(() => vi.unstubAllEnvs())
describe('quick chat acceptance', () => {
  it('returns before the unresolved model run and duplicate retries do not dispatch twice', () => {
    expect(submitChat(input()).status).toBe('accepted')
    expect(readReceipt('client', 's')?.status).toBe('accepted')
    expect(submitChat({ ...input(), request_id: 'retry' }).status).toBe('accepted')
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('rejects no channel and empty input before writing acceptance or dispatching', () => {
    channel.mockReturnValue({})
    expect(() => submitChat(input())).toThrow('NO_USABLE_CHANNEL')
    expect(readReceipt('client', 's')).toBeUndefined()
    channel.mockReturnValue({ env: {} })
    expect(() => submitChat({ ...input(), content: '' })).toThrow('MESSAGE_EMPTY')
    expect(run).not.toHaveBeenCalled()
  })
  it('accepts image-only input, resolves owned snapshots, queues images instead of steering', () => {
    const base = input()
    const info = importImage({ ...base, base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', media_type: 'image/png', name: 'reference.png' })
    busy.mockReturnValue(true)
    expect(submitChat({ ...base, content: '', attachment_refs: [info] }).status).toBe('queued')
    expect(run.mock.calls[0][0].images[0].media_type).toBe('image/png')
    expect(steer).not.toHaveBeenCalled()
  })
  it('preserves the pure-text steer path and catches execution failures separately from acceptance', async () => {
    busy.mockReturnValue(true); steer.mockReturnValue(true)
    expect(submitChat(input()).status).toBe('steered')
    expect(run).not.toHaveBeenCalled()
    busy.mockReturnValue(false); run.mockRejectedValue(new Error('vision unsupported'))
    expect(submitChat({ ...input(), client_message_id: 'second' }).status).toBe('accepted')
    await Promise.resolve()
    expect(readReceipt('second', 's')?.status).toBe('failed')
  })
})

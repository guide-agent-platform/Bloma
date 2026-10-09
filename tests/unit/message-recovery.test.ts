import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { submitChat, resolveMessageReceipt } from '../../main/orchestration/stages/chat-submit'
import { acceptMessage, readReceipt, updateReceipt } from '../../main/platform/attachments/send-inbox'
import type { ChatSubmitInput, MessageRecoveryInput } from '../../shared/attachment-types'

const { run, busy, channel, cancel } = vi.hoisted(() => ({ run: vi.fn(), busy: vi.fn(() => false), channel: vi.fn(), cancel: vi.fn(() => true) }))
vi.mock('../../main/orchestration/stages/agent-dispatch', () => ({ runAgent: run }))
vi.mock('../../main/orchestration/stages/run-registry', () => ({ hasRunForProject: busy, sessionMessageQueue: { cancel } }))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({ resolveChannelEnv: channel }))
vi.mock('../../main/project/project-service', () => ({ findProject: () => ({ current_stage: 'clarifying' }) }))
vi.mock('../../main/platform/sessions/session-service', () => ({ recordSessionActivity: vi.fn(), listSessions: () => ({ sessions: [] }) }))
vi.mock('../../main/agent/loop/steer-queue', () => ({ enqueueSteer: () => false, registerSteer: () => false, steerConfirmEnabled: () => false }))
const message = (): ChatSubmitInput => ({ request_id: 'r', project_id: 'p', session_id: 's', draft_id: 'draft-s', client_message_id: 'client', content: '按当前材料继续', attachment_refs: [], mode: 'quick', current_stage: 'clarifying' })
const action = (operation_id = 'operation-one'): MessageRecoveryInput => ({ request_id: 'r', project_id: 'p', session_id: 's', client_message_id: 'client', operation_id, action: 'resume' })
beforeEach(() => { vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-message-recovery-'))); run.mockReset(); run.mockReturnValue(new Promise(() => {})); busy.mockReturnValue(false); channel.mockReturnValue({ env: {} }); cancel.mockClear() })
afterEach(() => vi.unstubAllEnvs())
describe('explicit durable recovery with lifecycle generations', () => {
  it('retry keeps message identity, increments generation and is idempotent for lost action responses', () => {
    submitChat(message()); updateReceipt('client', 'failed', 'transport error', 1)
    const recovered = resolveMessageReceipt(action())
    expect(recovered.run_generation).toBe(2)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mock.calls[1][0]).toMatchObject({ client_message_id: 'client', request_id: 'client', run_generation: 2 })
    updateReceipt('client', 'failed', 'fast model error', 2)
    expect(resolveMessageReceipt(action()).status).toBe('failed')
    expect(run).toHaveBeenCalledTimes(2)
    resolveMessageReceipt(action('another-explicit-action'))
    expect(run).toHaveBeenCalledTimes(3)
  })
  it('late termination from an older generation cannot overwrite the recovered run', async () => {
    let failOld!: (error: Error) => void
    run.mockReturnValueOnce(new Promise((_resolve, reject) => { failOld = reject }))
    submitChat(message()); updateReceipt('client', 'cancelled', undefined, 1)
    resolveMessageReceipt(action())
    failOld(new Error('old transport ended late')); await Promise.resolve()
    updateReceipt('client', 'completed', undefined, 1)
    expect(readReceipt('client', 's')).toMatchObject({ status: 'accepted', run_generation: 2 })
  })
  it('restart exposes uncertain running work but performs no automatic dispatch; explicit choice starts once', async () => {
    acceptMessage(message(), false); updateReceipt('client', 'running', undefined, 1)
    vi.resetModules()
    const freshInbox = await import('../../main/platform/attachments/send-inbox')
    const freshSubmit = await import('../../main/orchestration/stages/chat-submit')
    expect(freshInbox.readReceipt('client', 's')).toMatchObject({ status: 'needs_recovery', recovery_may_repeat: true })
    expect(run).not.toHaveBeenCalled()
    freshSubmit.resolveMessageReceipt(action()); freshSubmit.resolveMessageReceipt(action())
    expect(run).toHaveBeenCalledTimes(1)
    expect(freshInbox.readReceipt('client', 's')?.run_generation).toBe(2)
  })
  it('withdraws a queued message through the existing coordinator without executing or discarding materials', () => {
    acceptMessage(message(), true)
    const receipt = resolveMessageReceipt({ ...action(), action: 'cancel' })
    expect(receipt.status).toBe('cancelled')
    expect(cancel).toHaveBeenCalledWith('s', 'client')
    expect(run).not.toHaveBeenCalled()
  })
  it('completed messages and busy live submissions cannot be started twice; absent channel retains recoverable record', () => {
    acceptMessage(message(), false); updateReceipt('client', 'failed', 'error', 1)
    channel.mockReturnValue({})
    expect(() => resolveMessageReceipt(action())).toThrow('NO_USABLE_CHANNEL')
    expect(readReceipt('client', 's')?.status).toBe('failed')
    channel.mockReturnValue({ env: {} }); updateReceipt('client', 'completed', undefined, 1)
    expect(resolveMessageReceipt(action()).status).toBe('completed')
    expect(run).not.toHaveBeenCalled()
    expect(() => resolveMessageReceipt({ ...action(), project_id: 'other' })).toThrow('MESSAGE_SCOPE')
  })
})

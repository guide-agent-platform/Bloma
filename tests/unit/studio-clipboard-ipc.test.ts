import { describe, expect, it, vi, beforeEach } from 'vitest'
import { registerClipboardIpc } from '../../main/ipc/clipboard'
import { IPC_CHANNELS } from '../../shared/types'
const writes = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ clipboard: { writeText: writes } }))
beforeEach(() => writes.mockClear())
function handler() { let callback: any; registerClipboardIpc({ handle: (channel: string, fn: any) => { expect(channel).toBe(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT); callback = fn } } as never); return callback }
describe('desktop clipboard IPC', () => {
  it('writes validated text and returns success after the native write', async () => {
    const result = await handler()({}, { request_id: 'copy', text: '界面准备好了' })
    expect(result).toMatchObject({ ok: true, data: { copied: true } })
    expect(writes).toHaveBeenCalledWith('界面准备好了')
  })
  it('rejects nontext and oversized payloads without native writes', async () => {
    const call = handler()
    expect((await call({}, { request_id: 'copy', text: { nested: 'bad' } })).ok).toBe(false)
    expect((await call({}, { request_id: 'copy', text: 'x'.repeat(1_000_001) })).ok).toBe(false)
    expect(writes).not.toHaveBeenCalled()
  })
})

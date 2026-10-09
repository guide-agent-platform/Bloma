// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageComposer } from '../../renderer/components/MessageComposer'
import { activeAgentSessionIdAtom, currentProjectAtom } from '../../renderer/agent-atoms'
import { composerDraftFamily, draftKey } from '../../renderer/composer-state'
import type { AttachmentInfo, ComposerDraft, SendReceipt } from '../../shared/attachment-types'
import type { ElectronAPI } from '../../shared/types'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
let store: ReturnType<typeof createStore>
let drafts: Map<string, ComposerDraft>
let importMock: ReturnType<typeof vi.fn>
const scope = { project_id: 'p', session_id: 's', draft_id: 'draft-s' }
beforeEach(() => {
  store = createStore(); drafts = new Map()
  store.set(activeAgentSessionIdAtom, 's'); store.set(currentProjectAtom, { project_id: 'p' } as never)
  importMock = vi.fn(async (input) => ({ ok: true, data: { ...scope, ...input, attachment_id: 'image-one', bytes: 20, sha256: 'hash', status: 'ready' } }))
  window.electronAPI = { composer: {
    load: vi.fn(async input => ({ ok: true, data: drafts.get(input.draft_id) ?? { ...input, text: '', attachment_refs: [], revision: 0 } })),
    save: vi.fn(async ({ draft }) => { drafts.set(draft.draft_id, structuredClone(draft)); return { ok: true, data: draft } }),
    importImage: importMock,
    preview: vi.fn(async () => ({ ok: true, data: { info: { name: '参考' }, dataUrl: `data:image/png;base64,${png}` } })),
  } } as unknown as ElectronAPI
})
afterEach(() => { cleanup(); delete window.electronAPI })
function mount(send = vi.fn()) {
  return render(<Provider store={store}><MessageComposer onSendMessage={send} busy={false} /></Provider>)
}
function paste() {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0))
  Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => new File([bytes], 'reference.png', { type: 'image/png' }) }] } })
  fireEvent(screen.getByRole('textbox'), event)
}
describe('persistent MessageComposer', () => {
  it('does not clear a new draft revision even when the user edits back to the same text', async () => {
    let acknowledge!: (receipt: SendReceipt) => void
    const send = vi.fn(() => new Promise<SendReceipt>(resolve => { acknowledge = resolve }))
    mount(send)
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'same text' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'edited' } })
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'same text' } })
    await act(async () => acknowledge({ client_message_id: 'one', request_id: 'r', session_id: 's', status: 'accepted' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('same text')
  })
  it('waits for acceptance and keeps edits made during the pending send', async () => {
    let acknowledge!: (receipt: SendReceipt) => void
    const send = vi.fn(() => new Promise<SendReceipt>(resolve => { acknowledge = resolve }))
    mount(send)
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'first' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('first')
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'next input' } })
    await act(async () => acknowledge({ client_message_id: 'one', request_id: 'r', session_id: 's', status: 'accepted' }))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('next input')
  })
  it('retains failed sending snapshot and retries with the same stable identity', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ status: 'accepted' })
    mount(send)
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'keep me' } })
    fireEvent.click(screen.getByLabelText('发送消息'))
    await screen.findByText('response lost')
    const id = send.mock.calls[0][2].client_message_id
    expect(drafts.get('draft-s')?.pending_send?.client_message_id).toBe(id)
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    expect(send.mock.calls[1][2].client_message_id).toBe(id)
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(''))
  })
  it('image-only messages can send and remount reconstructs image preview from persisted refs', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'accepted' })
    const mounted = mount(send)
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    paste()
    await screen.findByLabelText('移除图片 1')
    mounted.unmount()
    // A fresh renderer store simulates a restart; backend drafts still exist.
    store = createStore(); store.set(activeAgentSessionIdAtom, 's'); store.set(currentProjectAtom, { project_id: 'p' } as never)
    mount(send)
    await screen.findByAltText('粘贴图片 1')
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0]).toBe('')
    expect(send.mock.calls[0][2].draft.attachment_refs).toEqual([{ attachment_id: 'image-one' }])
  })
  it('async import finishing after session switch writes only the original draft', async () => {
    let finish!: (result: unknown) => void
    importMock.mockReturnValue(new Promise(resolve => { finish = resolve }))
    mount()
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    paste()
    await waitFor(() => expect(importMock).toHaveBeenCalled())
    act(() => { store.set(activeAgentSessionIdAtom, 'other'); store.set(currentProjectAtom, { project_id: 'other-project' } as never) })
    await act(async () => finish({ ok: true, data: { ...scope, attachment_id: 'image-one', name: '参考', media_type: 'image/png', status: 'ready' } as AttachmentInfo }))
    expect(store.get(composerDraftFamily(draftKey(scope))).attachment_refs).toHaveLength(1)
    expect(screen.queryByLabelText('移除图片 1')).toBeNull()
    expect(drafts.get('draft-s')?.attachment_refs).toHaveLength(1)
  })
  it('switching sessions isolates text and returning restores it', async () => {
    mount()
    await waitFor(() => expect(window.electronAPI!.composer.save).toHaveBeenCalled())
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'session s draft' } })
    act(() => store.set(activeAgentSessionIdAtom, 'other'))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    act(() => store.set(activeAgentSessionIdAtom, 's'))
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('session s draft')
  })
})

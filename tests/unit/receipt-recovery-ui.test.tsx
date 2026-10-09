// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { MessageReceipts } from '../../renderer/components/MessageReceipts'
import { MessageComposer } from '../../renderer/components/MessageComposer'
import { composerDraftFamily, composerLoadedFamily } from '../../renderer/composer-state'
import { activeAgentSessionIdAtom, currentProjectAtom } from '../../renderer/agent-atoms'
import type { ComposerDraft } from '../../shared/attachment-types'
import type { ElectronAPI } from '../../shared/types'

let store: ReturnType<typeof createStore>
const scope = { project_id: 'p', session_id: 's', draft_id: 'draft-s' }
const savedInput = { ...scope, client_message_id: 'client', request_id: 'r', content: '读取原材料', attachment_refs: [], mode: 'quick', current_stage: 'clarifying' }
let recover: ReturnType<typeof vi.fn>
beforeEach(() => {
  store = createStore(); store.set(currentProjectAtom, { project_id: 'p' } as never); store.set(activeAgentSessionIdAtom, 's')
  recover = vi.fn()
  window.electronAPI = { composer: {
    receipts: async () => ({ ok: true, data: [{ input: savedInput, receipt: { client_message_id: 'client', request_id: 'r', session_id: 's', status: 'needs_recovery', recovery_may_repeat: true, run_generation: 1 } }] }),
    recover,
  } } as unknown as ElectronAPI
})
afterEach(() => { cleanup(); delete window.electronAPI })
describe('explicit recovery UI and acknowledgement restoration', () => {
  it('shows the uncertain-execution explanation and never resumes automatically', async () => {
    render(<Provider store={store}><MessageReceipts sessionId="s" /></Provider>)
    await screen.findByRole('button', { name: '继续执行' })
    expect(screen.getByText(/此前可能已部分执行/)).toBeTruthy()
    expect(recover).not.toHaveBeenCalled()
  })
  it('lost recovery response retries the same operation identity and keeps the control available', async () => {
    recover.mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ ok: true, data: { client_message_id: 'client', request_id: 'r', session_id: 's', status: 'accepted', run_generation: 2 } })
    render(<Provider store={store}><MessageReceipts sessionId="s" /></Provider>)
    fireEvent.click(await screen.findByRole('button', { name: '继续执行' }))
    await screen.findByText('response lost')
    fireEvent.click(screen.getByRole('button', { name: '继续执行' }))
    await waitFor(() => expect(recover).toHaveBeenCalledTimes(2))
    expect(recover.mock.calls[0][0].operation_id).toBe(recover.mock.calls[1][0].operation_id)
    expect(recover.mock.calls[0][0].client_message_id).toBe('client')
  })
  it('acknowledgement after recovery removes only the pending snapshot and preserves newer input', async () => {
    const draft: ComposerDraft = { ...scope, text: 'newer input', revision: 3, attachment_refs: [], pending_send: { client_message_id: 'client', text: 'old input', attachment_refs: [], revision: 1, composer_revision: 2 } }
    store.set(composerDraftFamily('p|s'), draft); store.set(composerLoadedFamily('p|s'), true)
    window.electronAPI = { composer: {
      save: async (input: { draft: ComposerDraft }) => ({ ok: true, data: input.draft }),
      receipt: async () => ({ ok: true, data: { client_message_id: 'client', request_id: 'r', session_id: 's', status: 'running', run_generation: 2 } }),
    } } as unknown as ElectronAPI
    render(<Provider store={store}><MessageComposer busy={false} /></Provider>)
    await waitFor(() => expect(store.get(composerDraftFamily('p|s')).pending_send).toBeUndefined())
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('newer input')
  })
})

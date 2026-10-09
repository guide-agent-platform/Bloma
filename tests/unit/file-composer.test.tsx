// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MessageComposer } from '../../renderer/components/MessageComposer'
import { currentProjectAtom, activeAgentSessionIdAtom } from '../../renderer/agent-atoms'
import type { AttachmentInfo, AttachmentPreview, ComposerDraft } from '../../shared/attachment-types'
import type { ElectronAPI } from '../../shared/types'
let store: ReturnType<typeof createStore>
let importFile: ReturnType<typeof vi.fn>
let draft: ComposerDraft
const infos = new Map<string, AttachmentInfo>()
const scope = { project_id: 'p', session_id: 's', draft_id: 'draft-s' }
beforeEach(() => {
  infos.clear(); store = createStore(); store.set(currentProjectAtom, { project_id: 'p' } as never); store.set(activeAgentSessionIdAtom, 's')
  draft = { ...scope, text: '', attachment_refs: [], revision: 0 }
  importFile = vi.fn(async input => {
    const info: AttachmentInfo = { ...scope, attachment_id: 'file-' + infos.size, name: input.name, media_type: 'text/plain', kind: 'text', bytes: 120, sha256: 'testhash', line_count: 2, encoding: 'utf-8', status: 'ready' }
    infos.set(info.attachment_id, info)
    return { ok: true, data: info }
  })
  window.electronAPI = { composer: {
    load: async () => ({ ok: true, data: draft }), save: async (input: { draft: ComposerDraft }) => { draft = input.draft; return { ok: true, data: draft } }, importImage: importFile,
    preview: async (input: { attachment_id: string }) => ({ ok: true, data: { info: infos.get(input.attachment_id), page: { attachment_id: input.attachment_id, sha256: 'testhash', text: '<script>window.bad=true</script>\nsettlement_currency', total_lines: 2, start_line: 1, end_line: 2, truncated: false } } }),
  } } as unknown as ElectronAPI
})
afterEach(() => { cleanup(); delete window.electronAPI })
function mount(send = vi.fn().mockResolvedValue({ status: 'accepted' })) { render(<Provider store={store}><MessageComposer busy={false} onSendMessage={send} /></Provider>); return send }
describe('file composer entry points', () => {
  it('selects and removes a UTF-8 file; preview shows HTML literally without execution', async () => {
    mount()
    fireEvent.change(screen.getByLabelText('选择附件文件'), { target: { files: [new File(['<script>bad</script>'], 'reference.html', { type: 'text/html' })] } })
    await screen.findByLabelText('移除文件 1')
    expect(importFile.mock.calls[0][0].name).toBe('reference.html')
    fireEvent.click(screen.getByText(/reference.html/))
    await screen.findByRole('dialog')
    expect(screen.getByText(/window.bad=true/)).toBeTruthy()
    expect(document.querySelector('section script')).toBeNull()
    fireEvent.click(screen.getByText('关闭预览')); fireEvent.click(screen.getByLabelText('移除文件 1'))
    expect(screen.queryByLabelText('移除文件 1')).toBeNull()
  })
  it('drop and paste share the same importer and file-only submission carries both refs', async () => {
    const send = mount()
    const file = new File(['amount,currency\n12.50,CNY'], 'sample.csv', { type: 'text/csv' })
    fireEvent.drop(screen.getByRole('textbox').parentElement!.parentElement!, { dataTransfer: { types: ['Files'], files: [file] } })
    await screen.findByLabelText('移除文件 1')
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => new File(['需求'], 'requirements.md', { type: 'text/plain' }) }] } })
    fireEvent(screen.getByRole('textbox'), event)
    await screen.findByLabelText('移除文件 2')
    fireEvent.click(screen.getByLabelText('发送消息'))
    await waitFor(() => expect(send).toHaveBeenCalled())
    expect(send.mock.calls[0][0]).toBe('')
    expect(send.mock.calls[0][2].draft.attachment_refs).toHaveLength(2)
  })
  it('unsupported file or failed import never silently turns a materials request into a text-only send', async () => {
    const send = mount()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'use my document' } })
    fireEvent.change(screen.getByLabelText('选择附件文件'), { target: { files: [new File(['PDF'], 'requirements.pdf', { type: 'application/pdf' })] } })
    await screen.findByRole('alert')
    expect(importFile).not.toHaveBeenCalled()
    fireEvent.click(screen.getByLabelText('发送消息')); expect(send).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('use my document')
  })
})

// @vitest-environment jsdom
import React from 'react'
import { createStore, Provider } from 'jotai'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { MessageComposer } from '../../renderer/components/MessageComposer'
import { activeAgentSessionIdAtom, currentProjectAtom, agentMessagesFamily } from '../../renderer/agent-atoms'
import { composerDraftFamily, composerScopeAtom, draftKey } from '../../renderer/composer-state'
import { isInternalMessage, assistantDisplayText } from '../../shared/message-presentation'
import { restartDiscussion } from '../../renderer/lib/restart-discussion'
import { sketchFitScale } from '../../renderer/components/SketchViewport'
import type { AgentMessage, ElectronAPI } from '../../shared/types'

afterEach(() => { cleanup(); delete window.electronAPI })
function fixture() {
  const store = createStore(); store.set(activeAgentSessionIdAtom, 'studio-actions'); store.set(currentProjectAtom, { project_id: 'p', mode: 'longterm' } as never)
  store.set(agentMessagesFamily('studio-actions'), [
    { role: 'user', id: 'human-entry', origin: 'user', content: [{ type: 'text', text: '输入材料后生成方案' }], timestamp: 1 },
    { role: 'user', origin: 'system', content: [{ type: 'text', text: '【收口指令（宿主注入）】grep已停用' }], timestamp: 2 },
    { role: 'assistant', content: [{ type: 'text', text: '界面已准备好。\nPHASE_ADVANCE: desktop-implement' }], timestamp: 3 },
  ])
  Element.prototype.scrollIntoView = vi.fn()
  return store
}
describe('studio message actions and origin', () => {
  it('host controls never become user bubbles or fork anchors; explicit human quotations remain visible', () => {
    const store = fixture()
    render(<Provider store={store}><ChatPanel presentation="theatre" onForkFromMessage={vi.fn()} /></Provider>)
    expect(screen.queryByText(/grep已停用/)).toBeNull()
    expect(document.body.textContent).not.toContain('PHASE_ADVANCE')
    fireEvent.click(screen.getByRole('button', { name: /完整对话/ }))
    expect(screen.getAllByRole('button', { name: '从这里重新来' })).toHaveLength(1)
    expect(isInternalMessage({ role: 'user', origin: 'user', content: [{ type: 'text', text: '【收口指令（宿主注入）】这是我引用的例子' }], timestamp: 1 })).toBe(false)
    expect(assistantDisplayText('当前结果\nPHASE_ADVANCE: delivered')).toBe('当前结果')
  })

  it('copy awaits the desktop bridge and gives success, or a visible retryable failure', async () => {
    const copy = vi.fn().mockResolvedValueOnce({ ok: true, data: { copied: true } }).mockRejectedValueOnce(new Error('复制失败，请重试'))
    window.electronAPI = { clipboard: { writeText: copy } } as unknown as ElectronAPI
    render(<Provider store={fixture()}><ChatPanel presentation="theatre" /></Provider>)
    fireEvent.click(screen.getAllByRole('button', { name: '复制' }).at(-1)!)
    await screen.findByRole('button', { name: '已复制' })
    expect(copy).toHaveBeenCalledWith(expect.objectContaining({ text: '界面已准备好。' }))
    fireEvent.click(screen.getByRole('button', { name: /完整对话/ }))
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0])
    expect((await screen.findByRole('alert')).textContent).toContain('复制失败')
  })

  it('fork errors are visible; a successful branch request targets the real current project and original entry', async () => {
    const message: AgentMessage = { role: 'user', origin: 'user', id: 'entry', timestamp: 5, content: [{ type: 'text', text: '修改要求' }] }
    const fork = vi.fn(async () => ({ ok: true, data: { new_session_id: 'branch' } }))
    expect(await restartDiscussion({ forkSession: fork } as never, 'actual-project', 'source', message)).toEqual({ sessionId: 'branch', text: '修改要求' })
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'actual-project', session_id: 'source', entry_id: 'entry', entry_timestamp: 5 }))
    await expect(restartDiscussion({ forkSession: fork } as never, undefined, 'source', message)).rejects.toThrow('通道不可用')
    const callback = vi.fn(async () => { throw new Error('当前任务仍在运行，请稍后重试') })
    render(<Provider store={fixture()}><ChatPanel presentation="theatre" onForkFromMessage={callback} /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /完整对话/ }))
    fireEvent.click(screen.getByRole('button', { name: '从这里重新来' }))
    expect((await screen.findByRole('alert')).textContent).toContain('仍在运行')
  })

  it('a seeded branch draft survives an older empty draft arriving from storage', async () => {
    const store = fixture(); const scope = store.get(composerScopeAtom); const atom = composerDraftFamily(draftKey(scope))
    store.set(atom, { ...store.get(atom), text: '需要编辑后再发送的原要求', revision: 1 })
    window.electronAPI = { composer: { load: async () => ({ ok: true, data: { ...scope, text: '', attachment_refs: [], revision: 0 } }), save: async () => ({ ok: true, data: { saved: true } }) } } as unknown as ElectronAPI
    render(<Provider store={store}><MessageComposer busy={false} /></Provider>)
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('需要编辑后再发送的原要求'))
    expect(store.get(atom).text).toBe('需要编辑后再发送的原要求')
  })

  it('short window height does not shrink a whole tall page into unreadable text', () => {
    expect(sketchFitScale(1280, 200)).toBe(1)
    expect(sketchFitScale(640, 200)).toBe(.5)
    expect(sketchFitScale(640, 200, true)).toBe(1)
  })
})

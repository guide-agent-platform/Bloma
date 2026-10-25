// @vitest-environment jsdom
import React from 'react'
import { createStore } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ScopeConfirmationPanel } from '../../renderer/components/ScopeConfirmationPanel'
import { loadSessionHistory, agentStreamStateFamily, activeAgentSessionIdAtom, previewUrlsAtom } from '../../renderer/agent-atoms'
import type { ElectronAPI } from '../../shared/types'
afterEach(() => { cleanup(); delete window.electronAPI; delete window.__jotai_store__ })
it('shows readable structured goals and acceptance in the main panel without developer feature ids', () => {
  const select = vi.fn()
  render(<ScopeConfirmationPanel scope={{ goal: '课程笔记', usage: '在本机浏览器使用', features: [{ id: 'F-001', description: '自动保存', expected: '重开后仍保留' }], constraints: ['无需联网'], out_of_scope: ['账号'] }}
    options={[{ id: 'confirm', label: '按这份做' }]} onSelect={select} busy={false} />)
  expect(screen.getByText('自动保存')).toBeTruthy(); expect(screen.getByText('重开后仍保留')).toBeTruthy()
  expect(screen.queryByText('F-001')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '按这份做' })); expect(select).toHaveBeenCalledWith(expect.objectContaining({ id: 'confirm' }))
})
it('loads a pending decision and its preview without sending a new agent message', async () => {
  const store = createStore(); window.__jotai_store__ = store; store.set(activeAgentSessionIdAtom, 's')
  const send = vi.fn()
  window.electronAPI = { agent: { sendMessage: send, loadMessages: async () => ({ ok: true, request_id: 'r', data: { session: {}, messages: [], total: 0, truncated: false,
    pending_decision: { project_id: 'p', payload: { kind: 'ux_confirm', questions: [{ id: 'ux_confirm_go', label: '确认草图，开工' }] }, preview_url: 'bloma-file://p/00_UX/ux-sketch.html' } } }) } } as unknown as ElectronAPI
  await loadSessionHistory('s')
  expect(store.get(agentStreamStateFamily('s')).events.at(-1)?.payload.kind).toBe('ux_confirm')
  expect(store.get(previewUrlsAtom).p.url).toContain('bloma-file:'); expect(send).not.toHaveBeenCalled()
})
it('does not replace a live newer decision with a late history snapshot', async () => {
  const store = createStore(); window.__jotai_store__ = store; store.set(activeAgentSessionIdAtom, 's')
  let release!: (value: unknown) => void
  window.electronAPI = { agent: { loadMessages: () => new Promise(resolve => { release = resolve }) } } as unknown as ElectronAPI
  const loading = loadSessionHistory('s')
  store.set(agentStreamStateFamily('s'), { running: false, content: '', events: [{ event_id: 'new', session_id: 's', project_id: 'p', type: 'user_decision_required', payload: { kind: 'ux_confirm' }, created_at: new Date().toISOString() }] })
  release({ ok: true, request_id: 'r', data: { session: {}, messages: [], total: 0, truncated: false, pending_decision: { project_id: 'p', payload: { kind: 'lean_scope' } } } })
  await loading
  expect(store.get(agentStreamStateFamily('s')).events.at(-1)?.payload.kind).toBe('ux_confirm')
})

// @vitest-environment jsdom
import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentMessagesFamily, delegationsFamily, loadSessionHistory } from '../../renderer/agent-atoms'
import type { AgentLoadMessagesResult, ElectronAPI } from '../../shared/types'

afterEach(() => { delete window.electronAPI; delete window.__jotai_store__ })

describe('project history hydration', () => {
  it('loads beyond the initial tail and restores collaboration after a fresh renderer mount', async () => {
    const store = createStore(); window.__jotai_store__ = store
    const first = { role: 'user' as const, id: 'initial-request', timestamp: 1, content: [{ type: 'text' as const, text: '原始需求' }] }
    const last = { role: 'assistant' as const, id: 'last-reply', timestamp: 400, content: [{ type: 'text' as const, text: '后续实现' }] }
    const response = (data: Partial<AgentLoadMessagesResult>) => ({ ok: true, data })
    const loadMessages = vi.fn().mockResolvedValueOnce(response({ messages: [last], total: 400, truncated: true }))
      .mockResolvedValueOnce(response({ messages: [first, last], total: 400, truncated: false,
        delegations: [{ delegation_id: 'd1', child_session_id: 'child', role: 'implement', goal: '实现资料导入', status: 'cancelled' }] }))
    window.electronAPI = { agent: { loadMessages } } as unknown as ElectronAPI
    await loadSessionHistory('latest-main')
    expect(loadMessages.mock.calls[1][0]).toMatchObject({ limit: 400, include_project_history: true })
    expect(store.get(agentMessagesFamily('latest-main')).map(m => m.id)).toEqual(['initial-request', 'last-reply'])
    expect(store.get(delegationsFamily('latest-main'))[0]).toMatchObject({ goal: '实现资料导入', status: 'cancelled' })
  })

  it('does not erase an in-flight message or resurrect a delegation settled while IPC was pending', async () => {
    const store = createStore(); window.__jotai_store__ = store
    let resolve!: (value: unknown) => void
    window.electronAPI = { agent: { loadMessages: () => new Promise(r => { resolve = r }) } } as unknown as ElectronAPI
    const loading = loadSessionHistory('running')
    store.set(agentMessagesFamily('running'), [{ id: 'live', role: 'assistant', timestamp: 20, content: [{ type: 'text', text: '新收到的回复' }] }])
    store.set(delegationsFamily('running'), [{ delegation_id: 'd', child_session_id: 'child', role: 'review', goal: '检查', status: 'completed' }])
    resolve({ ok: true, data: { messages: [{ id: 'old', role: 'user', timestamp: 10, content: [{ type: 'text', text: '旧请求' }] }], total: 1, truncated: false,
      delegations: [{ delegation_id: 'd', child_session_id: 'child', role: 'review', goal: '检查', status: 'unknown' }] } })
    await loading
    expect(store.get(agentMessagesFamily('running')).map(m => m.id)).toEqual(['old', 'live'])
    expect(store.get(delegationsFamily('running'))[0].status).toBe('completed')
  })
})

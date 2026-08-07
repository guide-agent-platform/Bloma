// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../renderer/components/App'
import type {
  AgentLoadMessagesResult,
  AgentSessionRecord,
  ElectronAPI,
  Project,
} from '../../../shared/types'

describe('Sprint 1 session history recovery acceptance', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S1-STORE-003] 回访恢复应按 last_session_id 加载历史消息并进入工作区', async () => {
    const store = createStore()
    const restored = project()
    const sessionRecord: AgentSessionRecord = {
      session_id: restored.last_session_id!,
      project_id: restored.project_id,
      status: 'active',
      jsonl_path: 'C:/role-c/history-session.jsonl',
      created_at: '2026-07-25T00:00:00.000Z',
      updated_at: '2026-07-25T00:00:00.000Z',
    }
    const listSessions = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'recover-list-sessions',
      data: { sessions: [sessionRecord] },
    })
    const loadMessages = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'recover-load-messages',
      data: {
        session: sessionRecord,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '帮我做一个记账本' }],
            timestamp: Date.now(),
          },
          {
            role: 'assistant',
            content: [{ type: 'text', text: '上次聊到一半的内容' }],
            timestamp: Date.now(),
          },
        ],
        total: 2,
        truncated: false,
      } satisfies AgentLoadMessagesResult,
    })

    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'recover-list-projects', data: [restored] }),
      },
      agent: { listSessions, loadMessages },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)

    // 历史消息从磁盘灌入会话并展示
    expect(await screen.findByText('上次聊到一半的内容')).toBeTruthy()
    expect(screen.getByText('帮我做一个记账本')).toBeTruthy()
    // 恢复用的是项目记录的最后活跃会话，不是新建的会话 id
    expect(loadMessages).toHaveBeenCalledWith(expect.objectContaining({ session_id: restored.last_session_id }))
    expect(listSessions).toHaveBeenCalledWith(expect.objectContaining({ project_id: restored.project_id }))
  })

  it('[S1-STORE-004] 无 last_session_id 时应优雅进入工作区且不请求历史', async () => {
    const store = createStore()
    const restored = project()
    delete restored.last_session_id
    const listSessions = vi.fn()
    const loadMessages = vi.fn()

    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'recover-no-session', data: [restored] }),
      },
      agent: { listSessions, loadMessages },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(loadMessages).not.toHaveBeenCalled()
    expect(listSessions).not.toHaveBeenCalled()
  })
})

function project(): Project {
  return {
    project_id: 'role-c-history-project',
    workspace_slug: 'default-software-builder',
    name: '历史项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'sketch_ready',
    root_path: 'C:/role-c/history',
    last_session_id: 'role-c-history-session',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  }
}

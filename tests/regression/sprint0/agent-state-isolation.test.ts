// @vitest-environment jsdom

import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'
import {
  agentStreamStateFamily,
  pendingPermissionRequestsAtom,
  setupGlobalAgentListeners,
} from '../../../renderer/agent-atoms'

describe('Sprint 0 agent state isolation regression', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S0-UI-001] 全局监听器应按 session 隔离并持续保存流事件和权限请求', () => {
    const store = createStore()
    let listener: ((event: AgentEvent) => void) | undefined
    const unsubscribe = vi.fn()
    window.__jotai_store__ = store
    window.electronAPI = {
      agent: {
        onStreamEvent: (next: (event: AgentEvent) => void) => {
          listener = next
          return unsubscribe
        },
      },
    } as unknown as ElectronAPI

    const cleanup = setupGlobalAgentListeners()
    listener?.(event('session-a', 'message_delta', { text: 'A' }))
    listener?.(event('session-b', 'message_delta', { text: 'B' }))
    listener?.(event('session-a', 'permission_requested', {
      request: {
        id: 'permission-1',
        session_id: 'session-a',
        tool_name: 'write_file',
        tool_input: {},
        danger_level: 'warning',
        user_visible_summary: '写入项目文件',
        created_at: new Date().toISOString(),
      },
    }))

    expect(store.get(agentStreamStateFamily('session-a')).content).toBe('A')
    expect(store.get(agentStreamStateFamily('session-b')).content).toBe('B')
    expect(store.get(pendingPermissionRequestsAtom).get('session-a')).toHaveLength(1)
    expect(store.get(pendingPermissionRequestsAtom).has('session-b')).toBe(false)

    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

function event(sessionId: string, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: sessionId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

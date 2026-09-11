// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  agentStreamStateFamily,
  setupGlobalAgentListeners,
} from '../../../renderer/agent-atoms'
import { useUserDecisionCards } from '../../../renderer/components/ChatPanel-sprint2'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'

/**
 * T6 ①/③ 前台验收：
 * - ① 生成期间不锁 UI——A 项目后台生成时用户可切去 B 项目浏览；A 的流式消息
 *   在后台继续累积，B 的界面不被 A 的事件污染。
 * - ③ 待决策不沉底——切走项目时决策卡隐藏，切回原项目后待决策请求被找回、
 *   决策卡重新出现（后端以项目存储阶段为持久依据，渲染端以会话事件找回）。
 */

function event(
  sessionId: string,
  projectId: string,
  type: AgentEvent['type'],
  payload: Record<string, unknown> = {},
): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: sessionId,
    project_id: projectId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

function makeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

describe('T6 后台执行 + 待决策找回（渲染端验收）', () => {
  afterEach(() => {
    delete window.__jotai_store__
    delete window.electronAPI
  })

  it('① 生成期间可切换项目：A 后台继续累积，B 界面不受污染', () => {
    const store = createStore()
    let listener: ((event: AgentEvent) => void) | undefined
    window.__jotai_store__ = store
    window.electronAPI = {
      agent: {
        onStreamEvent: (next: (event: AgentEvent) => void) => {
          listener = next
          return () => undefined
        },
      },
    } as unknown as ElectronAPI
    const cleanup = setupGlobalAgentListeners()

    act(() => {
      store.set(activeAgentSessionIdAtom, 'session-a')
    })

    // A 项目生成中：流式消息陆续到达，界面有内容
    act(() => {
      listener?.(event('session-a', 'project-a', 'message_delta', { text: '正在生成' }))
    })
    expect(store.get(agentStreamStateFamily('session-a')).content).toBe('正在生成')

    // 生成期间切去 B 项目：B 无任何 A 的内容
    act(() => {
      store.set(activeAgentSessionIdAtom, 'session-b')
    })
    expect(store.get(agentStreamStateFamily('session-b')).content).toBe('')
    expect(store.get(agentMessagesFamily('session-b'))).toEqual([])

    // A 在后台继续跑，消息继续累积；B 依然干净
    act(() => {
      listener?.(event('session-a', 'project-a', 'message_delta', { text: '…草图好了' }))
    })
    expect(store.get(agentStreamStateFamily('session-a')).content).toBe('正在生成…草图好了')
    expect(store.get(agentStreamStateFamily('session-b')).content).toBe('')

    // 切回 A：后台累积的内容原样在
    act(() => {
      store.set(activeAgentSessionIdAtom, 'session-a')
    })
    expect(store.get(agentStreamStateFamily('session-a')).content).toBe('正在生成…草图好了')

    cleanup()
  })

  it('③ 切走项目后待决策请求可被找回，切回原项目决策卡重新出现', () => {
    const store = createStore()
    window.__jotai_store__ = store
    store.set(activeAgentSessionIdAtom, 'session-a')
    store.set(agentStreamStateFamily('session-a'), {
      running: false,
      content: '', thinking: '',
      events: [
        event('session-a', 'project-a', 'user_decision_required', {
          kind: 'blocked',
          title: '缺了按月统计功能',
          questions: [
            { id: 'continue', label: '继续修复', description: '再试一次' },
            { id: 'accept', label: '接受现状' },
          ],
        }),
      ],
    })

    const wrapper = makeWrapper(store)
    const { result } = renderHook(() => useUserDecisionCards(), { wrapper })

    // 在 A 项目：待决策卡片可见
    expect(result.current?.options).toHaveLength(2)
    expect(result.current?.title).toContain('缺了按月统计功能')

    // 切去 B 项目：A 的待决策不污染 B（卡片消失，B 没有自己的待决策）
    act(() => {
      store.set(activeAgentSessionIdAtom, 'session-b')
    })
    expect(result.current).toBeNull()

    // 切回 A：待决策请求被找回，决策卡重新出现
    act(() => {
      store.set(activeAgentSessionIdAtom, 'session-a')
    })
    expect(result.current?.options).toHaveLength(2)
    expect(result.current?.title).toContain('缺了按月统计功能')
  })
})

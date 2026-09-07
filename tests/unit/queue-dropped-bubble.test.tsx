// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { activeAgentSessionIdAtom, agentMessagesFamily, setupGlobalAgentListeners } from '../../renderer/agent-atoms'
import type { ElectronAPI } from '../../shared/types'

/**
 * queue_dropped 事件链路（queue onDropped 渲染端气泡，r79；mcp-support-port 外的 P2 兑现）：
 * 主进程 manager 安全网放弃派发 → streamPublisher 发布 queue_dropped →
 * setupGlobalAgentListeners 写入 [queue-dropped] system 消息 → ChatPanel 渲染红泡
 * （data-ai-id="queue-dropped"，含原因），用户知晓「排队消息发送失败」而非静默消失。
 * 主进程发布点（orchestrator onDropped → streamPublisher）由 S4-QUEUE-023 专测。
 */

configure({ testIdAttribute: 'data-ai-id' })

let streamHandler: ((event: { type: string; session_id: string; payload: Record<string, unknown> }) => void) | undefined
let store: ReturnType<typeof createStore>

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  streamHandler = undefined
  store = createStore()
  ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
  ;(window as never as { electronAPI: unknown }).electronAPI = {
    agent: {
      onStreamEvent: vi.fn((cb: never) => {
        streamHandler = cb as never
        return () => undefined
      }),
    },
  } as unknown as ElectronAPI
})

afterEach(() => {
  cleanup()
  delete (window as never as { electronAPI?: unknown }).electronAPI
  delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
})

describe('queue_dropped 事件链路（r79）', () => {
  it('[S4-QUEUE-021] 事件处理：queue_dropped → agentMessagesFamily 追加 [queue-dropped] system 消息（含原因）', () => {
    setupGlobalAgentListeners()
    expect(streamHandler).toBeDefined()
    streamHandler!({
      type: 'queue_dropped',
      session_id: 'sq',
      payload: { queue_message_id: 'qm1', reason: 'max-requeue' },
    })
    const msgs = store.get(agentMessagesFamily('sq'))
    const dropped = msgs.find((m) => m.role === 'system' && m.content.some((b) => b.type === 'text' && (b.text ?? '').startsWith('[queue-dropped]')))
    expect(dropped).toBeTruthy()
    expect(JSON.stringify(dropped?.content)).toContain('max-requeue')
  })

  it('[S4-QUEUE-022] ChatPanel 渲染：含 [queue-dropped] 消息 → 红泡 data-ai-id=queue-dropped（原因可见）', () => {
    store.set(activeAgentSessionIdAtom, 'sq')
    store.set(agentMessagesFamily('sq'), [
      {
        role: 'system',
        content: [{ type: 'text', text: '[queue-dropped] 排队消息发送失败（max-requeue）——请重新发送' }],
        timestamp: Date.now(),
      },
    ])
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
    const bubble = screen.getByTestId('queue-dropped')
    expect(bubble.textContent).toContain('排队消息发送失败')
    expect(bubble.textContent).toContain('max-requeue')
  })
})

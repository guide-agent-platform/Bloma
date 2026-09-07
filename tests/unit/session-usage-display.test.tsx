// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configure } from '@testing-library/react'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import type { ElectronAPI } from '../../shared/types'
import {
  activeAgentSessionIdAtom,
  sessionUsageFamily,
  setupGlobalAgentListeners,
  type SessionUsage,
} from '../../renderer/agent-atoms'

/**
 * 会话用量透明条（2026-08-28，usage-guard 渲染层，v6 ② b）：
 * 主进程 agent-loop 结束时发布 usage_summary 事件 → 渲染端 atom →
 * 输入区下方「本会话已用 ≈X tokens」。渠道全盲（turnsWithUsage=0）时
 * 标注「估算」（estContextTokens 启发式口径）。
 */

configure({ testIdAttribute: 'data-ai-id' })

describe('session-usage 透明条', () => {
  let store: ReturnType<typeof createStore>
  let streamHandler: ((event: { type: string; session_id: string; payload: Record<string, unknown> }) => void) | undefined

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    window.__jotai_store__ = store as never
    streamHandler = undefined
    window.electronAPI = {
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
    delete window.electronAPI
    delete window.__jotai_store__
  })

  it('[S4-AGENT-072] usage_summary 事件归约进 sessionUsageFamily（同会话累加）', () => {
    setupGlobalAgentListeners()
    expect(streamHandler).toBeDefined()
    streamHandler!({ type: 'usage_summary', session_id: 's-u', payload: { input_tokens: 1000, output_tokens: 100, est_context_tokens: 500, turns_with_usage: 2, estimate_only: false } })
    streamHandler!({ type: 'usage_summary', session_id: 's-u', payload: { input_tokens: 500, output_tokens: 50, est_context_tokens: 800, turns_with_usage: 1, estimate_only: false } })
    const usage = store.get(sessionUsageFamily('s-u'))
    expect(usage).toMatchObject({ inputTokens: 1500, outputTokens: 150, estContextTokens: 800, turnsWithUsage: 3 })
    // 其它会话不受影响
    expect(store.get(sessionUsageFamily('s-other'))).toBeUndefined()
  })

  it('[S4-AGENT-073] ChatPanel 显示「本会话已用 ≈X tokens」；渠道返回口径无「估算」标注', () => {
    store.set(activeAgentSessionIdAtom, 's-u')
    store.set(sessionUsageFamily('s-u'), {
      inputTokens: 2000,
      outputTokens: 100,
      estContextTokens: 5000,
      turnsWithUsage: 3,
    } satisfies SessionUsage)
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
    const hint = screen.getByTestId('session-usage-hint').textContent ?? ''
    expect(hint).toContain('2,100')
    expect(hint).toContain('tokens')
    expect(hint).not.toContain('估算')
  })

  it('[S4-AGENT-074] 全盲渠道（turnsWithUsage=0）→ 显示估算口径标注；无用量不显示', () => {
    store.set(activeAgentSessionIdAtom, 's-u')
    store.set(sessionUsageFamily('s-u'), {
      inputTokens: 0,
      outputTokens: 0,
      estContextTokens: 4200,
      turnsWithUsage: 0,
    } satisfies SessionUsage)
    const { unmount } = render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
    expect(screen.getByTestId('session-usage-hint').textContent).toContain('估算')
    unmount()

    // 无用量 → 不渲染
    store.set(sessionUsageFamily('s-u'), undefined)
    render(
      <Provider store={store}>
        <ChatPanel />
      </Provider>,
    )
    expect(screen.queryByTestId('session-usage-hint')).toBeNull()
  })
})

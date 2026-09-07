// @vitest-environment jsdom
// ux-queue-echo-r99（B 腿可执行走查，SOP 二用）：排队回显现状锁定 + onDropped 气泡修后翻转位。
// 对照 enhancements-queue-dropped-bubble.md（挂账池第 3 项 JIT 预研）。

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import type { ElectronAPI } from '../../shared/types'

configure({ testIdAttribute: 'data-ai-id' })

describe('ux-queue-echo r99：busy 排队回显现状（挂账 onDropped 气泡前置锁定）', () => {
  let store: ReturnType<typeof createStore>

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      agent: { onStreamEvent: vi.fn(() => () => undefined) },
      pastedImage: { save: vi.fn() },
    } as unknown as ElectronAPI
  })
  afterEach(() => {
    cleanup()
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
  })

  function mountBusy(): HTMLTextAreaElement {
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={vi.fn()} isWaiting={true} />
      </Provider>,
    )
    // busy 态 placeholder 文案不同（:511 busy 分支）——用通用 textarea 查询
    const ta = document.querySelector('textarea')
    expect(ta).not.toBeNull()
    return ta as HTMLTextAreaElement
  }

  it('[Q1·排队回显] busy 时 Enter 提交 → 灰泡出现（queued-message 可达名+文本可见）', async () => {
    const input = mountBusy()
    fireEvent.change(input, { target: { value: '排队消息 A' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => {
      const bubbles = screen.getAllByTestId('queued-message')
      expect(bubbles.length).toBeGreaterThanOrEqual(1)
      expect(bubbles[0].textContent).toContain('排队消息 A')
    })
  })

  it('[Q2·多条累积] 连续两条 → 两灰泡按序（FIFO 可见）', async () => {
    const input = mountBusy()
    fireEvent.change(input, { target: { value: '第一条' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    fireEvent.change(input, { target: { value: '第二条' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(screen.getAllByTestId('queued-message').length).toBe(2))
    const texts = screen.getAllByTestId('queued-message').map((b) => b.textContent)
    expect(texts.some((t) => t.includes('第一条'))).toBe(true)
    expect(texts.some((t) => t.includes('第二条'))).toBe(true)
  })

  it('[Q3·无事件基线] busy 提交且无 queue_dropped 事件 → 仅灰泡无红泡（事件由 S4-QUEUE-021/023 专测）', async () => {
    const input = mountBusy()
    fireEvent.change(input, { target: { value: '将被丢弃' } })
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })
    await waitFor(() => expect(screen.getAllByTestId('queued-message').length).toBe(1))
    // onDropped 事件→渲染红泡链路由 queue-dropped-bubble.test.tsx（S4-QUEUE-021/022）专测；
    // 本用例锁定无事件时的基线：红泡不出现（防常显）。
    expect(screen.queryByTestId('queue-dropped')).toBeNull()
  })
})

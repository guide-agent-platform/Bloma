// @vitest-environment jsdom
// ux-waiting-stop-walkthrough r115（B 腿可执行走查，SOP 八用）：等待期操作入口（r93 F5 修复回归锁定）。
// 状态矩阵：idle 发送可用无停止 / isWaiting（无流）→ 发送禁用+**停止可见可点**（F5 修复核心）/
// hasActiveStream → 停止可见 / busy 双态均锁定。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../renderer/components/ChatPanel'
import { agentStreamStateFamily, activeAgentSessionIdAtom } from '../../renderer/agent-atoms'

describe('ux-waiting-stop-walkthrough r115：等待期操作入口（F5 修复回归锁定）', () => {
  let store: ReturnType<typeof createStore>
  let onSendMessage: ReturnType<typeof vi.fn>
  let onStopGeneration: ReturnType<typeof vi.fn>

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    onSendMessage = vi.fn()
    onStopGeneration = vi.fn()
  })
  afterEach(() => {
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    cleanup()
  })

  function mount(isWaiting = false) {
    return render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSendMessage} onStopGeneration={onStopGeneration} isWaiting={isWaiting} />
      </Provider>,
    )
  }
  function typeAndSend(text: string): void {
    const box = screen.getByRole('textbox')
    fireEvent.change(box, { target: { value: text } })
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  }

  it('[W1·idle] 输入可发送；无停止按钮', () => {
    mount()
    typeAndSend('你好')
    expect(onSendMessage.mock.calls[0]?.[0]).toBe('你好')
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull()
  })

  it('[W2·isWaiting 现状锁定+翻转位] 等待中（无流）→ 发送禁用且**无停止按钮**（F5 半修：:533 替换门=hasActiveStream 非 busy——:226 注释「busy 时替换」与实现不符 F3；修后此断言应翻转）', () => {
    mount(true)
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: '停止生成' })).toBeNull() // F3 翻转位：hasActiveStream→busy 后应非空
  })

  it('[W3·流中] hasActiveStream → 停止可见（原行为回归）', () => {
    store.set(activeAgentSessionIdAtom, 's1')
    store.set(agentStreamStateFamily('s1'), { running: true, events: [], content: '' } as never)
    mount()
    expect(screen.getByRole('button', { name: '停止生成' })).toBeTruthy()
  })

  it('[W4·等待不丢输入] isWaiting → 输入框仍可编辑（草稿不锁死，等待结束可续发）', () => {
    mount(true)
    const box = screen.getByRole('textbox') as HTMLTextAreaElement
    fireEvent.change(box, { target: { value: '等待时打的草稿' } })
    expect(box.value).toBe('等待时打的草稿')
  })
})

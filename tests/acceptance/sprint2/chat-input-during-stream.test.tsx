// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../renderer/components/ChatPanel'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
  workflowStageAtom,
} from '../../../renderer/agent-atoms'

/**
 * 生成期间输入框保持可用（2026-08-16「发完一条就打不开输入框」案例）：
 * - 输入框不再整体禁用：流式运行中仍可打字（草稿），只禁发送；
 * - 生成中显示停止按钮（U4），发送入口被替换；
 * - WaitingFeedback 挂到真实忙碌信号上（此前挂在恒 false 的 isWaiting，从未显示），
 *   且话术按权威阶段显示（generating_sketch → 「生成草图」）。
 */
describe('生成期间输入框保持可用（草稿可输入、发送禁用、阶段化等待反馈）', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    delete window.__jotai_store__
  })

  it('流式运行中：textarea 可编辑、显示停止按钮、5 秒后出现「生成草图」等待反馈', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(workflowStageAtom, 'generating_sketch')
    store.set(agentStreamStateFamily('session-1'), { running: true, events: [], content: '' })
    window.__jotai_store__ = store

    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={vi.fn()} />
      </Provider>,
    )

    // 输入框不再被禁用：可以先把想法打出来（草稿）
    const input = screen.getByRole('textbox')
    expect((input as HTMLTextAreaElement).disabled).toBe(false)
    fireEvent.change(input, { target: { value: '先记着：要加深色模式' } })
    expect((input as HTMLTextAreaElement).value).toBe('先记着：要加深色模式')

    // 生成中显示停止按钮（U4），发送入口被替换（不能中途发送）
    expect(screen.getByLabelText('停止生成')).toBeTruthy()

    // 超过 5 秒出现等待反馈，且话术按阶段显示
    expect(screen.queryByRole('status')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(6_000)
    })
    expect(screen.getByRole('status').textContent).toContain('生成草图')
  })

  it('流结束后：输入恢复发送能力（completed 复位 running）', () => {
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), { running: false, events: [], content: '' })
    window.__jotai_store__ = store

    const onSendMessage = vi.fn()
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSendMessage} />
      </Provider>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '加一个深色模式' } })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: false })

    expect(onSendMessage).toHaveBeenCalledWith('加一个深色模式')
    expect((input as HTMLTextAreaElement).value).toBe('')
  })
})

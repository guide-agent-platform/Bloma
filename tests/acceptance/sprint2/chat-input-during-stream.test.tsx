// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatPanel } from '../../../renderer/components/ChatPanel'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
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

  it('流式运行中：textarea 可编辑、显示停止按钮、Enter 提交仍可用（后端排队兜底）', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T00:00:00.000Z'))
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(workflowStageAtom, 'generating_sketch')
    store.set(agentStreamStateFamily('session-1'), { running: true, events: [], content: '' })
    window.__jotai_store__ = store

    const onSend = vi.fn()
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )

    // 输入框不再被禁用：可以先把想法打出来（草稿）
    const input = screen.getByRole('textbox')
    expect((input as HTMLTextAreaElement).disabled).toBe(false)
    fireEvent.change(input, { target: { value: '先记着：要加深色模式' } })
    expect((input as HTMLTextAreaElement).value).toBe('先记着：要加深色模式')

    // 生成中显示停止按钮（U4）
    expect(screen.getByLabelText('停止生成')).toBeTruthy()

    // message-queue（2026-08-27）：生成期间 Enter 仍可提交——由后端排队兜底，不丢消息
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledWith('先记着：要加深色模式')
    expect((input as HTMLTextAreaElement).value).toBe('')

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

  // message-queue UI 收尾（ux-chatpanel-review P1-①，2026-08-28）：busy 时提交的消息
  // 进后端队列但不在 messages 流里——用户看到「打了字→字消失→屏幕无新元素」。
  // 排队气泡：灰化用户气泡 + 「排队中」角标，派发后（不再 busy）消失。
  it('排队消息可见：busy 时提交出现灰化「排队中」气泡，不再静默丢失', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-28T00:00:00.000Z'))
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(workflowStageAtom, 'generating_sketch')
    store.set(agentStreamStateFamily('session-1'), { running: true, events: [], content: '' })
    window.__jotai_store__ = store

    const onSend = vi.fn()
    render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )

    const input = screen.getByRole('textbox')
    expect(screen.queryByText('排队中')).toBeNull()

    fireEvent.change(input, { target: { value: '再加一个导出按钮' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // 排队气泡出现：消息原文可见 + 排队中角标；输入框照常清空
    expect(screen.getByText('再加一个导出按钮')).toBeTruthy()
    expect(screen.getByText('排队中')).toBeTruthy()
    expect((input as HTMLTextAreaElement).value).toBe('')
  })

  it('排队气泡派发后出列：消息真实进流时不再显示', () => {
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), { running: true, events: [], content: '' })
    window.__jotai_store__ = store

    const onSend = vi.fn()
    const { rerender, container } = render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '生成完成后看看这个' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('生成完成后看看这个')).toBeTruthy()

    // 后端队列派发：run 结束 + 用户消息进流（agentMessagesFamily）→ 气泡出列
    act(() => {
      store.set(agentStreamStateFamily('session-1'), { running: false, events: [], content: '' })
      store.set(agentMessagesFamily('session-1'), [
        {
          role: 'user',
          content: [{ type: 'text', text: '生成完成后看看这个' }],
          timestamp: Date.now(),
        } as never,
      ])
    })
    rerender(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )
    // 排队气泡出列（排队态消失），真实消息气泡接管——文本仍可见但不再是排队回显
    expect(container.querySelector('[data-ai-id=queued-message]')).toBeNull()
    expect(screen.queryByText('排队中')).toBeNull()
    expect(screen.getAllByText('生成完成后看看这个')).toHaveLength(1)
  })

  it('run 间隙抖动不误清：busy 短暂解除但消息未进流时气泡仍在（审查 fail 点加固）', () => {
    Element.prototype.scrollIntoView = vi.fn()

    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), { running: true, events: [], content: '' })
    window.__jotai_store__ = store

    const onSend = vi.fn()
    const { rerender } = render(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '抖动场景消息' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByText('抖动场景消息')).toBeTruthy()

    // run A 结束（busy→false）但消息尚未派发进流（异步间隙）——气泡必须保留
    act(() => {
      store.set(agentStreamStateFamily('session-1'), { running: false, events: [], content: '' })
    })
    rerender(
      <Provider store={store}>
        <ChatPanel onSendMessage={onSend} />
      </Provider>,
    )
    expect(screen.getByText('抖动场景消息')).toBeTruthy()
    expect(screen.getByText('排队中')).toBeTruthy()
  })
})

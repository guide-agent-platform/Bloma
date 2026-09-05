// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClarificationCard } from '../../renderer/components/ClarificationCard'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  enrichmentClarificationFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * 加厚追问卡（enrichment_clarification 流，2026-09-05 选择题化）：
 * 事件归约进 enrichmentClarificationFamily → 卡片渲染（一次一道选择题）
 * → 具体选项 / 「你帮我决定」 / 「其他，自己填写」三出口均走 sendMessage
 * card_option 元数据（selected_option_id='enrichment_clarification_answer'），
 * 且提交前本地追加 user 气泡（答案落会话成为接地证据 + 界面上下文）。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

const REQUESTS = [
  {
    for: 'F-001',
    question: '记账记录要保留多久？',
    options: [
      { id: 'year', label: '保留一年' },
      { id: 'month', label: '保留一个月' },
    ],
  },
]

describe('加厚追问卡 ClarificationCard（选择题化）', () => {
  let store: ReturnType<typeof createStore>
  const sendMessage = vi.fn(async (_input: { content?: string; metadata?: { selected_option_id?: string; source?: string } }) => ({ ok: true, data: { accepted: true, session_id: 'session-clar', stream_started: true } }))

  beforeEach(() => {
    sendMessage.mockClear()
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-clar')
    window.electronAPI = {
      agent: {
        onStreamEvent: () => () => undefined,
        sendMessage,
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function setCardState(): void {
    store.set(enrichmentClarificationFamily('session-clar'), {
      sessionId: 'session-clar',
      projectId: 'project-clar',
      title: '整理 PRD 前，先确认几个关键点',
      requests: REQUESTS,
    })
  }

  it('事件归约 → 卡片渲染：标题/问题/具体选项/你帮我决定/自己填写出口', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    expect(screen.getByTestId('clarification-card-title').textContent).toContain('整理 PRD 前')
    expect(screen.getByTestId('clarification-question-0').textContent).toContain('记账记录要保留多久？')
    expect(screen.getByTestId('clarification-question-0').textContent).toContain('F-001')
    // 具体选项 + 你帮我决定 + 其他自己填写
    expect(screen.getByTestId('clarification-option-year').textContent).toBe('保留一年')
    expect(screen.getByTestId('clarification-option-month').textContent).toBe('保留一个月')
    expect(screen.getByTestId('clarification-option-auto').textContent).toBe('你帮我决定')
    expect(screen.getByTestId('clarification-option-custom').textContent).toContain('自己填写')
  })

  it('点具体选项：content=选项 label 回传 + 本地追加 user 气泡 + 乐观关闭', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    fireEvent.click(screen.getByTestId('clarification-option-year'))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: { selected_option_id: string; source: string } }
    expect(call.content).toBe('保留一年')
    expect(call.metadata.selected_option_id).toBe('enrichment_clarification_answer')
    expect(call.metadata.source).toBe('card_option')
    // 本地追加 user 气泡
    const messages = store.get(agentMessagesFamily('session-clar'))
    expect(messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === '保留一年'))).toBe(true)
    // 乐观关闭：提交后卡片消失（atom 清空）
    expect(screen.queryByTestId('clarification-card')).toBeNull()
  })

  it('点「你帮我决定」：content=你帮我决定 回传 + 气泡', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    fireEvent.click(screen.getByTestId('clarification-option-auto'))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0][0] as { content: string }
    expect(call.content).toBe('你帮我决定')
  })

  it('「其他，自己填写」→ 输入框 → 提交：content=填写文本 + 气泡', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    fireEvent.click(screen.getByTestId('clarification-option-custom'))
    const input = screen.getByTestId('clarification-custom-input')
    fireEvent.change(input, { target: { value: '保留一年，要图表。' } })
    fireEvent.click(screen.getByTestId('clarification-custom-submit'))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: { selected_option_id: string } }
    expect(call.content).toBe('保留一年，要图表。')
    expect(call.metadata.selected_option_id).toBe('enrichment_clarification_answer')
    const messages = store.get(agentMessagesFamily('session-clar'))
    expect(messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === '保留一年，要图表。'))).toBe(true)
  })

  it('无挂起状态 → 不渲染（null 安全）', () => {
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    expect(screen.queryByTestId('clarification-card')).toBeNull()
  })
})

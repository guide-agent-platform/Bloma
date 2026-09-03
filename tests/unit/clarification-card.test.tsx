// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClarificationCard } from '../../renderer/components/ClarificationCard'
import {
  activeAgentSessionIdAtom,
  enrichmentClarificationFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * 加厚追问卡（enrichment_clarification 流，② 2026-09-03）：
 * 事件归约进 enrichmentClarificationFamily → 卡片渲染（问题列表带 for 徽标）
 * → 两出口（提交回答 / 跳过）均走 sendMessage card_option 元数据
 * （selected_option_id='enrichment_clarification_answer'，零新 IPC）。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

const CLARIFICATION_EVENT: AgentEvent = {
  event_id: crypto.randomUUID(),
  session_id: 'session-clar',
  project_id: 'project-clar',
  type: 'user_decision_required',
  payload: {
    kind: 'enrichment_clarification',
    title: '整理 PRD 前，先确认几个关键点',
    requests: [
      { for: 'F-001', question: '记账记录要保留多久？' },
      { for: 'F-002', question: '按月统计要图表还是数字？' },
    ],
  },
  created_at: new Date().toISOString(),
}

describe('加厚追问卡 ClarificationCard', () => {
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
      requests: [
        { for: 'F-001', question: '记账记录要保留多久？' },
        { for: 'F-002', question: '按月统计要图表还是数字？' },
      ],
    })
  }

  it('事件归约 → 卡片渲染：标题/问题清单/for 徽标/回答输入/双出口', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    expect(screen.getByTestId('clarification-card-title').textContent).toContain('整理 PRD 前')
    expect(screen.getByTestId('clarification-question-0').textContent).toContain('记账记录要保留多久？')
    expect(screen.getByTestId('clarification-question-0').textContent).toContain('F-001')
    expect(screen.getByTestId('clarification-question-1').textContent).toContain('F-002')
    expect(screen.getByTestId('clarification-answer-input')).toBeTruthy()
    expect(screen.getByTestId('clarification-submit-button')).toBeTruthy()
    expect(screen.getByTestId('clarification-skip-button')).toBeTruthy()
  })

  it('提交回答：文本回传 + selected_option_id=enrichment_clarification_answer + 乐观关闭', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    fireEvent.change(screen.getByTestId('clarification-answer-input'), { target: { value: '保留一年，要图表。' } })
    fireEvent.click(screen.getByTestId('clarification-submit-button'))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: { selected_option_id: string; source: string } }
    expect(call.content).toBe('保留一年，要图表。')
    expect(call.metadata.selected_option_id).toBe('enrichment_clarification_answer')
    expect(call.metadata.source).toBe('card_option')
    // 乐观关闭：提交后卡片消失（atom 清空）
    expect(screen.queryByTestId('clarification-card')).toBeNull()
  })

  it('空回答 → 提交按钮禁用不发消息；跳过 → 固定文案同选项回传', () => {
    setCardState()
    render(
      <Provider store={store}>
        <ClarificationCard />
      </Provider>,
    )
    expect((screen.getByTestId('clarification-submit-button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByTestId('clarification-skip-button'))
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: { selected_option_id: string } }
    expect(call.content).toContain('按你已有的信息整理')
    expect(call.metadata.selected_option_id).toBe('enrichment_clarification_answer')
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

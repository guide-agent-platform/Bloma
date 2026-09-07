// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewChoicesDialog } from '../../renderer/components/ReviewChoicesDialog'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * 裁判审查逐题选择题弹窗（prd_review 流，2026-09-05 一次一道 + 开放填写）：
 * kind=prd_review 事件归约进 reviewChoicesFamily → 弹窗一次只渲染一道题；
 * 点选具体选项或「其他，自己填写」自动进入下一道，全部答完自动回传 review_answers
 * （「其他，自己填写」option_id='custom'、label=填写文本），提交前本地追加 user 气泡。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

const REVIEW_EVENT: AgentEvent = {
  event_id: crypto.randomUUID(),
  session_id: 'session-review',
  project_id: 'project-review',
  type: 'user_decision_required',
  payload: {
    kind: 'prd_review',
    title: '裁判发现几个地方需要你确认',
    summary: '有两个地方需要你拍板',
    review_questions: [
      {
        id: 'q0',
        question: '你想要的按月汇总，要不要作为主要功能？',
        options: [
          { id: 'q0:monthly-core', label: '要，作为主要功能', description: '每月自动出汇总' },
          { id: 'q0:ignore', label: '这条没问题', description: '不改这一条' },
        ],
      },
      {
        id: 'q1',
        question: '记完账后，你想怎么翻看以前的记录？',
        options: [
          { id: 'q1:list', label: '能看到列表', description: '' },
          { id: 'q1:ignore', label: '这条没问题', description: '不改这一条' },
        ],
      },
    ],
    global_options: [{ id: 'prd_review_delegate_all', label: '全部交给向导决定', description: '' }],
  },
  created_at: new Date().toISOString(),
}

describe('裁判审查逐题选择题弹窗 ReviewChoicesDialog（一次一道）', () => {
  let store: ReturnType<typeof createStore>
  const sendMessage = vi.fn(async (_input: { metadata?: Record<string, unknown> }) => ({ ok: true, data: { accepted: true, session_id: 'session-review', stream_started: true } }))
  let emit: ((event: AgentEvent) => void) | undefined

  beforeEach(() => {
    sendMessage.mockClear()
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-review')
    emit = undefined
    window.electronAPI = {
      agent: {
        onStreamEvent: (handler: (event: AgentEvent) => void) => {
          emit = handler
          return () => undefined
        },
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

  function renderDialog(): ReturnType<typeof render> {
    return render(
      <Provider store={store}>
        <ReviewChoicesDialog />
      </Provider>,
    )
  }

  it('一次只渲染一道题（含进度 + 开放填写出口），第二道题不出现', () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    // 只有第一道题渲染
    expect(screen.getByTestId('review-choices-question-q0')).toBeTruthy()
    expect(screen.queryByTestId('review-choices-question-q1')).toBeNull()
    // 进度
    expect(screen.getByTestId('review-choices-intro').textContent).toContain('第 1/2 题')
    // 具体选项 + 开放填写出口
    expect(screen.getByTestId('review-choice-q0:monthly-core')).toBeTruthy()
    expect(screen.getByTestId('review-choice-custom')).toBeTruthy()
  })

  it('逐题点选 → 自动下一道 → 最后一道自动提交 review_answers + 本地追加 user 气泡', async () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    // 第一道点选 → 跳到第二道
    fireEvent.click(screen.getByTestId('review-choice-q0:monthly-core'))
    expect(screen.getByTestId('review-choices-question-q1')).toBeTruthy()

    // 第二道点选 → 自动提交
    fireEvent.click(screen.getByTestId('review-choice-q1:ignore'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: Record<string, unknown> }
    expect(call.metadata).toEqual({
      source: 'card_option',
      review_answers: [
        { issue_id: 'q0', option_id: 'q0:monthly-core', label: '要，作为主要功能' },
        { issue_id: 'q1', option_id: 'q1:ignore', label: '这条没问题' },
      ],
    })
    // 气泡：content 含逐题答案摘要，且追加为 user 消息
    expect(call.content).toContain('要，作为主要功能')
    expect(call.content).toContain('这条没问题')
    const messages = store.get(agentMessagesFamily('session-review'))
    expect(messages.some((m) => m.role === 'user' && m.content.some((b) => b.type === 'text' && b.text === call.content))).toBe(true)
  })

  it('「其他，自己填写」→ 输入框提交 → 回传 option_id=custom + label=填写文本', async () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    // 第一道选「其他，自己填写」
    fireEvent.click(screen.getByTestId('review-choice-custom'))
    fireEvent.change(screen.getByTestId('review-choice-custom-input'), { target: { value: '按月汇总要能看到年度趋势' } })
    fireEvent.click(screen.getByTestId('review-choice-custom-submit'))

    // 跳到第二道，点选「这条没问题」→ 自动提交
    expect(screen.getByTestId('review-choices-question-q1')).toBeTruthy()
    fireEvent.click(screen.getByTestId('review-choice-q1:ignore'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const call = sendMessage.mock.calls[0][0] as { content: string; metadata: Record<string, unknown> }
    expect(call.metadata).toEqual({
      source: 'card_option',
      review_answers: [
        { issue_id: 'q0', option_id: 'custom', label: '按月汇总要能看到年度趋势' },
        { issue_id: 'q1', option_id: 'q1:ignore', label: '这条没问题' },
      ],
    })
    expect(call.content).toContain('按月汇总要能看到年度趋势')
  })

  it('点「全部交给向导决定」→ 回传 selected_option_id=prd_review_delegate_all', async () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    fireEvent.click(screen.getByTestId('review-choice-global-prd_review_delegate_all'))

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const call = sendMessage.mock.calls[0][0]
    expect(call.metadata).toEqual({
      source: 'card_option',
      selected_option_id: 'prd_review_delegate_all',
    })
  })
})

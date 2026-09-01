// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ReviewChoicesDialog } from '../../renderer/components/ReviewChoicesDialog'
import {
  activeAgentSessionIdAtom,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * 裁判审查逐题选择题弹窗（prd_review 流，2026-08-30 选择题化）：
 * kind=prd_review 事件归约进 reviewChoicesFamily → 弹窗渲染逐题选择题（每题一组按钮）；
 * 全部点选后「提交」回传 review_answers；「全部交给向导决定」回传 selected_option_id。
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

describe('裁判审查逐题选择题弹窗 ReviewChoicesDialog', () => {
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

  it('kind=prd_review 归约进 reviewChoicesFamily → 逐题选择题渲染，未全选时提交禁用', () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    // 两道题都渲染（含零基础问题 + 可点选项）
    expect(screen.getByTestId('review-choices-question-q0')).toBeTruthy()
    expect(screen.getByTestId('review-choices-question-q1')).toBeTruthy()
    expect(screen.getByTestId('review-choice-q0:monthly-core')).toBeTruthy()
    expect(screen.getByTestId('review-choice-q1:list')).toBeTruthy()

    // 未全选：提交禁用
    const submit = screen.getByTestId('review-choices-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it('逐题点选后提交 → 回传 review_answers（issue_id/option_id/label）', async () => {
    emit?.(REVIEW_EVENT)
    renderDialog()

    fireEvent.click(screen.getByTestId('review-choice-q0:monthly-core'))
    fireEvent.click(screen.getByTestId('review-choice-q1:ignore'))

    const submit = screen.getByTestId('review-choices-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const call = sendMessage.mock.calls[0][0]
    expect(call.metadata).toEqual({
      source: 'card_option',
      review_answers: [
        { issue_id: 'q0', option_id: 'q0:monthly-core', label: '要，作为主要功能' },
        { issue_id: 'q1', option_id: 'q1:ignore', label: '这条没问题' },
      ],
    })
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

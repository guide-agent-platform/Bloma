// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { renderHook, act } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useUserDecisionCards } from '../../../renderer/components/ChatPanel-sprint2'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
  decisionConsumedFamily,
  markDecisionConsumed,
} from '../../../renderer/agent-atoms'
import type { AgentEvent } from '../../../shared/types'

/**
 * Sprint 3 · 决策卡片消费标记：
 * 用户点选卡片后应立即隐藏卡片（不等 sketch_ready），否则草图走 LLM 的空窗期里
 * 旧卡片继续显示，用户误以为「选了没生效」再点一次就撞 AGENT_SESSION_BUSY。
 */

function event(type: AgentEvent['type'], payload: Record<string, unknown> = {}): AgentEvent {
  return {
    event_id: 'evt',
    session_id: 'session-1',
    project_id: 'project-1',
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

function makeWrapper(store: ReturnType<typeof createStore>) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <Provider store={store}>{children}</Provider>
  }
}

describe('决策卡片消费标记（选了选项就立即隐藏卡片）', () => {
  afterEach(() => {
    // 清理测试注入的全局 store
    delete window.__jotai_store__
  })

  it('审查卡（kind=prd_review）走专用弹窗：无 questions → 内联卡不弹（options 空）', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), {
      running: false,
      content: '', thinking: '',
      events: [
        event('user_decision_required', {
          kind: 'prd_review',
          title: '裁判发现几个地方需要你确认',
          summary: '有两个地方需要你拍板',
          review_questions: [
            {
              id: 'q0',
              question: '创作怎么被播放、保存？',
              options: [
                { id: 'q0:play', label: '能播放', description: '' },
                { id: 'q0:ignore', label: '这条没问题', description: '' },
              ],
            },
          ],
          global_options: [{ id: 'prd_review_delegate_all', label: '全部交给向导决定' }],
        }),
      ],
    })
    window.__jotai_store__ = store

    const wrapper = makeWrapper(store)
    const { result } = renderHook(() => useUserDecisionCards(), { wrapper })

    // 审查卡走专用弹窗（2026-08-30 选择题化）：内联卡不弹（questions 不存在 → options 空）
    expect(result.current?.options).toHaveLength(0)
  })

  it('普通澄清卡无 issues/summary → body 为 undefined 不渲染正文区', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), {
      running: false,
      content: '', thinking: '',
      events: [
        event('user_decision_required', {
          kind: 'clarification',
          title: '先确认方向',
          questions: [{ id: 'a', label: '手机', description: '' }],
        }),
      ],
    })
    window.__jotai_store__ = store

    const wrapper = makeWrapper(store)
    const { result } = renderHook(() => useUserDecisionCards(), { wrapper })
    expect(result.current?.body).toBeUndefined()
  })

  it('点选后 consumed=true → useUserDecisionCards 返回 null（即使事件流里仍有 user_decision_required）', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), {
      running: false,
      content: '', thinking: '',
      events: [
        event('user_decision_required', {
          questions: [{ id: 'daily', label: '生活工具', description: '记账提醒' }],
        }),
      ],
    })
    // 让 markDecisionConsumed 操作同一个 store（它读 window.__jotai_store__）
    // 注入测试 store
    window.__jotai_store__ = store

    const wrapper = makeWrapper(store)
    const { result, rerender } = renderHook(() => useUserDecisionCards(), { wrapper })

    // 未消费：卡片应显示
    expect(result.current?.options.map((c) => c.label)).toEqual(['生活工具'])

    // 用户点选 → 立即消费
    act(() => markDecisionConsumed('session-1'))
    rerender()

    // 已消费：卡片立即隐藏，即使还没有 sketch_ready
    expect(result.current).toBeNull()
    expect(store.get(decisionConsumedFamily('session-1'))).toBe(true)
  })

  it('新一轮 user_decision_required 到达时重置消费标记，新卡片重新弹出', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(agentStreamStateFamily('session-1'), {
      running: false,
      content: '', thinking: '',
      events: [event('user_decision_required', { questions: [{ id: 'a', label: 'A' }] })],
    })
    // 注入测试 store
    window.__jotai_store__ = store
    store.set(decisionConsumedFamily('session-1'), true)

    const wrapper = makeWrapper(store)
    const { result, rerender } = renderHook(() => useUserDecisionCards(), { wrapper })
    expect(result.current).toBeNull()

    // 新一轮决策：新的 user_decision_required 事件到达 → 重置标记 → 卡片弹出
    act(() => {
      store.set(agentStreamStateFamily('session-1'), (prev) => ({
        ...prev,
        events: [...prev.events, event('user_decision_required', { questions: [{ id: 'b', label: 'B' }] })],
      }))
      store.set(decisionConsumedFamily('session-1'), false)
    })
    rerender()

    expect(result.current?.options.map((c) => c.label)).toEqual(['B'])
  })
})

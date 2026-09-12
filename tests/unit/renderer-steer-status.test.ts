// @vitest-environment jsdom

/**
 * I3 转向生效确认链（P7-7，2026-09-11）渲染端归约测试：
 * steer_status / steer_injected(扩 payload) / mvp_ready(deferred 待办提醒) 三事件
 * → steerStatusFamily 状态条数据 upsert；「这轮会做吗」的答案与主进程账本一致。
 * 渲染端只镜像状态（权威源在主进程 getSteerStatuses），此处锁事件→chips 的映射。
 */

import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentMessagesFamily, setupGlobalAgentListeners, steerStatusFamily } from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI, SteerStatus } from '../../shared/types'

let eventSequence = 0

function event(sessionId: string, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  eventSequence += 1
  return {
    event_id: `evt-${eventSequence}`,
    session_id: sessionId,
    project_id: 'project-i3',
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

describe('I3 steer 状态条归约（steer_status / steer_injected / mvp_ready）', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  function setup(): { store: ReturnType<typeof createStore>; push: (event: AgentEvent) => void; cleanup: () => void } {
    const store = createStore()
    let listener: ((event: AgentEvent) => void) | undefined
    window.__jotai_store__ = store
    window.electronAPI = {
      agent: {
        onStreamEvent(next: (event: AgentEvent) => void) {
          listener = next
          return () => undefined
        },
      },
    } as unknown as ElectronAPI
    const cleanup = setupGlobalAgentListeners()
    return { store, push: (e: AgentEvent) => listener?.(e), cleanup }
  }

  const chipOf = (store: ReturnType<typeof createStore>, sessionId: string, steerId: string) =>
    store.get(steerStatusFamily(sessionId)).find((chip) => chip.steerId === steerId)

  it('steer_status 全生命周期：received → pending_impact → deferred/rejected/merged 如实翻转', () => {
    const { store, push, cleanup } = setup()
    // 低档：received（已收到·将纳入本轮）
    push(event('s1', 'steer_status', { steer_id: 'st-1', content: '把按钮改成蓝色', impact: 'low', status: 'received', at: 1 }))
    expect(chipOf(store, 's1', 'st-1')).toMatchObject({ status: 'received', impact: 'low' })
    // 注入完成（steer_injected 扩 payload）→ merged_this_run
    push(event('s1', 'steer_injected', { content: '把按钮改成蓝色', message: '【用户中途补充】把按钮改成蓝色', at_turn: 2, remaining: 0, steer_id: 'st-1', status: 'merged_this_run' }))
    expect(chipOf(store, 's1', 'st-1')?.status).toBe('merged_this_run')

    // 中档：pending_impact（待你确认）→ defer（留待下一轮）
    push(event('s1', 'steer_status', { steer_id: 'st-2', content: '再加一个搜索功能', impact: 'medium', status: 'pending_impact', at: 2 }))
    expect(chipOf(store, 's1', 'st-2')?.status).toBe('pending_impact')
    push(event('s1', 'steer_status', { steer_id: 'st-2', content: '再加一个搜索功能', impact: 'medium', status: 'deferred_next_run', at: 3 }))
    expect(chipOf(store, 's1', 'st-2')?.status).toBe('deferred_next_run')

    // 高档被停：rejected（未采用）
    push(event('s1', 'steer_status', { steer_id: 'st-3', content: '不要这个应用了', impact: 'high', status: 'pending_impact', at: 4 }))
    push(event('s1', 'steer_status', { steer_id: 'st-3', content: '不要这个应用了', impact: 'high', status: 'rejected', at: 5 }))
    expect(chipOf(store, 's1', 'st-3')?.status).toBe('rejected')

    // 体验验收①：三条 steer 的「这轮会做吗」答案与状态一一对应
    const answerOf = (status: SteerStatus): string => {
      if (status === 'merged_this_run' || status === 'received') return '会'
      if (status === 'pending_impact') return '待你确认'
      if (status === 'deferred_next_run') return '下一轮'
      return '不会'
    }
    expect(answerOf(chipOf(store, 's1', 'st-1')!.status)).toBe('会')
    expect(answerOf(chipOf(store, 's1', 'st-2')!.status)).toBe('下一轮')
    expect(answerOf(chipOf(store, 's1', 'st-3')!.status)).toBe('不会')
    cleanup()
  })

  it('乱序迟到事件不回退状态（updatedAt 新者胜）', () => {
    const { store, push, cleanup } = setup()
    push(event('s2', 'steer_status', { steer_id: 'st-1', content: 'x', impact: 'low', status: 'merged_this_run', at: 10 }))
    // 迟到的 received（at=5）不得把 merged 拉回
    push(event('s2', 'steer_status', { steer_id: 'st-1', content: 'x', impact: 'low', status: 'received', at: 5 }))
    expect(chipOf(store, 's2', 'st-1')?.status).toBe('merged_this_run')
    cleanup()
  })

  it('off=字节级：steer_injected 无 steer_id 时零 upsert（回执气泡照旧，无状态条数据）', () => {
    const { store, push, cleanup } = setup()
    push(event('s3', 'steer_injected', { content: '把按钮改成蓝色', message: '【用户中途补充】把按钮改成蓝色', at_turn: 1, remaining: 0 }))
    expect(store.get(steerStatusFamily('s3'))).toEqual([])
    // 旧回执气泡行为保留
    const systemTexts = store.get(agentMessagesFamily('s3'))
      .filter((message) => message.role === 'system')
      .map((message) => message.content.map((block) => block.type === 'text' ? block.text : '').join(''))
    expect(systemTexts).toContain('已注入，将于下一轮生效')
    cleanup()
  })

  it('mvp_ready 交付时存在 deferred → 聊天流追加待办提醒（交付后再确认）', () => {
    const { store, push, cleanup } = setup()
    push(event('s4', 'steer_status', { steer_id: 'st-d1', content: '再加一个搜索功能', impact: 'medium', status: 'deferred_next_run', at: 1 }))
    push(event('s4', 'mvp_ready', { preview_url: 'http://localhost' }))
    const messages = store.get(agentMessagesFamily('s4'))
    const reminder = messages.find((message) =>
      message.role === 'system'
      && message.content.some((block) => block.type === 'text' && (block.text ?? '').includes('留待下一轮的修改')),
    )
    expect(reminder).toBeDefined()
    expect(JSON.stringify(reminder)).toContain('再加一个搜索功能')
    // 无 deferred 时不追加提醒
    push(event('s4b', 'mvp_ready', {}))
    expect(store.get(agentMessagesFamily('s4b'))).toEqual([])
    cleanup()
  })
})

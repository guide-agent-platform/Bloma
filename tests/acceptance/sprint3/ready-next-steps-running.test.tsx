// @vitest-environment jsdom

/**
 * 就绪引导卡（ready_next_steps）到达后 running 不复位（回归锁定）。
 *
 * 线上卡死现象：MVP 生成完成、裁判通过进入 ready 后，后端事件序列为
 *   stage_changed(ready) → message_delta(完成文案) → completed(success)
 *   → user_decision_required(kind=ready_next_steps)。
 * 就绪引导卡在 completed **之后**到达，若 reducer 照旧 running=!isTerminal，
 * user_decision_required 会把 running 重新拉回 true → busy → 决策卡选项被禁用、
 * UI 永久停在「生成中/处理中」，用户无法点选任何选项（「选择被禁」）。
 *
 * 修复：user_decision_required 是「已完成、等用户决策」的静态信号，不是「运行中」
 * 信号——reducer 保持上一轮的 running：前台流中弹卡仍为 true，后台管线完成后的
 * 引导/让渡卡仍为 false。
 */

import { createStore } from 'jotai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentStreamStateFamily,
  hasActiveStreamAtom,
  activeAgentSessionIdAtom,
  setupGlobalAgentListeners,
  workflowStageAtom,
} from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'

let eventSequence = 0

describe('ready_next_steps 引导卡不复位 running', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  function install(): { store: ReturnType<typeof createStore>; emit: (event: AgentEvent) => void } {
    const store = createStore()
    let listener: ((event: AgentEvent) => void) | undefined
    window.__jotai_store__ = store
    window.electronAPI = {
      agent: {
        onStreamEvent(next: (event: AgentEvent) => void) {
          listener = next
          return vi.fn()
        },
      },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
    return {
      store,
      emit: (event) => listener?.(event),
    }
  }

  it('后台管线完成：completed 后到达 ready_next_steps 卡，running 保持 false（可点选）', () => {
    const { store, emit } = install()
    store.set(activeAgentSessionIdAtom, 'session-a')

    emit(ev('session-a', 'project-a', 'stage_changed', { stage: 'generating_mvp' }))
    emit(ev('session-a', 'project-a', 'message_delta', { text: '正在生成完整功能…' }))
    emit(ev('session-a', 'project-a', 'stage_changed', { stage: 'ready' }))
    emit(ev('session-a', 'project-a', 'message_delta', { text: '已经生成好了，可以试用。' }))
    emit(ev('session-a', 'project-a', 'completed', { subtype: 'success' }))
    // 关键：completed 之后到达的就绪引导卡，不得把 running 拉回 true
    emit(ev('session-a', 'project-a', 'user_decision_required', {
      kind: 'ready_next_steps',
      title: '当前版本已就绪——下一步走向完整产物',
      questions: [
        { id: 'next_backend', label: '把数据存到服务端', description: '' },
        { id: 'export_handoff', label: '导出部署', description: '' },
      ],
    }))

    expect(store.get(agentStreamStateFamily('session-a')).running).toBe(false)
    expect(store.get(hasActiveStreamAtom)).toBe(false)
    // 阶段仍为 ready（不被 running 污染）
    expect(store.get(workflowStageAtom)).toBe('ready')
  })

  it('前台流中弹决策卡：running 保持 true（流未结束）', () => {
    const { store, emit } = install()
    store.set(activeAgentSessionIdAtom, 'session-b')

    emit(ev('session-b', 'project-b', 'stage_changed', { stage: 'clarifying' }))
    emit(ev('session-b', 'project-b', 'message_delta', { text: '我先确认几个问题…' }))
    // 流尚未 completed，此时弹澄清卡 → running 应保持 true（生成仍在进行）
    emit(ev('session-b', 'project-b', 'user_decision_required', {
      kind: 'clarification',
      title: '先确认方向',
      questions: [{ id: 'a', label: '手机', description: '' }],
    }))

    expect(store.get(agentStreamStateFamily('session-b')).running).toBe(true)
    expect(store.get(hasActiveStreamAtom)).toBe(true)
  })

  it('让渡卡（blocked）在非前台补发 completed：最终 running=false', () => {
    const { store, emit } = install()
    store.set(activeAgentSessionIdAtom, 'session-c')

    // publishBlockedDecision 顺序：stage_changed → user_decision_required → message_delta → completed
    emit(ev('session-c', 'project-c', 'stage_changed', { stage: 'blocked_for_user_decision' }))
    emit(ev('session-c', 'project-c', 'user_decision_required', {
      kind: 'blocked',
      title: '缺了按月统计功能',
      questions: [{ id: 'continue', label: '继续修复', description: '' }],
    }))
    emit(ev('session-c', 'project-c', 'message_delta', { text: '这里需要你来定夺。' }))
    emit(ev('session-c', 'project-c', 'completed', { subtype: 'blocked' }))

    expect(store.get(agentStreamStateFamily('session-c')).running).toBe(false)
    expect(store.get(hasActiveStreamAtom)).toBe(false)
  })
})

function ev(
  sessionId: string,
  projectId: string,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: `${sessionId}-${type}-${eventSequence += 1}`,
    session_id: sessionId,
    project_id: projectId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

// @vitest-environment jsdom
/**
 * P2 测试盲区「ideas 归约」——市调提炼想法在事件归约进 atom 时的过滤与清洗（2026-09-02 补测）。
 *
 * 实现位置：renderer/agent-atoms.ts 两处（kind=requirement_confirm 与 kind=prd_confirm）
 * 归约规则一致：
 *   - ideas 非数组 → 归 []
 *   - 条目 label 非 string 或 trim 后为空 → 过滤掉
 *   - note / source 非 string → 归 ''（防坏类型进渲染层）
 * 此前测试只覆盖「渲染」与「LLM 提炼失败回退原始条目」，归约本身的非法输入未锁定。
 */

import { createStore } from 'jotai'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  activeAgentSessionIdAtom,
  prdConfirmFamily,
  requirementConfirmFamily,
  setupGlobalAgentListeners,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

function makeStore(): { store: ReturnType<typeof createStore>; emit: (event: AgentEvent) => void } {
  const store = createStore()
  window.__jotai_store__ = store as never
  store.set(activeAgentSessionIdAtom, 'session-rc')
  let emit: ((event: AgentEvent) => void) | undefined
  window.electronAPI = {
    agent: {
      onStreamEvent: (listener: (event: AgentEvent) => void) => {
        emit = listener
        return () => undefined
      },
    },
  } as unknown as ElectronAPI
  setupGlobalAgentListeners()
  return { store, emit: (event) => emit?.(event) }
}

const BASE = {
  event_id: crypto.randomUUID(),
  session_id: 'session-rc',
  project_id: 'project-rc',
  type: 'user_decision_required' as const,
  created_at: new Date().toISOString(),
}

describe('P2 盲区·ideas 归约（事件→atom 清洗）', () => {
  beforeEach(() => {
    window.__jotai_store__ = undefined as never
  })

  it('[requirement_confirm] 合法 ideas 原样归入（label/note/source 字符串）', () => {
    const { store, emit } = makeStore()
    emit({
      ...BASE,
      payload: {
        kind: 'requirement_confirm',
        title: '确认你的需求',
        requirements: [{ id: 'F-001', description: '记账本' }],
        ideas: [
          { label: '支持导出', note: '能导出 Excel', source: 'example.com' },
          { label: '离线可用', note: '', source: '' },
        ],
      },
    })
    const state = store.get(requirementConfirmFamily('session-rc'))
    expect(state?.ideas).toEqual([
      { label: '支持导出', note: '能导出 Excel', source: 'example.com' },
      { label: '离线可用', note: '', source: '' },
    ])
  })

  it('[requirement_confirm] 非法条目过滤：label 缺失/非字符串/空串', () => {
    const { store, emit } = makeStore()
    emit({
      ...BASE,
      payload: {
        kind: 'requirement_confirm',
        title: '确认你的需求',
        requirements: [],
        ideas: [
          { note: '没有 label' },
          { label: 123, note: 'label 是数字' },
          { label: '   ', note: 'label 全空白' },
          { label: '合法条目', note: '保留' },
        ],
      },
    })
    const state = store.get(requirementConfirmFamily('session-rc'))
    expect(state?.ideas).toEqual([{ label: '合法条目', note: '保留', source: '' }])
  })

  it('[requirement_confirm] note/source 非字符串 → 归空串（不坏类型）', () => {
    const { store, emit } = makeStore()
    emit({
      ...BASE,
      payload: {
        kind: 'requirement_confirm',
        title: '确认你的需求',
        requirements: [],
        ideas: [{ label: '合法', note: 42, source: true }],
      },
    })
    const state = store.get(requirementConfirmFamily('session-rc'))
    expect(state?.ideas).toEqual([{ label: '合法', note: '', source: '' }])
  })

  it('[requirement_confirm] ideas 非数组 → 归 []（不崩）', () => {
    const { store, emit } = makeStore()
    emit({
      ...BASE,
      payload: { kind: 'requirement_confirm', title: '确认你的需求', requirements: [], ideas: 'not-array' },
    })
    const state = store.get(requirementConfirmFamily('session-rc'))
    expect(state?.ideas).toEqual([])
  })

  it('[prd_confirm] 同规则：非法条目过滤 + 字段清洗', () => {
    const { store, emit } = makeStore()
    emit({
      ...BASE,
      payload: {
        kind: 'prd_confirm',
        title: '请确认 PRD',
        positioning: '记账本',
        requirements: [],
        ideas: [
          { label: '', note: '空 label' },
          { label: '重点标记', note: 7, source: 'example.com' },
        ],
      },
    })
    const state = store.get(prdConfirmFamily('session-rc'))
    expect(state?.ideas).toEqual([{ label: '重点标记', note: '', source: 'example.com' }])
  })
})

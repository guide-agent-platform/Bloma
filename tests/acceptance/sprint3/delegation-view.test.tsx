// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DelegationFeed } from '../../../renderer/components/DelegationFeed'
import { CollaborationPanel } from '../../../renderer/components/CollaborationPanel'
import {
  activeAgentSessionIdAtom,
  collaborationPanelExpandedAtom,
  currentProjectAtom,
  delegationsFamily,
  setupGlobalAgentListeners,
} from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../../shared/types'

/**
 * M4-C 渲染端协作视图验收：delegationsFamily 归约（生命周期事件 + delegate 工具 detail）、
 * DelegationFeed 内联行胶囊、CollaborationPanel 抽屉开合 + pending_question 提示。
 * 锚点用 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

function event(type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: 'session-ui',
    project_id: 'project-ui',
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

describe('delegationsFamily 归约（生命周期事件 + delegate 工具 detail 派生）', () => {
  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function wireListener(): (emitted: AgentEvent) => void {
    const store = createStore()
    window.__jotai_store__ = store as never
    let emit: ((emitted: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: { onStreamEvent: (listener: (emitted: AgentEvent) => void) => { emit = listener; return () => undefined } },
    } as unknown as ElectronAPI
    setupGlobalAgentListeners()
    return (emitted) => emit?.(emitted)
  }

  it('delegation_started/completed 推进 status；question 显示 pending_question', () => {
    const emit = wireListener()
    emit(event('delegation_started', {
      delegation_id: 'd-1', child_session_id: 'c-1', role: 'explore', goal: '检查 index.html', status: 'running',
    }))
    expect((window.__jotai_store__ as ReturnType<typeof createStore>).get(delegationsFamily('session-ui'))).toMatchObject([
      { delegation_id: 'd-1', role: 'explore', status: 'running', goal: '检查 index.html' },
    ])

    emit(event('delegation_question', { delegation_id: 'd-1', child_session_id: 'c-1', role: 'explore', question: '允许改文件名吗？' }))
    expect((window.__jotai_store__ as ReturnType<typeof createStore>).get(delegationsFamily('session-ui'))[0].pending_question).toBe('允许改文件名吗？')

    emit(event('delegation_completed', { delegation_id: 'd-1', child_session_id: 'c-1', role: 'explore', goal: '检查 index.html', status: 'completed' }))
    const row = (window.__jotai_store__ as ReturnType<typeof createStore>).get(delegationsFamily('session-ui'))[0]
    expect(row.status).toBe('completed')
    expect(row.pending_question).toBeUndefined()
  })

  it('tool_call_completed.detail 无生命周期事件时派生委派行；已有记录不降级', () => {
    const emit = wireListener()
    emit(event('tool_call_completed', {
      tool: 'delegate_agent', turn: 1, status: 'ok',
      detail: { delegation_id: 'd-2', child_session_id: 'c-2', role: 'implement', goal: '生成 src/app.js', status: 'running' },
    }))
    const store = window.__jotai_store__ as ReturnType<typeof createStore>
    expect(store.get(delegationsFamily('session-ui'))).toMatchObject([
      { delegation_id: 'd-2', role: 'implement', status: 'running' },
    ])

    // 后续真实 completed 事件覆盖 status；tool_call detail 不再把它降回 running
    emit(event('delegation_completed', { delegation_id: 'd-2', child_session_id: 'c-2', role: 'implement', goal: '生成 src/app.js', status: 'completed' }))
    expect(store.get(delegationsFamily('session-ui'))[0].status).toBe('completed')
  })

  it('delegation_cancelled → status cancelled；事件按 session 隔离', () => {
    const emit = wireListener()
    emit(event('delegation_started', { delegation_id: 'd-3', child_session_id: 'c-3', role: 'review', goal: '审查安全点', status: 'running' }))
    emit(event('delegation_cancelled', { delegation_id: 'd-3', child_session_id: 'c-3', role: 'review', goal: '审查安全点', status: 'cancelled' }))
    const store = window.__jotai_store__ as ReturnType<typeof createStore>
    expect(store.get(delegationsFamily('session-ui'))[0].status).toBe('cancelled')
    expect(store.get(delegationsFamily('other-session'))).toHaveLength(0)
  })
})

describe('DelegationFeed（内联行胶囊）', () => {
  afterEach(() => cleanup())

  it('无委派时不渲染；有委派渲染 id/role/status，点击展开详情', () => {
    const store = createStore()
    render(
      <Provider store={store}>
        <DelegationFeed sessionId="session-ui" />
      </Provider>,
    )
    expect(screen.queryByTestId('delegation-feed')).toBeNull()

    store.set(delegationsFamily('session-ui'), [
      { delegation_id: 'd-1', child_session_id: 'c-1', role: 'research', goal: '调研竞品', status: 'running' },
    ])
    cleanup()
    render(
      <Provider store={store}>
        <DelegationFeed sessionId="session-ui" />
      </Provider>,
    )
    const row = screen.getByTestId('delegation-row')
    expect(row.textContent).toContain('子会话')
    expect(row.textContent).toContain('调研')
    expect(row.textContent).toContain('协作中')
    expect(row.textContent).toContain('调研竞品')

    expect(screen.queryByTestId('delegation-row-detail')).toBeNull()
    fireEvent.click(row)
    const detail = screen.getByTestId('delegation-row-detail')
    expect(detail.textContent).toContain('d-1')
    expect(detail.textContent).toContain('c-1')
  })

  it('pending_question 显示「待回答」警示；completed 状态不再提示', () => {
    const store = createStore()
    store.set(delegationsFamily('session-ui'), [
      { delegation_id: 'd-1', child_session_id: 'c-1', role: 'implement', goal: '写测试', status: 'running', pending_question: '测试放哪个目录？' },
    ])
    render(
      <Provider store={store}>
        <DelegationFeed sessionId="session-ui" />
      </Provider>,
    )
    expect(screen.getByTestId('delegation-row').textContent).toContain('待回答')

    store.set(delegationsFamily('session-ui'), [
      { delegation_id: 'd-1', child_session_id: 'c-1', role: 'implement', goal: '写测试', status: 'completed' },
    ])
    cleanup()
    render(
      <Provider store={store}>
        <DelegationFeed sessionId="session-ui" />
      </Provider>,
    )
    expect(screen.getByTestId('delegation-row').textContent).toContain('已结束')
    expect(screen.getByTestId('delegation-row').textContent).not.toContain('待回答')
  })
})

describe('CollaborationPanel（委派协作抽屉）', () => {
  afterEach(() => cleanup())

  it('collaborationPanelExpandedAtom=false 不渲染；true 渲染抽屉 + 子会话列表', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-ui')
    store.set(currentProjectAtom, { project_id: 'p-1', name: '记账应用', mode: 'quick', current_stage: 'ready' } as never)
    store.set(delegationsFamily('session-ui'), [
      { delegation_id: 'd-1', child_session_id: 'c-1', role: 'implement', goal: '生成 src/app.js', status: 'completed' },
      { delegation_id: 'd-2', child_session_id: 'c-2', role: 'explore', goal: '检查 index.html', status: 'running', pending_question: '允许改名吗？' },
    ])

    render(
      <Provider store={store}>
        <CollaborationPanel />
      </Provider>,
    )
    expect(screen.queryByTestId('collaboration-panel')).toBeNull()

    store.set(collaborationPanelExpandedAtom, true)
    cleanup()
    render(
      <Provider store={store}>
        <CollaborationPanel />
      </Provider>,
    )
    expect(screen.getByTestId('collaboration-panel')).toBeTruthy()
    expect(screen.getByTestId('collaboration-panel').textContent).toContain('委派协作')
    expect(screen.getByTestId('collaboration-panel').textContent).toContain('记账应用')
    const cards = screen.getAllByTestId('collaboration-card')
    expect(cards).toHaveLength(2)
    // running + pending_question 卡片带「待回答」警示
    const pending = screen.getByTestId('collaboration-pending-question')
    expect(pending.textContent).toContain('允许改名吗？')
  })

  it('关闭按钮收起抽屉；卡片「查看详情」展开 id/goal', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-ui')
    store.set(collaborationPanelExpandedAtom, true)
    store.set(delegationsFamily('session-ui'), [
      { delegation_id: 'd-9', child_session_id: 'c-9', role: 'review', goal: '审查安全点', status: 'running' },
    ])
    render(
      <Provider store={store}>
        <CollaborationPanel />
      </Provider>,
    )
    expect(screen.getByTestId('collaboration-panel')).toBeTruthy()

    expect(screen.queryByTestId('collaboration-card-detail')).toBeNull()
    fireEvent.click(screen.getByTestId('collaboration-card-expand'))
    const detail = screen.getByTestId('collaboration-card-detail')
    expect(detail.textContent).toContain('d-9')
    expect(detail.textContent).toContain('c-9')
    expect(detail.textContent).toContain('审查安全点')

    fireEvent.click(screen.getByTestId('collaboration-panel-close'))
    cleanup()
    render(
      <Provider store={store}>
        <CollaborationPanel />
      </Provider>,
    )
    expect(screen.queryByTestId('collaboration-panel')).toBeNull()
  })
})

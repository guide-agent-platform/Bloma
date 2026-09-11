// @vitest-environment jsdom

/**
 * CardOptions 基础渲染 + useUserDecisionCards 决策卡提取。
 */

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen, fireEvent, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardOptions } from '../../renderer/components/CardOptions'
import { useUserDecisionCards } from '../../renderer/components/ChatPanel-sprint2'
import { activeAgentSessionIdAtom, agentStreamStateFamily, decisionConsumedFamily } from '../../renderer/agent-atoms'
import type { AgentEvent } from '../../shared/types'

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

describe('CardOptions 基础渲染', () => {
  afterEach(() => cleanup())

  it('渲染选项并在点击时回传对应选项', () => {
    const onSelect = vi.fn()
    render(
      <CardOptions
        options={[
          { id: 'keep', label: '保持现状' },
          { id: 'optimize', label: '局部优化', description: '只改这一处' },
        ]}
        onSelect={onSelect}
      />,
    )
    expect(screen.getByText('局部优化')).toBeTruthy()
    expect(screen.getByText('只改这一处')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /局部优化/ }))
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'optimize' }))
  })

  it('disabled 时按钮被禁用', () => {
    const onSelect = vi.fn()
    render(<CardOptions options={[{ id: 'a', label: 'A' }]} onSelect={onSelect} disabled />)
    const button = screen.getByRole('button', { name: /A/ }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe('useUserDecisionCards 决策卡提取', () => {
  afterEach(() => {
    delete window.__jotai_store__
  })

  it('mvp_review 卡 → 提取 title 与 keep/optimize/rebuild 选项', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-1')
    store.set(decisionConsumedFamily('session-1'), false)
    store.set(agentStreamStateFamily('session-1'), {
      running: false,
      content: '',
      events: [
        event('user_decision_required', {
          kind: 'mvp_review',
          title: '这一版你满意吗？',
          questions: [
            { id: 'keep', label: '保持现状', description: '' },
            { id: 'optimize', label: '局部优化', description: '' },
            { id: 'rebuild', label: '整版重做', description: '' },
          ],
        }),
      ],
    })
    window.__jotai_store__ = store

    const { result } = renderHook(() => useUserDecisionCards(), { wrapper: makeWrapper(store) })
    expect(result.current?.title).toBe('这一版你满意吗？')
    expect(result.current?.options.map((o) => o.id)).toEqual(['keep', 'optimize', 'rebuild'])
  })
})

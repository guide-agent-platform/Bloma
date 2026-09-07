// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewPanel } from '../../../renderer/components/PreviewPanel'
import { MvpStatusBanner } from '../../../renderer/components/MvpStatusBanner'
import { activeAgentSessionIdAtom, workflowStageAtom } from '../../../renderer/components/atoms'

/**
 * Sprint 2 · 问题 A / B-3 针对性 UI 用例：
 * - P0-1：草图就绪时预览控制栏出现「生成完整功能」确认按钮，点击触发回调。
 * - P1：MvpStatusBanner 补 sketch_ready 分支，提示「确认或继续对话」。
 * - B-3：点选纠错透明捕获层默认关闭，点「纠错」开关后才拦截 iframe。
 */

describe('Sprint 2 草图就绪 UI（P0-1 / P1 / B-3）', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('[P0-1] 草图就绪时预览区出现「生成完整功能」按钮，点击回调确认', () => {
    const store = createStore()
    store.set(workflowStageAtom, 'sketch_ready')
    const onConfirmSketch = vi.fn()

    render(
      <Provider store={store}>
        <PreviewPanel
          status="running"
          previewUrl="http://localhost:3000"
          onConfirmSketch={onConfirmSketch}
        />
      </Provider>,
    )

    const button = screen.getByRole('button', { name: '生成完整功能' })
    fireEvent.click(button)
    expect(onConfirmSketch).toHaveBeenCalledOnce()
  })

  it('[P0-1] 非草图就绪阶段不显示确认按钮', () => {
    const store = createStore()
    store.set(workflowStageAtom, 'clarifying')

    render(
      <Provider store={store}>
        <PreviewPanel status="empty" onConfirmSketch={vi.fn()} />
      </Provider>,
    )

    expect(screen.queryByRole('button', { name: '生成完整功能' })).toBeNull()
  })

  it('[P1] MvpStatusBanner 在 sketch_ready 阶段显示「确认或继续对话」提示', () => {
    const store = createStore()
    store.set(activeAgentSessionIdAtom, 'session-sketch')
    store.set(workflowStageAtom, 'sketch_ready')

    render(
      <Provider store={store}>
        <MvpStatusBanner />
      </Provider>,
    )

    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('草图已生成')
    expect(banner.textContent).toContain('确认')
  })

  it('[B-3] 点选纠错透明捕获层默认关闭，点「纠错」开关后才出现', () => {
    const store = createStore()
    store.set(workflowStageAtom, 'sketch_ready')

    const { container } = render(
      <Provider store={store}>
        <PreviewPanel
          status="running"
          previewUrl="http://localhost:3000"
          onCorrectionSubmit={vi.fn()}
        />
      </Provider>,
    )

    // 默认关闭：透明捕获层不拦截 iframe
    expect(container.querySelector('[data-ai-id="correction-capture-layer"]')).toBeNull()

    // 打开「纠错」开关
    fireEvent.click(screen.getByText('纠错'))
    expect(container.querySelector('[data-ai-id="correction-capture-layer"]')).toBeTruthy()

    // 再次点击关闭
    fireEvent.click(screen.getByText('纠错'))
    expect(container.querySelector('[data-ai-id="correction-capture-layer"]')).toBeNull()
  })
})

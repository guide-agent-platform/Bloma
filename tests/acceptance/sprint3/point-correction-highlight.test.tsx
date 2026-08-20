// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PreviewPanel } from '../../../renderer/components/PreviewPanel'
import { workflowStageAtom } from '../../../renderer/components/atoms'
import type { DomCollectContextResult } from '../../../shared/types'

/**
 * Sprint 3 · R-CORR-01 / S3-CORRECT-001「用户点击预览元素后，系统必须高亮被选区域」。
 *
 * 覆盖：
 * - 命中真实元素（dom:collect-context 返回有效 bounding_rect）→ 渲染区域高亮；
 * - 未命中 / 降级（fallback_mode true 或收集返回 undefined）→ 回退红点标记。
 */

const region: DomCollectContextResult = {
  element_selector: 'div.item',
  text_content: '地铁 6',
  bounding_rect: { x: 10, y: 20, width: 120, height: 44 },
  fallback_mode: false,
}

function renderPanel(onCollectDomContext?: (click: { x: number; y: number }) => Promise<DomCollectContextResult | undefined>) {
  const store = createStore()
  store.set(workflowStageAtom, 'ready')
  const rendered = render(
    <Provider store={store}>
      <PreviewPanel
        status="running"
        previewUrl="http://localhost:3000"
        onCorrectionSubmit={vi.fn()}
        onCollectDomContext={onCollectDomContext}
      />
    </Provider>,
  )
  // 打开「纠错」开关，露出透明捕获层
  fireEvent.click(screen.getByText('纠错'))
  return rendered
}

describe('Sprint 3 点选纠错 · 高亮被选区域（R-CORR-01）', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('[S3-CORRECT-001] 命中真实元素时渲染区域高亮（selected-preview-element-highlight）', async () => {
    const onCollectDomContext = vi.fn().mockResolvedValue(region)
    const { container } = renderPanel(onCollectDomContext)

    const layer = container.querySelector('[data-ai-id="correction-capture-layer"]')
    expect(layer).toBeTruthy()
    fireEvent.click(layer as Element)

    await waitFor(() => {
      expect(container.querySelector('[data-ai-id="selected-preview-element-highlight"]')).toBeTruthy()
    })
    // 命中元素后不再渲染红点标记
    expect(container.querySelector('[data-ai-id="point-correction-popover"]')).toBeNull()
    expect(onCollectDomContext).toHaveBeenCalledOnce()
  })

  it('[S3-CORRECT-005] 降级（fallback_mode true）时回退红点标记，不渲染区域高亮', async () => {
    const onCollectDomContext = vi.fn().mockResolvedValue({
      bounding_rect: { x: 0, y: 0, width: 0, height: 0 },
      fallback_mode: true,
    })
    const { container } = renderPanel(onCollectDomContext)

    const layer = container.querySelector('[data-ai-id="correction-capture-layer"]')
    expect(layer).toBeTruthy()
    fireEvent.click(layer as Element)

    await waitFor(() => {
      expect(container.querySelector('[data-ai-id="point-correction-popover"]')).toBeTruthy()
    })
    expect(container.querySelector('[data-ai-id="selected-preview-element-highlight"]')).toBeNull()
  })

  it('未提供 onCollectDomContext 时点击后回退红点标记（向后兼容）', async () => {
    const { container } = renderPanel(undefined)

    const layer = container.querySelector('[data-ai-id="correction-capture-layer"]')
    expect(layer).toBeTruthy()
    fireEvent.click(layer as Element)

    // 未收集 DOM 上下文 → 红点标记，弹窗仍可用
    await waitFor(() => {
      expect(container.querySelector('[data-ai-id="point-correction-popover"]')).toBeTruthy()
    })
    expect(container.querySelector('[data-ai-id="selected-preview-element-highlight"]')).toBeNull()
  })
})

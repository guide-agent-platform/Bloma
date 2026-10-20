// @vitest-environment jsdom

/**
 * DeliveryPanel 交付面板（2026-10-04 呈现层收口；同日审计 A-02 修复后）：
 * - 快照渲染：文件清单 + DELIVERY.md；
 * - 启动按钮状态机：can_launch=true 可点并回报 pid；false 时按钮禁用 + 缺口提示；
 * - 空态：无数据且非加载时给出引导文案（A-8 空态修复）；
 * - 数据经 window.electronAPI.projectDeliverables（mock）——与 preload 暴露名一致
 *   （原先 mock window.bloma 掩盖了生产死链）。
 */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { configure } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Provider, createStore } from 'jotai'
import { DeliveryPanel } from '../../renderer/components/DeliveryPanel'
import { currentProjectAtom } from '../../renderer/agent-atoms'

configure({ testIdAttribute: 'data-ai-id' })

interface PanelState {
  deliverables: {
    files: string[]
    delivery_md?: string
    launch: { declared: boolean; parse_ok: boolean; parse_error?: string; command?: string[] }
    can_launch: boolean
  }
  launchResult?: { ok: boolean; data?: { started: boolean; pid?: number }; error?: { message?: string } }
}

function mockBloma(state: PanelState): void {
  const get = vi.fn(async () => ({ ok: true, data: state.deliverables }))
  const launch = vi.fn(async () => state.launchResult ?? { ok: true, data: { started: true, pid: 777 } })
  ;(window as unknown as { electronAPI: unknown }).electronAPI = { projectDeliverables: { get, launch } }
}

function renderPanel(stage: string): void {
  const store = createStore()
  store.set(currentProjectAtom, { project_id: 'p1', current_stage: stage, template_type: 'desktop_tool' } as never)
  render(
    <Provider store={store}>
      <DeliveryPanel />
    </Provider>,
  )
}

describe('DeliveryPanel', () => {
  it('keeps the newest launch declaration when an older refresh arrives late', async () => {
    let resolveOld!: (value: unknown) => void
    const old = new Promise(resolve => { resolveOld = resolve })
    const current = { files: ['app.py', 'LAUNCH.json'], launch: { declared: true, parse_ok: true }, can_launch: true }
    const get = vi.fn().mockReturnValueOnce(old).mockResolvedValue({ ok: true, data: current })
    ;(window as unknown as { electronAPI: unknown }).electronAPI = { projectDeliverables: { get, launch: vi.fn() } }
    renderPanel('completed')
    fireEvent.click(screen.getByRole('button', { name: '刷新产物' }))
    await waitFor(() => expect((screen.getByTestId('delivery-launch-button') as HTMLButtonElement).disabled).toBe(false))
    await act(async () => resolveOld({ ok: true, data: { files: [], launch: { declared: false, parse_ok: false }, can_launch: false } }))
    expect(screen.queryByTestId('delivery-launch-hint')).toBeNull()
    expect((screen.getByTestId('delivery-launch-button') as HTMLButtonElement).disabled).toBe(false)
  })
  beforeEach(() => {
    ;(window as unknown as { electronAPI: unknown }).electronAPI = undefined
  })
  afterEach(() => cleanup())

  it('渲染文件清单与 DELIVERY.md；completed + 合法声明 → 启动可点并回报 pid', async () => {
    mockBloma({
      deliverables: {
        files: ['calculator.py', 'DELIVERY.md', 'LAUNCH.json'],
        delivery_md: '# 科学计算器\n\n运行：python calculator.py',
        launch: { declared: true, parse_ok: true, command: ['python', 'calculator.py'] },
        can_launch: true,
      },
    })
    renderPanel('completed')
    await waitFor(() => expect(screen.getByTestId('delivery-file-list').textContent).toContain('calculator.py'))
    expect(screen.getByTestId('delivery-md').textContent).toContain('科学计算器')
    const button = screen.getByTestId('delivery-launch-button') as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByTestId('delivery-launch-state').textContent).toContain('777'))
  })

  it('缺 LAUNCH.json → 按钮禁用 + 缺口提示如实', async () => {
    mockBloma({
      deliverables: {
        files: ['app.py'],
        launch: { declared: false, parse_ok: false },
        can_launch: false,
      },
    })
    renderPanel('completed')
    await waitFor(() => expect(screen.getByTestId('delivery-launch-hint').textContent).toContain('LAUNCH.json'))
    expect((screen.getByTestId('delivery-launch-button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('未完成项目 → 提示完成后可启动', async () => {
    mockBloma({
      deliverables: {
        files: ['app.py'],
        launch: { declared: true, parse_ok: true },
        can_launch: false,
      },
    })
    renderPanel('generating_mvp')
    await waitFor(() => expect(screen.getByTestId('delivery-launch-hint').textContent).toContain('项目完成后可启动'))
  })

  it('无数据且非加载 → 空态引导文案（A-8）', async () => {
    renderPanel('clarifying')
    await waitFor(() => expect(screen.getByTestId('delivery-empty').textContent).toContain('还没有可展示的交付内容'))
  })
})

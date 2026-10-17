// @vitest-environment jsdom
// 草图点选标记浮条（批11 ①）+ App 接线回归（2026-10-09 修复）：
// 狗粮实锤（run 16:48）：postMessage pm-sent 但 sketch-picks-send not-found——
// 根因是 App.tsx 未给 WorkspaceShell 传 onConfirmSketch，PreviewPanel 的
// bloma-sketch-pick 监听与浮条渲染整体以 onConfirmSketch 为前提而未接线。
// 用例锁：P1 监听+浮条出现；P2 发送链（sendMessage 带 source=sketch_correction）；
// P3 未传 onConfirmSketch 时不注册监听（浮条永不出现）；P4 App 源码接线形状。
import React from 'react'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PreviewPanel } from '../../renderer/components/PreviewPanel'
import { activeAgentSessionIdAtom, currentProjectAtom, workflowStageAtom } from '../../renderer/components/atoms'
import type { Project } from '../../shared/types'

const PICK = {
  seq: 1,
  kind: 'layout',
  kindLabel: '布局问题',
  target: '区域（记录列表）',
  text: '',
  note: '列表区太挤，留白多一点',
  rect: { x: 8, y: 120, w: 400, h: 300 },
}

describe('ux-sketch-picks-panel：草图点选标记浮条与发送链', () => {
  let store: ReturnType<typeof createStore>
  let sendMessage: ReturnType<typeof vi.fn>

  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    store.set(workflowStageAtom, 'sketch_ready')
    store.set(activeAgentSessionIdAtom, 's1')
    store.set(currentProjectAtom, {
      project_id: 'p1',
      workspace_slug: 'p1',
      name: 'P1',
      mode: 'quick',
      template_type: 'desktop_tool',
      status: 'active',
      current_stage: 'sketch_ready',
      root_path: 'C:/tmp/p1',
    } as never as Project)
    sendMessage = vi.fn().mockResolvedValue(undefined)
    ;(window as never as { electronAPI: unknown }).electronAPI = { agent: { sendMessage } }
  })
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    cleanup()
  })

  const mount = (props: { onConfirmSketch?: () => void; reviewUrl?: string } = {}) =>
    render(
      <Provider store={store}>
        <PreviewPanel status="running" previewUrl="http://127.0.0.1:1/sketch.html" {...props} />
      </Provider>,
    )
  const bar = () => document.querySelector('[data-ai-id="sketch-picks-bar"]')
  const sendBtn = () => document.querySelector('[data-ai-id="sketch-picks-send"]') as HTMLButtonElement | null
  const postPick = () => window.postMessage({ label: 'bloma-sketch-pick', pick: PICK }, '*')

  it('状态说明独立切换，返回主界面不改变确认对象', () => {
    const confirm = vi.fn()
    const view = mount({ onConfirmSketch: confirm, reviewUrl: 'bloma-file://p1/00_UX/ux-state-review.html' })
    fireEvent.click(view.getByRole('tab', { name: '交互与状态说明' }))
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('ux-state-review.html')
    expect(view.queryByText(/已确认的界面/)).toBeNull()
    fireEvent.click(view.getByRole('tab', { name: '界面预览' }))
    expect(document.querySelector('iframe')?.getAttribute('src')).toContain('sketch.html')
    expect(confirm).not.toHaveBeenCalled()
  })

  it('[P1] 传入 onConfirmSketch：postMessage 标记 → 浮条出现并显示计数与目标', async () => {
    mount({ onConfirmSketch: () => {} })
    expect(bar()).toBeNull()
    postPick()
    await waitFor(() => expect(bar()).toBeTruthy())
    expect(bar()!.textContent).toContain('已标记 1 处')
    expect(bar()!.textContent).toContain('区域（记录列表）')
    expect(sendBtn()).toBeTruthy()
  })

  it('[P2] 点「发送调整意见」→ sendMessage 带标记文案与 source=sketch_correction，发送后清空标记', async () => {
    mount({ onConfirmSketch: () => {} })
    postPick()
    await waitFor(() => expect(sendBtn()).toBeTruthy())
    fireEvent.click(sendBtn()!)
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    const arg = sendMessage.mock.calls[0]![0] as Record<string, unknown>
    expect(arg.session_id).toBe('s1')
    expect(arg.project_id).toBe('p1')
    expect(arg.mode).toBe('quick')
    expect(arg.current_stage).toBe('sketch_ready')
    expect(arg.metadata).toEqual({ source: 'sketch_correction' })
    expect(String(arg.content)).toContain('我在草图上标记了 1 处不满意的地方')
    expect(String(arg.content)).toContain('区域（记录列表）——布局问题：「列表区太挤，留白多一点」')
  })

  it('[P3] 未传 onConfirmSketch：监听不注册，postMessage 后浮条永不出现', async () => {
    mount()
    postPick()
    // 事件分发是同步派发到已注册监听器；等待一拍确认无异步渲染
    await new Promise((r) => setTimeout(r, 50))
    expect(bar()).toBeNull()
    expect(sendBtn()).toBeNull()
  })
})

describe('ux-sketch-picks-panel：App 接线回归（源码形状）', () => {
  it('[P4] App.tsx 给 WorkspaceShell 传 onConfirmSketch 且落到 handleConfirmSketch（ux_confirm_go 同路）', () => {
    const src = readFileSync(
      join(resolve(__dirname, '../../renderer/components'), 'App.tsx'),
      'utf8',
    )
    expect(src).toContain('onConfirmSketch={handleConfirmSketch}')
    expect(src).toMatch(/handleConfirmSketch[\s\S]*?id: 'ux_confirm_go'/)
  })
})

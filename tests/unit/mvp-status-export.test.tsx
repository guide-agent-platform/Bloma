// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MvpStatusBanner } from '../../renderer/components/MvpStatusBanner'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
  currentProjectAtom,
  globalUserErrorAtom,
} from '../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI } from '../../shared/types'

/**
 * PR-3 导出按钮（2026-09-03）：ready/judge_pass 横幅显示「导出项目」；
 * 点击走 window.electronAPI.project.export（U10 通道，四层已就绪）；
 * 取消静默复位 / 成功展示路径 / IPC 失败走 globalUserError（m-16 口径）。
 * 锚点 data-ai-id（陷阱 30）；非 globals 模式 RTL 手动 cleanup。
 */

configure({ testIdAttribute: 'data-ai-id' })

function mvpReadyEvent(): AgentEvent {
  return {
    event_id: crypto.randomUUID(),
    session_id: 'session-exp',
    project_id: 'project-exp',
    type: 'mvp_ready',
    payload: { summary: '功能已生成', preview_url: 'http://127.0.0.1:3000' },
    created_at: new Date().toISOString(),
  }
}

describe('MvpStatusBanner 导出项目按钮（PR-3）', () => {
  let store: ReturnType<typeof createStore>
  let exportMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    exportMock = vi.fn()
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-exp')
    store.set(currentProjectAtom, {
      project_id: 'project-exp',
      name: '测试项目',
      workspace_slug: 'default-software-builder',
      mode: 'quick',
      status: 'active',
      current_stage: 'testing',
      security_repair_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    window.electronAPI = {
      project: { export: exportMock },
    } as unknown as ElectronAPI
    store.set(agentStreamStateFamily('session-exp'), {
      running: false,
      events: [mvpReadyEvent()],
      content: '',
    } as never)
  })

  afterEach(() => {
    delete window.electronAPI
    delete window.__jotai_store__
    cleanup()
  })

  function renderBanner(): void {
    render(
      <Provider store={store}>
        <MvpStatusBanner />
      </Provider>,
    )
  }

  it('mvp_ready → 显示导出按钮；点击调 export 且带 project_id', async () => {
    exportMock.mockResolvedValue({ ok: true, data: { canceled: false, destination: 'D:/out/测试项目', file_count: 5 } })
    renderBanner()

    const btn = screen.getByTestId('export-project-btn')
    expect(btn.textContent).toContain('导出项目')
    fireEvent.click(btn)

    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledTimes(1)
      expect(exportMock).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project-exp' }))
    })
    await waitFor(() => {
      expect(screen.getByTestId('export-project-done').textContent).toContain('D:/out/测试项目')
    })
  })

  it('用户取消导出（canceled）→ 静默复位：不显示路径、不写 globalUserError', async () => {
    exportMock.mockResolvedValue({ ok: true, data: { canceled: true } })
    renderBanner()

    fireEvent.click(screen.getByTestId('export-project-btn'))
    await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(1))
    // 取消后按钮回到可再次导出的初始态
    await waitFor(() => expect(screen.getByTestId('export-project-btn').textContent).toContain('导出项目'))
    expect(store.get(globalUserErrorAtom)).toBeNull()
    expect(screen.queryByTestId('export-project-done')).toBeNull()
  })

  it('IPC 失败 → globalUserError（m-16 口径），不显示成功路径', async () => {
    exportMock.mockResolvedValue({
      ok: false,
      request_id: 'r1',
      error: { code: 'NOT_FOUND', message: '项目不存在', retryable: false, user_visible_message: '项目不存在，可能已被删除。' },
    })
    renderBanner()

    fireEvent.click(screen.getByTestId('export-project-btn'))
    await waitFor(() => expect(store.get(globalUserErrorAtom)).toBe('项目不存在，可能已被删除。'))
    expect(screen.queryByTestId('export-project-done')).toBeNull()
  })

  it('无 currentProject（项目未建立）→ 按钮禁用；generating 状态不渲染按钮', () => {
    store.set(currentProjectAtom, null)
    renderBanner()
    expect((screen.getByTestId('export-project-btn') as HTMLButtonElement).disabled).toBe(true)

    cleanup()
    store.set(currentProjectAtom, { project_id: 'project-exp' } as never)
    store.set(agentStreamStateFamily('session-exp'), {
      running: false,
      events: [],
      content: '',
    } as never)
    renderBanner()
    // 无 mvp_ready 事件且阶段非就绪 → 横幅走 generating 变体或不可见，均不应出现导出按钮
    expect(screen.queryByTestId('export-project-btn')).toBeNull()
  })
})

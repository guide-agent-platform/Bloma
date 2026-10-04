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
  workflowStageAtom,
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
  let upgradeMock: ReturnType<typeof vi.fn>
  let switchStateMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    exportMock = vi.fn()
    upgradeMock = vi.fn()
    switchStateMock = vi.fn(async () => ({ ok: true, data: { switches: {} } }))
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
      project: { export: exportMock, upgradeExport: upgradeMock },
      app: { switchState: switchStateMock },
    } as unknown as ElectronAPI
    store.set(agentStreamStateFamily('session-exp'), {
      running: false,
      events: [],
      content: '',
    } as never)
    store.set(workflowStageAtom, 'completed')
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

  it('无 currentProject（项目未建立）→ 按钮禁用；generating 运行中不渲染按钮；无运行时降级为旧线静态卡（B-01）', () => {
    store.set(currentProjectAtom, null)
    renderBanner()
    expect((screen.getByTestId('export-project-btn') as HTMLButtonElement).disabled).toBe(true)

    // 运行中的 generating：动画卡，无导出按钮（进行中不能导出——原语义保留）
    cleanup()
    store.set(currentProjectAtom, { project_id: 'project-exp' } as never)
    store.set(workflowStageAtom, 'generating_mvp')
    store.set(agentStreamStateFamily('session-exp'), {
      running: true,
      events: [],
      content: '',
    } as never)
    renderBanner()
    expect(screen.queryByTestId('export-project-btn')).toBeNull()

    // 无运行的 generating（旧线项目停在上次中断处）：降级为静态说明卡（B-01），
    // 不再显示进行时动画；数据保留可导出是核心出路 → 保留导出按钮
    cleanup()
    store.set(agentStreamStateFamily('session-exp'), {
      running: false,
      events: [],
      content: '',
    } as never)
    renderBanner()
    expect(screen.getByTestId('mvp-status-banner').textContent).toContain('网页生成线已下线')
    expect(screen.getByTestId('export-project-btn')).toBeTruthy()
  })
})

describe('MvpStatusBanner 升级导出（Phase 10 落地旅程）', () => {
  let store: ReturnType<typeof createStore>
  let exportMock: ReturnType<typeof vi.fn>
  let upgradeMock: ReturnType<typeof vi.fn>
  let switchStateMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    exportMock = vi.fn()
    upgradeMock = vi.fn()
    switchStateMock = vi.fn(async () => ({ ok: true, data: { switches: {} } }))
    store = createStore()
    window.__jotai_store__ = store as never
    store.set(activeAgentSessionIdAtom, 'session-exp')
    store.set(currentProjectAtom, {
      project_id: 'project-exp',
      name: '测试项目',
      workspace_slug: 'default-software-builder',
      mode: 'quick',
      status: 'active',
      current_stage: 'ready',
      security_repair_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never)
    window.electronAPI = {
      project: { export: exportMock, upgradeExport: upgradeMock },
      app: { switchState: switchStateMock },
    } as unknown as ElectronAPI
    store.set(workflowStageAtom, 'completed')
    store.set(agentStreamStateFamily('session-exp'), {
      running: false,
      events: [],
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

  async function exportOnce(): Promise<void> {
    exportMock.mockResolvedValue({ ok: true, data: { canceled: false, destination: 'D:/out/测试项目', file_count: 5 } })
    renderBanner()
    fireEvent.click(screen.getByTestId('export-project-btn'))
    await waitFor(() => expect(screen.getByTestId('export-project-done')).toBeTruthy())
  }

  it('导出前无升级按钮；导出后出现，点击调 upgradeExport 带项目 id，成功显示迁移结果', async () => {
    exportMock.mockResolvedValue({ ok: true, data: { canceled: false, destination: 'D:/out/测试项目', file_count: 5 } })
    renderBanner()
    expect(screen.queryByTestId('upgrade-export-btn')).toBeNull()
    fireEvent.click(screen.getByTestId('export-project-btn'))
    await waitFor(() => expect(screen.getByTestId('export-project-done')).toBeTruthy())

    upgradeMock.mockResolvedValue({
      ok: true,
      data: { canceled: false, target: 'D:/out/测试项目-upgraded', migration: 'ran', summary: '迁移通过（1→2，1 个数据文件）', drift: { clean: true, changed: 0, missing: 0, extra: 0 } },
    })
    fireEvent.click(screen.getByTestId('upgrade-export-btn'))
    await waitFor(() => {
      expect(upgradeMock).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'project-exp' }))
      expect(screen.getByTestId('upgrade-export-note').textContent).toContain('迁移通过')
    })
  })

  it('迁移失败口径如实：旧数据已携带备份+报告指引；漂移痕迹如实呈现', async () => {
    await exportOnce()
    upgradeMock.mockResolvedValue({
      ok: true,
      data: { canceled: false, target: 'D:/out/测试项目-upgraded', migration: 'failed', summary: '演练失败', drift: { clean: false, changed: 2, missing: 1, extra: 1 } },
    })
    fireEvent.click(screen.getByTestId('upgrade-export-btn'))
    await waitFor(() => {
      const note = screen.getByTestId('upgrade-export-note').textContent ?? ''
      expect(note).toContain('迁移未过')
      expect(note).toContain('已原样携带并备份')
      expect(note).toContain('手改痕迹 4 处')
    })
  })

  it('取消升级静默复位；IPC 失败走 globalUserError', async () => {
    await exportOnce()
    upgradeMock.mockResolvedValue({ ok: true, data: { canceled: true } })
    fireEvent.click(screen.getByTestId('upgrade-export-btn'))
    await waitFor(() => expect(upgradeMock).toHaveBeenCalledTimes(1))
    expect(screen.queryByTestId('upgrade-export-note')).toBeNull()
    expect(store.get(globalUserErrorAtom)).toBeNull()

    upgradeMock.mockResolvedValue({ ok: false, error: { message: 'boom' } })
    fireEvent.click(screen.getByTestId('upgrade-export-btn'))
    await waitFor(() => expect(store.get(globalUserErrorAtom)).not.toBeNull())
  })
})

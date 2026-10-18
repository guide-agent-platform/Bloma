// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../renderer/components/App'
import type { ElectronAPI, Project, Snapshot } from '../../../shared/types'

/**
 * Sprint 3 · P0 时间轴回滚真实现（原为假实现：只插系统消息不调 IPC）。
 *
 * 覆盖：点击非当前快照 → 确认弹窗 → 调 snapshots.rollback（user_undo）
 * 并如实播报；失败/异常 → 不播报成功、如实告知当前版本未被改动。
 */

function project(): Project {
  return {
    project_id: 'role-roll-quick',
    workspace_slug: 'default-software-builder',
    name: '回滚验收项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'ready',
    root_path: 'C:/role-roll/quick',
    created_at: '2026-08-14T00:00:00.000Z',
    updated_at: '2026-08-14T00:00:00.000Z',
  }
}

function snapshot(snapshotId: string, name: string): Snapshot {
  return {
    snapshot_id: snapshotId,
    project_id: 'role-roll-quick',
    kind: 'sketch',
    name,
    summary: `${name} 摘要`,
    files_archive_path: `C:/snapshots/${snapshotId}/files`,
    health_status: 'healthy',
    created_at: '2026-08-14T16:36:23.415Z',
  }
}

const SNAPSHOTS = [snapshot('snap-sketch', 'sketch-a'), snapshot('snap-mvp', 'mvp-b')]

describe('Sprint 3 时间轴回滚（P0：真调 IPC）', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  /**
   * 走「回访恢复」路径挂载工作区（新建项目路径会按设计清空时间轴）：
   * project.list 返回活动项目 → 启动恢复效应进工作区并回填快照列表。
   */
  async function mountApp(rollback: ReturnType<typeof vi.fn>) {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'req-p-list', data: [project()] }),
      },
      snapshots: {
        list: vi.fn().mockResolvedValue({ ok: true, request_id: 'req-list', data: { snapshots: SNAPSHOTS } }),
        rollback,
      },
    } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <App />
      </Provider>,
    )
    // 版本时间轴现在按需出现在“版本与回看”侧栏中。
    fireEvent.click(await screen.findByRole('button', { name: /^版本$/ }))
    return store
  }

  it('点击非当前快照 → 确认弹窗 → 调 snapshots.rollback 并如实播报', async () => {
    const rollback = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'req-roll',
      data: {
        rolled_back: true as const,
        project_id: 'role-roll-quick',
        current_snapshot_id: 'snap-sketch',
        guard_snapshot_id: 'snap-guard',
        preview_url: 'http://localhost:4173',
      },
    })
    await mountApp(rollback)

    await waitFor(() => expect(screen.getByTitle('回到「sketch-a」')).toBeTruthy())
    fireEvent.click(screen.getByTitle('回到「sketch-a」'))

    // 确认弹窗（时间轴自身的确认，主进程还有一道权限确认）
    fireEvent.click(screen.getByRole('button', { name: '确认回到这里' }))

    await waitFor(() => expect(rollback).toHaveBeenCalledOnce())
    expect(rollback).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'role-roll-quick',
        snapshot_id: 'snap-sketch',
        reason: 'user_undo',
      }),
    )
    await waitFor(() => expect(screen.getByText(/已经回到「sketch-a」/)).toBeTruthy())
  })

  it('回滚失败（ok:false）→ 不播报成功，如实告知当前版本未被改动', async () => {
    const rollback = vi.fn().mockResolvedValue({
      ok: false,
      request_id: 'req-roll-fail',
      error: { code: 'PERMISSION_DENIED:rollback_snapshot', message: 'denied' },
    })
    await mountApp(rollback)

    await waitFor(() => expect(screen.getByTitle('回到「sketch-a」')).toBeTruthy())
    fireEvent.click(screen.getByTitle('回到「sketch-a」'))
    fireEvent.click(screen.getByRole('button', { name: '确认回到这里' }))

    await waitFor(() => expect(screen.getByText(/当前版本没有被改动/)).toBeTruthy())
    expect(screen.queryByText(/已经回到/)).toBeNull()
  })

  it('回滚 IPC 异常 → 如实告知，不播报成功', async () => {
    const rollback = vi.fn().mockRejectedValue(new Error('ipc broken'))
    await mountApp(rollback)

    await waitFor(() => expect(screen.getByTitle('回到「sketch-a」')).toBeTruthy())
    fireEvent.click(screen.getByTitle('回到「sketch-a」'))
    fireEvent.click(screen.getByRole('button', { name: '确认回到这里' }))

    await waitFor(() => expect(screen.getByText(/回滚出错了/)).toBeTruthy())
    expect(screen.queryByText(/已经回到/)).toBeNull()
  })
})

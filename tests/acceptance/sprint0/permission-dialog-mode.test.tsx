// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionDialog } from '../../../renderer/components/PermissionDialog'
import { permissionModeAtom } from '../../../renderer/components/atoms-sprint2'
import { pendingPermissionRequestsAtom, setupGlobalAgentListeners } from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI, PermissionRequest } from '../../../shared/types'

/**
 * Sprint 0 · 权限弹窗模式契约（F8 / @S3-JUDGE-009）
 *
 * 统一契约：**dangerous 必须人工确认，与模式无关**；allow-all = 除 dangerous 外自动放行。
 *
 * 对抗审查 F8 修复前，PermissionDialog 的 allow-all 分支会「全部自动放行（含 dangerous）」
 * 且非 ask 模式不渲染弹窗——与主进程 canUseTool（allow-all 时 dangerous 落 pending 等用户）
 * 矛盾。本套件把统一契约固化为可执行断言（先红后绿）。
 *
 * 文档依据：self-healing-judge.feature @S3-JUDGE-009、permission-service.ts 契约注释。
 */

function permissionRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id: 'perm-req-1',
    session_id: 'session-x',
    project_id: 'project-x',
    tool_name: 'rollback_snapshot',
    tool_input: { project_id: 'project-x', snapshot_id: 'snap-1' },
    danger_level: 'dangerous',
    user_visible_summary: '需要确认高风险操作：回滚到历史快照',
    created_at: '2026-08-23T00:00:00.000Z',
    ...overrides,
  }
}

/** 取当前挂载的 respond mock（挂载后 window.electronAPI 必已注入） */
function respondMock(): ReturnType<typeof vi.fn> {
  const permissions = (window as { electronAPI?: { permissions?: { respond?: unknown } } }).electronAPI?.permissions
  return permissions?.respond as ReturnType<typeof vi.fn>
}

function mountDialog(mode: 'safe' | 'ask' | 'allow-all', request: PermissionRequest) {
  const store = createStore()
  store.set(permissionModeAtom, mode)
  store.set(pendingPermissionRequestsAtom, new Map([[request.session_id, [request]]]))
  const respond = vi.fn().mockResolvedValue({ ok: true, request_id: 'req-respond' })
  window.electronAPI = {
    permissions: { respond },
  } as unknown as ElectronAPI
  const rendered = render(
    <Provider store={store}>
      <PermissionDialog />
    </Provider>,
  )
  return { store, respond, ...rendered }
}

describe('PermissionDialog 模式契约（F8：dangerous 人工确认与模式无关）', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S0-PERM-DIALOG-001] allow-all + dangerous：不得自动放行，弹窗可见等用户确认', async () => {
    mountDialog('allow-all', permissionRequest())

    // 弹窗必须渲染（dangerous 与模式无关，必须人工确认）
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())

    // 不得出现任何自动 respond（契约核心：不自动放行、不自动拒绝）
    // effect 自动处理在挂载后立即发生；等两个宏任务确保 effect 已跑完
    await Promise.resolve()
    await Promise.resolve()
    expect(respondMock())
      .not.toHaveBeenCalled()
  })

  it('[S0-PERM-DIALOG-002] allow-all + warning：自动放行（无需人工确认）', async () => {
    mountDialog(
      'allow-all',
      permissionRequest({
        tool_name: 'generate_sketch',
        danger_level: 'warning',
        user_visible_summary: '需要确认：生成验证草图',
      }),
    )

    await waitFor(() =>
      expect(respondMock())
        .toHaveBeenCalledWith(expect.objectContaining({ decision: 'allow' })),
    )
  })

  it('[S0-PERM-DIALOG-003] safe + dangerous：自动拒绝（不弹窗）', async () => {
    mountDialog('safe', permissionRequest())

    await waitFor(() =>
      expect(respondMock())
        .toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' })),
    )
    // safe 模式不弹窗
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('[S0-PERM-DIALOG-004] ask + dangerous：不自动响应，弹窗可见', async () => {
    mountDialog('ask', permissionRequest())

    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy())
    await Promise.resolve()
    await Promise.resolve()
    expect(respondMock())
      .not.toHaveBeenCalled()
  })

  it('[S0-PERM-DIALOG-005] 收到 permission_mode_changed 广播后 permissionModeAtom 随主进程同步', () => {
    // F8 atom 同步链路：主进程 setMode → stream 广播 → 全局监听器写 atom。
    // 模拟监听器接线（main.tsx 的 setupGlobalAgentListeners 消费 onStreamEvent 回调）。
    const store = createStore()
    window.__jotai_store__ = store
    let listener: ((event: AgentEvent) => void) | undefined
    window.electronAPI = {
      agent: {
        onStreamEvent: (cb: (event: AgentEvent) => void) => {
          listener = cb
          return () => undefined
        },
      },
    } as unknown as ElectronAPI
    const cleanupListeners = setupGlobalAgentListeners()
    expect(listener).toBeTruthy()

    expect(store.get(permissionModeAtom)).toBe('ask') // 初始默认
    listener!({
      event_id: 'evt-mode-1',
      session_id: 'permission-mode-allow-all',
      type: 'permission_mode_changed',
      payload: { mode: 'allow-all' },
      created_at: new Date().toISOString(),
    })
    expect(store.get(permissionModeAtom)).toBe('allow-all')

    listener!({
      event_id: 'evt-mode-2',
      session_id: 'permission-mode-safe',
      type: 'permission_mode_changed',
      payload: { mode: 'safe' },
      created_at: new Date().toISOString(),
    })
    expect(store.get(permissionModeAtom)).toBe('safe')

    // 非法模式值不得写入 atom（防御：保持原值）
    listener!({
      event_id: 'evt-mode-3',
      session_id: 'permission-mode-bad',
      type: 'permission_mode_changed',
      payload: { mode: 'yolo' },
      created_at: new Date().toISOString(),
    })
    expect(store.get(permissionModeAtom)).toBe('safe')

    cleanupListeners()
  })
})

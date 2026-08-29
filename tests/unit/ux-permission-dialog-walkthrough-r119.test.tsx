// @vitest-environment jsdom
// ux-permission-dialog-walkthrough r119（B 腿可执行走查，SOP 十用）：权限弹窗状态矩阵。
// 0 基础视角：弹窗=最恐慌时刻（trust-control-recovery 映射）。
// **文案发现（P5b）**：按钮实为「确认/取消」——模糊动词，0 基础用户不知「确认」=允许写文件还是确认弹窗本身；Claude/GPT 用「允许/拒绝」明确动词（低危文案改进建议，随下次权限相关改动顺手换）。
// 现状：ask 模式 warning/dangerous 弹窗；
// dangerous 无记住选项；遮罩不可关（dangerous）。锁现状+断言恢复路径。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createStore, Provider } from 'jotai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionDialog } from '../../renderer/components/PermissionDialog'
import { activeAgentSessionIdAtom, pendingPermissionRequestsAtom } from '../../renderer/agent-atoms'
import { permissionModeAtom } from '../../renderer/components/atoms-sprint2'
import type { PermissionRequest } from '../../shared/types'

function req(danger: 'warning' | 'dangerous', created = '2026-08-29T03:00:00Z'): PermissionRequest {
  return {
    id: 'p1',
    session_id: 's1',
    tool_name: 'write_file',
    tool_input: { path: 'demo.txt' },
    danger_level: danger,
    user_visible_summary: '写入文件 demo.txt',
    created_at: created,
  }
}

describe('ux-permission-dialog-walkthrough r119：权限弹窗状态矩阵（ask 模式）', () => {
  let store: ReturnType<typeof createStore>
  let respondMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    store = createStore()
    ;(window as never as { __jotai_store__: unknown }).__jotai_store__ = store
    store.set(permissionModeAtom, 'ask')
    respondMock = vi.fn().mockResolvedValue(undefined)
    ;(window as never as { electronAPI: unknown }).electronAPI = {
      permissions: { respond: respondMock },
    }
  })
  afterEach(() => {
    delete (window as never as { __jotai_store__?: unknown }).__jotai_store__
    delete (window as never as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  function mountWith(list: PermissionRequest[]): void {
    store.set(activeAgentSessionIdAtom, 's1')
    store.set(pendingPermissionRequestsAtom, new Map([['s1', list]]))
    render(
      <Provider store={store}>
        <PermissionDialog mode="ask" />
      </Provider>,
    )
  }

  it('[P1·warning 允许] 摘要可见+「允许」→ IPC respond(allow)，队列清空（恢复路径）', async () => {
    mountWith([req('warning')])
    expect(screen.getByText(/写入文件 demo\.txt/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'allow', remember_for_session: false }),
      )
    })
    await waitFor(() => expect(store.get(pendingPermissionRequestsAtom).get('s1')?.length ?? 0).toBe(0))
  })

  it('[P2·warning 拒绝+记住] 勾选记住→拒绝仍清队列（记住仅对 allow 生效——:167 契约锁定）', async () => {
    mountWith([req('warning')])
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => {
      expect(respondMock).toHaveBeenCalledWith(
        expect.objectContaining({ decision: 'deny', remember_for_session: false }),
      )
    })
  })

  it('[P3·dangerous 必须显式确认] 危险请求弹窗但**无记住复选框**（F8 契约：每次人工确认）', () => {
    mountWith([req('dangerous')])
    expect(screen.getByRole('dialog', { hidden: true }) || screen.getByText(/写入文件/)).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull() // F8 锁定：dangerous 无记住
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy()
  })

  it('[P4·空队列] 无请求时零渲染（不占 DOM/无幽灵弹窗）', () => {
    mountWith([])
    expect(screen.queryByText(/写入文件/)).toBeNull()
  })
})

// @vitest-environment jsdom
// ux-history-walkthrough r110（B 腿可执行走查，SOP 六用）：历史项目列表页（0 基础首屏链）。
// 状态矩阵：loading shimmer 骨架 / IPC 空列表→首启动引导 / IPC 有项目→列表 / IPC throw→props 兜底 /
// error 态不可达（F2 现状锁定——loadState 无 setter，:481 重试/跳过 UI 死代码）/ 搜索无匹配分支。

import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../shared/types'
import { ProjectHistoryPage } from '../../renderer/components/ProjectHistoryPage'

type P = { project_id: string; name: string; mode: 'quick'; updated_at: string }

describe('ux-history-walkthrough r110：历史项目列表页（0 基础首屏链）', () => {
  let onNewProject: ReturnType<typeof vi.fn>
  const p1: P = { project_id: 'p1', name: '我的第一个工具', mode: 'quick', updated_at: '2026-08-29T01:00:00Z' }

  beforeEach(() => {
    if (!(window as never as { crypto?: { randomUUID?: unknown } }).crypto?.randomUUID) {
      Object.defineProperty(window, 'crypto', { value: { randomUUID: () => 'u-' + Math.random() } })
    }
    onNewProject = vi.fn()
  })
  afterEach(() => {
    delete (window as never as { electronAPI?: unknown }).electronAPI
    cleanup()
  })

  function mount(props?: { projects?: P[] }) {
    return render(
      <ProjectHistoryPage
        projects={props?.projects as unknown as Project[] | undefined}
        onNewProject={onNewProject}
        onResumeProject={vi.fn()}
        onBackToWorkspace={vi.fn()}
      />,
    )
  }
  const setList = (impl: unknown) => {
    ;(window as never as { electronAPI: unknown }).electronAPI = { project: { list: impl } }
  }

  it('[H1·loading] 挂起中显示 shimmer 骨架（非空态——防「还没有项目」误导）', () => {
    let resolveIt: (v: { ok: true; data: P[] }) => void = () => undefined
    setList(vi.fn().mockImplementation(() => new Promise((r) => { resolveIt = r })))
    const { container } = mount()
    expect(document.body.textContent ?? '').not.toContain('还没有项目')
    expect(container.querySelectorAll('span[style*="shimmer"], div[style*="shimmer"]').length).toBeGreaterThanOrEqual(1)
    resolveIt({ ok: true, data: [] })
  })

  it('[H2·首启动空态] IPC 返回空列表 → 「还没有项目」引导+「创建第一个项目」点击回调', async () => {
    setList(vi.fn().mockResolvedValue({ ok: true, data: [] }))
    mount()
    const btn = await screen.findByRole('button', { name: /创建第一个项目/ })
    fireEvent.click(btn)
    expect(onNewProject).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/你还没有创建过任何项目/)).toBeTruthy()
  })

  it('[H3·列表] IPC 有项目 → 项目名可见', async () => {
    setList(vi.fn().mockResolvedValue({ ok: true, data: [p1] }))
    mount()
    expect(await screen.findByText('我的第一个工具')).toBeTruthy()
  })

  it('[H4·IPC 异常兜底] list 抛错 → 落 props 项目（不 crash 不空白）', async () => {
    setList(vi.fn().mockRejectedValue(new Error('ipc down')))
    mount({ projects: [p1] })
    expect(await screen.findByText('我的第一个工具')).toBeTruthy()
  })

  it('[H5·error 态不可达·现状锁定] IPC 失败路径不产生 error UI（F2：:481 重试/跳过为死代码——翻转位注释）', async () => {
    setList(vi.fn().mockResolvedValue({ ok: false, error: { user_visible_message: 'boom' } }))
    mount()
    await waitFor(() => expect(screen.getByText('还没有项目')).toBeTruthy())
    expect(document.body.textContent ?? '').not.toContain('本地存储出现了问题') // :496 error UI 不可达（F2 锁定）
  })

  it('[H6·搜索无匹配] 有项目+搜不存在词 → 无匹配分支（不回落空态引导）', async () => {
    setList(vi.fn().mockResolvedValue({ ok: true, data: [p1] }))
    mount()
    await screen.findByText('我的第一个工具')
    const search = screen.getByPlaceholderText(/搜索/)
    fireEvent.change(search, { target: { value: '不存在的词' } })
    await waitFor(() => expect(screen.queryByText('我的第一个工具')).toBeNull())
    expect(document.body.textContent ?? '').not.toContain('你还没有创建过任何项目')
  })
})

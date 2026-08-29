// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModeSelectionPage } from '../../../renderer/components/ModeSelectionPage'
import { WaitingFeedback } from '../../../renderer/components/WaitingFeedback'
import App from '../../../renderer/components/App'
import { WorkspaceHeader } from '../../../renderer/components/WorkspaceHeader'
import { currentProjectAtom, projectModeAtom, workflowStageAtom } from '../../../renderer/components/atoms'
import type { ElectronAPI, Project } from '../../../shared/types'

describe('Sprint 1 mode and workspace regression', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S1-UI-001] 两道门应展示快消型和长期迭代型入口且不展示技术栈选择', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByRole('group', { name: /快速做一个试试（快速尝鲜）/ })).toBeTruthy()
    expect(screen.getByRole('group', { name: /认真打磨一个产品（精细打磨）/ })).toBeTruthy()
    expect(screen.queryByText(/技术栈/)).toBeNull()
  })

  it('[S1-PROJECT-001] 项目创建失败时不应进入工作区', async () => {
    const onModeSelected = vi.fn()
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: false,
          request_id: 'req-failed',
          error: { code: 'LOCAL_STORE_WRITE_FAILED', message: 'disk failed', retryable: true, user_visible_message: '项目创建失败，请重试。' },
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider><ModeSelectionPage onModeSelected={onModeSelected} /></Provider>)
    fireEvent.click(screen.getByRole('group', { name: /快速做一个试试（快速尝鲜）/ }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('项目创建失败'))
    expect(onModeSelected).not.toHaveBeenCalled()
  })

  it('[S1-PROJECT-002] 项目创建成功后应携带所选模式进入工作区', async () => {
    const onModeSelected = vi.fn()
    const create = vi.fn().mockResolvedValue({ ok: true, request_id: 'req-ok', data: project('quick') })
    window.electronAPI = { project: { create } } as unknown as ElectronAPI

    render(<Provider><ModeSelectionPage onModeSelected={onModeSelected} /></Provider>)
    fireEvent.click(screen.getByRole('group', { name: /快速做一个试试（快速尝鲜）/ }))

    await waitFor(() => expect(onModeSelected).toHaveBeenCalledWith('quick'))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'quick' }))
  })

  it('[S1-UI-002] 等待反馈应在超过 5、10 和 120 秒后切换到对应文案与操作', () => {
    const { rerender } = render(<WaitingFeedback elapsedSeconds={6} actionLabel="生成草图" />)
    expect(screen.getByRole('status').textContent).toContain('生成草图')
    expect(screen.getByRole('status').textContent).not.toMatch(/安全|放心|不会影响/)

    rerender(<WaitingFeedback elapsedSeconds={11} actionLabel="生成草图" />)
    expect(screen.getByRole('status').textContent).toContain('安全环境')

    rerender(
      <WaitingFeedback
        elapsedSeconds={121}
        actionLabel="生成草图"
        onContinueWaiting={vi.fn()}
        onViewPartial={vi.fn()}
      />,
    )
    expect(screen.getByRole('status').textContent).toContain('比预期更长')
    expect(screen.getByRole('button', { name: '继续等待' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '看看已有的' })).toBeTruthy()
  })

  it('[S1-PROJECT-003] 选择模式进入工作区后不应返回两道门且应显示所有项目入口', async () => {
    renderAppWithProject('quick')
    fireEvent.click(screen.getByRole('group', { name: /快速做一个试试（快速尝鲜）/ }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(screen.queryByText('你想做什么样的软件？')).toBeNull()
    expect(screen.getByRole('button', { name: '所有项目' })).toBeTruthy()
  })

  it('[S1-UI-003] 长期迭代型工作区应显示文档入口', async () => {
    renderAppWithProject('longterm')
    fireEvent.click(screen.getByRole('group', { name: /认真打磨一个产品（精细打磨）/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: '文档' })).toBeTruthy())
  })

  it('[S1-STORE-001] 启动时存在活动项目应恢复工作区而不是重新显示两道门', async () => {
    const store = createStore()
    const list = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'req-list',
      data: [project('quick')],
    })
    window.__jotai_store__ = store
    window.electronAPI = { project: { list } } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(screen.queryByText('你想做什么样的软件？')).toBeNull())
    expect(screen.getByText('测试项目')).toBeTruthy()
    expect(list).toHaveBeenCalledOnce()
  })

  it('[S1-PROJECT-005] 已完成的快消型项目应显示升级为长期模式的入口', () => {
    const store = createStore()
    store.set(currentProjectAtom, { ...project('quick'), status: 'completed', current_stage: 'completed' })
    store.set(projectModeAtom, 'quick')
    store.set(workflowStageAtom, 'completed')

    render(<Provider store={store}><WorkspaceHeader /></Provider>)

    expect(screen.getByRole('button', { name: '升级为长期模式' })).toBeTruthy()
  })

  it('[S1-PROJECT-013] 启动恢复进入工作区后仍能通过所有项目导航到历史列表并新建项目', async () => {
    const store = createStore()
    const list = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'req-restore-nav',
      data: [project('quick')],
    })
    window.__jotai_store__ = store
    window.electronAPI = { project: { list } } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)

    // 恢复逻辑：本地存在活动项目 → 直接进入工作区（跳过两道门）
    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(screen.queryByText('你想做什么样的软件？')).toBeNull()

    // 顶栏必须提供「所有项目」入口（sitemap §3：Phase 1 全局元素）→ 当前 FAIL（缺陷②）
    const allProjectsButton = screen.getByRole('button', { name: '所有项目' })
    fireEvent.click(allProjectsButton)

    // 到达历史列表：显示恢复的项目 + 「新建项目」入口
    await waitFor(() => expect(screen.getByRole('button', { name: '新建项目' })).toBeTruthy())
    expect(screen.getByText('测试项目')).toBeTruthy()

    // 新建项目 → 回到两道门选择页
    fireEvent.click(screen.getByRole('button', { name: '新建项目' }))
    await waitFor(() => expect(screen.getByRole('group', { name: /快速做一个试试（快速尝鲜）/ })).toBeTruthy())
  })
})

function renderAppWithProject(mode: Project['mode']): void {
  const store = createStore()
  window.__jotai_store__ = store
  window.electronAPI = {
    project: {
      create: vi.fn().mockResolvedValue({ ok: true, request_id: 'req-app', data: project(mode) }),
    },
  } as unknown as ElectronAPI
  render(<Provider store={store}><App /></Provider>)
}

function project(mode: Project['mode']): Project {
  return {
    project_id: 'project-1',
    workspace_slug: 'default-software-builder',
    name: '测试项目',
    mode,
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: 'C:/temp/project-1',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

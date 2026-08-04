// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../renderer/components/App'
import { ModeSelectionPage } from '../../../renderer/components/ModeSelectionPage'
import { WorkspaceHeader } from '../../../renderer/components/WorkspaceHeader'
import {
  currentProjectAtom,
  projectModeAtom,
  stageIndicatorLabelAtom,
  workflowStageAtom,
} from '../../../renderer/components/atoms'
import type { ElectronAPI, Project } from '../../../shared/types'

describe('Sprint 1 project mode and workspace acceptance', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S1-PROJECT-006] 选择快速尝鲜应创建 quick 项目并进入统一工作区', async () => {
    const store = createStore()
    const create = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'role-c-quick',
      data: project('quick'),
    })
    window.__jotai_store__ = store
    window.electronAPI = { project: { create } } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mode: 'quick' }))
    expect(screen.getByText('快速尝鲜')).toBeTruthy()
    expect(screen.getByText('对话')).toBeTruthy()
    expect(screen.getByText('时间轴')).toBeTruthy()
    expect(screen.getByText('这里将展示你的软件预览')).toBeTruthy()
  })

  it('[S1-PROJECT-007] 选择精细打磨应创建 longterm 项目并显示文档入口', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: true,
          request_id: 'role-c-longterm',
          data: project('longterm'),
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /精细打磨/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: '文档' })).toBeTruthy())
    expect(screen.getByText('精细打磨')).toBeTruthy()
  })

  it('[S1-PROJECT-008] 进入工作区后不得返回两道门且应提供所有项目入口', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: true,
          request_id: 'role-c-locked',
          data: project('quick'),
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    await waitFor(() => expect(screen.getByRole('textbox')).toBeTruthy())
    expect(screen.queryByText('你想做什么样的软件？')).toBeNull()
    expect(screen.queryByRole('button', { name: /返回.*模式|重新选择/ })).toBeNull()
    expect(screen.getByRole('button', { name: '所有项目' })).toBeTruthy()
  })

  it('[S1-PROJECT-010] 长期迭代型工作区不得显示降级为快消型入口', () => {
    const store = createStore()
    store.set(currentProjectAtom, project('longterm'))
    store.set(projectModeAtom, 'longterm')
    store.set(workflowStageAtom, 'clarifying')
    store.set(stageIndicatorLabelAtom, '正在了解你的需求')

    render(<Provider store={store}><WorkspaceHeader /></Provider>)

    expect(screen.queryByRole('button', { name: /降级|快消/ })).toBeNull()
    expect(screen.getByText('精细打磨')).toBeTruthy()
  })

  it('[S1-UI-007] 两道门应使用生活化文案且不要求技术栈配置', () => {
    render(<Provider><ModeSelectionPage onModeSelected={vi.fn()} /></Provider>)

    expect(screen.getByText('快速做一个试试')).toBeTruthy()
    expect(screen.getByText('认真打磨一个产品')).toBeTruthy()
    expect(screen.getByText(/一次性小工具/)).toBeTruthy()
    expect(screen.getByText(/持续改进/)).toBeTruthy()
    expect(screen.queryByText(/React|Vue|数据库|技术栈|API/)).toBeNull()
  })

  it('[S1-UI-008] 项目创建失败时只展示 P0 可读文案且不进入工作区', async () => {
    const onModeSelected = vi.fn()
    window.electronAPI = {
      project: {
        create: vi.fn().mockResolvedValue({
          ok: false,
          request_id: 'role-c-create-error',
          error: {
            code: 'LOCAL_STORE_WRITE_FAILED',
            message: 'Error: ENOSPC at writeJsonFile (C:\\secret\\projects.json)',
            user_visible_message: '本地保存失败，请检查磁盘空间后再试。',
            retryable: true,
          },
        }),
      },
    } as unknown as ElectronAPI

    render(<Provider><ModeSelectionPage onModeSelected={onModeSelected} /></Provider>)
    fireEvent.click(screen.getByRole('button', { name: /快速尝鲜/ }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('本地保存失败，请检查磁盘空间后再试。')
    expect(alert.textContent).not.toMatch(/ENOSPC|writeJsonFile|C:\\/)
    expect(onModeSelected).not.toHaveBeenCalled()
  })
})

function project(mode: Project['mode']): Project {
  return {
    project_id: `role-c-${mode}`,
    workspace_slug: 'default-software-builder',
    name: mode === 'quick' ? '快速验收项目' : '长期验收项目',
    mode,
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: `C:/role-c/${mode}`,
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  }
}

// @vitest-environment jsdom

import React from 'react'
import { createStore, Provider } from 'jotai'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectHistoryPage } from '../../../renderer/components/ProjectHistoryPage'
import type { ElectronAPI, Project } from '../../../shared/types'

describe('Sprint 3 历史项目管理 UI（迁移自 Proma 归档/删除）', () => {
  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    vi.restoreAllMocks()
  })

  it('[S3-PROJECT-012] 活动项目行有归档按钮且点击调用 api.project.archive', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const archive = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'r',
      data: { ...project('active'), status: 'archived' },
    })
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [project('active')] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
    window.electronAPI = { project: { list, archive } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage onResumeProject={vi.fn()} onNewProject={vi.fn()} />
      </Provider>,
    )

    await screen.findByText('测试项目')
    fireEvent.click(screen.getByRole('button', { name: '归档' }))

    await waitFor(() =>
      expect(archive).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'role-c-mgmt' })),
    )
  })

  it('[S3-PROJECT-013] 点击删除弹二次确认，确认后调用 api.project.delete', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const del = vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: { deleted: true } })
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [project('active')] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
    window.electronAPI = { project: { list, delete: del } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage onResumeProject={vi.fn()} onNewProject={vi.fn()} />
      </Provider>,
    )

    await screen.findByText('测试项目')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/无法恢复/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() =>
      expect(del).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'role-c-mgmt' })),
    )
  })

  it('[S3-PROJECT-014] 点击删除后取消不调用 api.project.delete', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const del = vi.fn()
    const list = vi.fn().mockResolvedValue({ ok: true, request_id: 'r', data: [project('active')] })
    window.electronAPI = { project: { list, delete: del } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage onResumeProject={vi.fn()} onNewProject={vi.fn()} />
      </Provider>,
    )

    await screen.findByText('测试项目')
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(del).not.toHaveBeenCalled()
  })

  it('[S3-PROJECT-015] 切换到已归档 Tab 调 api.project.list({scope:"archived"}) 并显示归档项目', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [project('archived')] })
    window.electronAPI = { project: { list } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage onResumeProject={vi.fn()} onNewProject={vi.fn()} />
      </Provider>,
    )

    await screen.findByText('所有项目')
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))

    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'archived' })))
    expect(await screen.findByText('测试项目')).toBeTruthy()
  })

  it('[S3-PROJECT-016] 已归档项目点恢复调用 api.project.unarchive', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const unarchive = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'r',
      data: { ...project('archived'), status: 'active' },
    })
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [project('archived')] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
    window.electronAPI = { project: { list, unarchive } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage onResumeProject={vi.fn()} onNewProject={vi.fn()} />
      </Provider>,
    )

    await screen.findByText('所有项目')
    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    await screen.findByText('测试项目')

    fireEvent.click(screen.getByRole('button', { name: '恢复' }))

    await waitFor(() =>
      expect(unarchive).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'role-c-mgmt' })),
    )
  })

  it('[S3-PROJECT-017] 归档后通过 onProjectsChanged 回传最新活动列表', async () => {
    const store = createStore()
    window.__jotai_store__ = store
    const onProjectsChanged = vi.fn()
    const archive = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'r',
      data: { ...project('active'), status: 'archived' },
    })
    const list = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [project('active')] })
      .mockResolvedValueOnce({ ok: true, request_id: 'r', data: [] })
    window.electronAPI = { project: { list, archive } } as unknown as ElectronAPI

    render(
      <Provider store={store}>
        <ProjectHistoryPage
          onResumeProject={vi.fn()}
          onNewProject={vi.fn()}
          onProjectsChanged={onProjectsChanged}
        />
      </Provider>,
    )

    await screen.findByText('测试项目')
    fireEvent.click(screen.getByRole('button', { name: '归档' }))

    await waitFor(() => expect(onProjectsChanged).toHaveBeenCalled())
    expect(onProjectsChanged).toHaveBeenLastCalledWith([])
  })
})

function project(status: Project['status'] = 'active'): Project {
  return {
    project_id: 'role-c-mgmt',
    workspace_slug: 'default-software-builder',
    name: '测试项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status,
    current_stage: 'clarifying',
    root_path: 'C:/role-c/mgmt',
    created_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
  }
}

// @vitest-environment jsdom

import React from 'react'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createStore, Provider } from 'jotai'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../renderer/components/App'
import { createProject, updateProject, findProject } from '../../../main/project/project-service'
import { IPC_CHANNELS, type ApiResult, type ElectronAPI, type Project } from '../../../shared/types'
import { createIpcHarness } from '../support/ipc-harness'
import { useTemporaryPromaHome, type TemporaryPromaHome } from '../support/test-environment'

describe('Sprint 1 project persistence and upgrade acceptance', () => {
  let environment: TemporaryPromaHome | undefined

  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  afterEach(() => {
    cleanup()
    delete window.electronAPI
    delete window.__jotai_store__
    environment?.cleanup()
    environment = undefined
    vi.restoreAllMocks()
  })

  it('[S1-STORE-002] 启动时存在活动项目应恢复项目与会话而不是显示两道门', async () => {
    const store = createStore()
    const restored = project()
    const list = vi.fn().mockResolvedValue({
      ok: true,
      request_id: 'role-c-restore',
      data: [restored],
    })
    window.__jotai_store__ = store
    window.electronAPI = { project: { list } } as unknown as ElectronAPI

    render(<Provider store={store}><App /></Provider>)

    await waitFor(() => expect(list).toHaveBeenCalledOnce())
    expect(screen.queryByText('你想做什么样的软件？')).toBeNull()
    expect(screen.getByText(restored.name)).toBeTruthy()
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it.each(['legacy', 'lean'])('[S1-PROJECT-009] %s 快消项目升级前先创建快照，新链保留交付状态', async workflow => {
    environment = useTemporaryPromaHome('bloma-role-c-upgrade-')
    const harness = createIpcHarness()
    const created = (workflow === 'legacy' ? { ok: true, request_id: 'legacy-create', data: createProject({ request_id: 'legacy-create', mode: 'quick' }) } : await harness.invoke(IPC_CHANNELS.PROJECT_CREATE, {
      request_id: 'role-c-create-before-upgrade',
      mode: 'quick',
    })) as ApiResult<Project>
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error.message)
    updateProject(created.data.project_id, { status: 'completed', current_stage: 'completed' })

    const upgraded = await harness.invoke(IPC_CHANNELS.PROJECT_UPGRADE, {
      request_id: 'role-c-upgrade',
      project_id: created.data.project_id,
      session_id: 'role-c-upgrade-session',
    }) as ApiResult<Project>

    if(workflow==='legacy'){
      expect(upgraded.ok).toBe(false)
      expect(findProject(created.data.project_id)).toMatchObject({mode:'quick',current_stage:'completed'})
      return
    }
    expect(upgraded.ok).toBe(true)
    if (!upgraded.ok) throw new Error(upgraded.error.message)
    const snapshotDir = join(
      environment.home,
      'agent-workspaces',
      created.data.workspace_slug,
      'snapshots',
      created.data.project_id,
    )
    const snapshots = readdirSync(snapshotDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(snapshotDir, name), 'utf8')) as { kind?: string })

    expect(snapshots.some((snapshot) => snapshot.kind === 'upgrade')).toBe(true)
    expect(upgraded.data.mode).toBe('longterm')
    // M-16：升级是瞬时切换，直接落在合法停留态 ready（不再置无出口的 upgrading）
    expect(upgraded.data.current_stage).toBe(workflow === 'legacy' ? 'ready' : 'completed')
  })
})

function project(): Project {
  return {
    project_id: 'role-c-restored-project',
    workspace_slug: 'default-software-builder',
    name: '已恢复项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: 'C:/role-c/restored',
    created_at: '2026-07-25T00:00:00.000Z',
    updated_at: '2026-07-25T00:00:00.000Z',
  }
}

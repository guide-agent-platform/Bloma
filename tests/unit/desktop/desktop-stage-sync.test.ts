// @vitest-environment jsdom
/**
 * 审计 A-01/A-04 修复回归（2026-10-04）：桌面线 stage_changed 事件的权威回填链。
 *
 * 背景：DesktopStageBar/DesktopArtifactStrip/DeliveryPanel 的门控与 canUpgrade/
 * MvpStatusBanner 都读 currentProjectAtom；该 atom 原运行期刷新点（mvp_ready →
 * project.list 回填）已随 web 线退役死亡——不回填则桌面阶段推进在会话内零呈现。
 *
 * 锁定：
 * - desktop 阶段事件（desktop-arch/delivered）→ desktopPhaseAtom 即时 + project.list
 *   回填 currentProjectAtom（desktop_phase/status/current_stage/template_type）；
 * - delivered（current_stage=completed）→ workflowStageAtom 同步为 completed（与 App
 *   恢复口径一致），快照列表重拉；
 * - 回包时已切换项目 → 不覆盖（防串台）；
 * - web 阶段事件不触发回填（原分流行为不变）。
 */
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'jotai'
import {
  currentProjectAtom,
  desktopPhaseAtom,
  setupGlobalAgentListeners,
  snapshotsListAtom,
  workflowStageAtom,
} from '../../../renderer/agent-atoms'
import type { AgentEvent, ElectronAPI, Project, Snapshot } from '../../../shared/types'

afterEach(() => {
  cleanup()
  delete window.electronAPI
  delete window.__jotai_store__
  vi.restoreAllMocks()
})

let eventSequence = 0
function event(projectId: string, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  eventSequence += 1
  return {
    event_id: `evt-${eventSequence}`,
    session_id: 'session-sync',
    project_id: projectId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

function baseProject(overrides: Partial<Project>): Project {
  return {
    project_id: 'p-sync',
    workspace_slug: 'default',
    name: '同步测试项目',
    mode: 'quick',
    template_type: 'desktop_tool',
    status: 'active',
    current_stage: 'clarifying',
    root_path: 'X:/storage/projects/p-sync',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Project
}

function setup(listResult: Project[]): { store: ReturnType<typeof createStore>; push: (event: AgentEvent) => void; listMock: ReturnType<typeof vi.fn>; snapshotsMock: ReturnType<typeof vi.fn>; cleanup: () => void } {
  const store = createStore()
  let listener: ((event: AgentEvent) => void) | undefined
  const listMock = vi.fn(async () => ({ ok: true, request_id: 'r', data: listResult }))
  const snapshotsMock = vi.fn(async () => ({
    ok: true,
    request_id: 'r',
    data: { snapshots: [{ snapshot_id: 'snap-1' } as Snapshot] },
  }))
  window.__jotai_store__ = store
  window.electronAPI = {
    agent: {
      onStreamEvent(next: (event: AgentEvent) => void) {
        listener = next
        return () => undefined
      },
    },
    project: { list: listMock },
    snapshots: { list: snapshotsMock },
  } as unknown as ElectronAPI
  const cleanupFn = setupGlobalAgentListeners()
  return { store, push: (e: AgentEvent) => listener?.(e), listMock, snapshotsMock, cleanup: cleanupFn }
}

describe('桌面 stage_changed 权威回填（A-01/A-04）', () => {
  it('desktop-arch 事件 → desktopPhaseAtom 即时 + currentProjectAtom 回填（desktop_phase 出现，阶段条门控解锁）', async () => {
    const { store, push, listMock, cleanup } = setup([baseProject({ desktop_phase: 'desktop-arch' })])
    store.set(currentProjectAtom, baseProject({})) // 会话中的陈旧快照：desktop_phase 未设
    push(event('p-sync', 'stage_changed', { stage: 'desktop-arch' }))
    expect(store.get(desktopPhaseAtom)).toBe('desktop-arch') // 同步即时
    await vi.waitFor(() => expect(listMock).toHaveBeenCalled())
    await vi.waitFor(() => expect(store.get(currentProjectAtom)?.desktop_phase).toBe('desktop-arch'))
    // current_stage 仍是 clarifying（PRD 前）→ workflowStageAtom 不被误改
    expect(store.get(workflowStageAtom)).toBe('clarifying')
    cleanup()
  })

  it('delivered 事件（current_stage=completed）→ workflowStageAtom 同步 completed（交付横幅/导出入口解锁）+ 快照重拉', async () => {
    const { store, push, snapshotsMock, cleanup } = setup([baseProject({ desktop_phase: 'delivered', status: 'completed', current_stage: 'completed' })])
    store.set(currentProjectAtom, baseProject({}))
    store.set(workflowStageAtom, 'clarifying')
    push(event('p-sync', 'stage_changed', { stage: 'delivered' }))
    await vi.waitFor(() => expect(store.get(workflowStageAtom)).toBe('completed'))
    expect(store.get(currentProjectAtom)?.status).toBe('completed')
    await vi.waitFor(() => expect(snapshotsMock).toHaveBeenCalled())
    expect(store.get(snapshotsListAtom).length).toBe(1)
    cleanup()
  })

  it('事件属于后台项目（当前项目已切换）→ 整体拦截：desktopPhaseAtom 不写入、不回填（防串台）', async () => {
    const other = baseProject({ project_id: 'p-other' })
    const { store, push, listMock, cleanup } = setup([baseProject({ desktop_phase: 'desktop-arch' })])
    store.set(currentProjectAtom, other)
    push(event('p-sync', 'stage_changed', { stage: 'desktop-arch' }))
    // 项目隔离（既有行为）：后台项目的事件连事件相位也不写，回填更不发生
    expect(store.get(desktopPhaseAtom)).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listMock).not.toHaveBeenCalled()
    expect(store.get(currentProjectAtom)?.project_id).toBe('p-other')
    cleanup()
  })

  it('web 阶段事件 → 不触发 project.list 回填（原分流行为不变）', async () => {
    const { store, push, listMock, cleanup } = setup([baseProject({})])
    store.set(currentProjectAtom, baseProject({}))
    push(event('p-sync', 'stage_changed', { stage: 'blocked_for_user_decision' }))
    expect(store.get(workflowStageAtom)).toBe('blocked_for_user_decision')
    // 留一个微任务窗口，回填不应发生
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listMock).not.toHaveBeenCalled()
    cleanup()
  })
})

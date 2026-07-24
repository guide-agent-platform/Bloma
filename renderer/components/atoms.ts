/**
 * Sprint 1 Atoms — 本地 Jotai 状态
 *
 * 对齐 BlomaB/renderer/agent-atoms.ts (Sprint 0 产物，324行)。
 * Sprint 1 组件通过此文件消费状态。
 *
 * 集成到 Bloma 项目时，将此文件的 import 替换为指向
 * BlomaB/renderer/agent-atoms.ts 即可。
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'

// =========================================================================
// 类型（对齐 shared/types.ts BlomaB版）
// =========================================================================

export type ProjectMode = 'quick' | 'longterm'

export type WorkflowStage =
  | 'choosing_mode'
  | 'clarifying'
  | 'generating_sketch'
  | 'sketch_ready'
  | 'generating_mvp'
  | 'testing'
  | 'judge_review'
  | 'repairing'
  | 'ready'
  | 'iterating'
  | 'completed'
  | 'upgrading'
  | 'blocked_for_user_decision'

export interface AgentSessionMeta {
  session_id: string
  project_id: string
  title: string
  created_at: string
}

export interface AgentEvent {
  event_id: string
  session_id: string
  project_id?: string
  type: string
  payload: Record<string, unknown>
  created_at: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: Array<{ type: string; text?: string }>
  timestamp: number
}

export interface PermissionRequest {
  id: string
  session_id: string
  project_id?: string
  tool_name: string
  tool_input: Record<string, unknown>
  danger_level: 'safe' | 'warning' | 'dangerous'
  user_visible_summary: string
  created_at: string
}

export interface Project {
  project_id: string
  workspace_slug: string
  name: string
  mode: ProjectMode
  template_type: string
  status: 'active' | 'completed' | 'abandoned' | 'archived'
  current_stage: WorkflowStage
  root_path: string
  current_snapshot_id?: string
  created_at: string
  updated_at: string
}

export interface Snapshot {
  snapshot_id: string
  project_id: string
  kind: string
  name: string
  summary: string
  screenshot_path?: string
  files_archive_path: string
  health_status: 'healthy' | 'unhealthy'
  parent_snapshot_id?: string
  created_at: string
}

export interface ElectronAPI {
  agent: {
    sendMessage(input: unknown): Promise<unknown>
    cancel(input: unknown): Promise<unknown>
    onStreamEvent(listener: (event: AgentEvent) => void): () => void
  }
  permissions: {
    respond(input: unknown): Promise<unknown>
  }
  project: {
    create(input: unknown): Promise<{ ok: boolean; data?: Project; error?: unknown }>
    confirmSketch(input: unknown): Promise<unknown>
    submitCorrection(input: unknown): Promise<unknown>
    upgrade(input: unknown): Promise<unknown>
  }
  sandbox: {
    run(input: unknown): Promise<unknown>
    stop(input: unknown): Promise<unknown>
  }
  snapshots: {
    create(input: unknown): Promise<unknown>
    rollback(input: unknown): Promise<unknown>
  }
  documents: {
    sync(input: unknown): Promise<unknown>
  }
  analytics: {
    track(input: unknown): Promise<unknown>
  }
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

// =========================================================================
// Agent 会话
// =========================================================================

export const agentSessionsAtom = atom<AgentSessionMeta[]>([])
export const activeAgentSessionIdAtom = atom<string | null>(null)

// =========================================================================
// 流式状态（atomFamily 按 sessionId 隔离）
// =========================================================================

export interface AgentStreamState {
  running: boolean
  events: AgentEvent[]
  content: string
  last_error?: string
}

export const agentStreamStateFamily = atomFamily((_sessionId: string) =>
  atom<AgentStreamState>({ running: false, events: [], content: '' }),
)

// =========================================================================
// 消息列表
// =========================================================================

export const agentMessagesFamily = atomFamily((_sessionId: string) =>
  atom<AgentMessage[]>([]),
)

// =========================================================================
// 权限请求队列
// =========================================================================

export const pendingPermissionRequestsAtom = atom<Map<string, PermissionRequest[]>>(new Map())

export const currentSessionPermissionCountAtom = atom((get) => {
  const activeId = get(activeAgentSessionIdAtom)
  if (!activeId) return 0
  return get(pendingPermissionRequestsAtom).get(activeId)?.length ?? 0
})

// =========================================================================
// 项目状态
// =========================================================================

export const currentProjectAtom = atom<Project | null>(null)
export const projectModeAtom = atom<ProjectMode | null>(null)
export const workflowStageAtom = atom<WorkflowStage>('choosing_mode')
export const modeSelectedAtom = atom<boolean>(false)

// =========================================================================
// UI 状态
// =========================================================================

export const timelineExpandedAtom = atom<boolean>(false)
export const documentPanelExpandedAtom = atom<boolean>(false)
export const selectedSnapshotAtom = atom<Snapshot | null>(null)
export const networkOnlineAtom = atom<boolean>(typeof navigator !== 'undefined' ? navigator.onLine : true)
export const stageIndicatorLabelAtom = atom<string>('选择模式')
export const globalUserErrorAtom = atom<string | null>(null)
export const upgradeConfirmVisibleAtom = atom<boolean>(false)

// =========================================================================
// 点选纠错
// =========================================================================

export const correctionModalVisibleAtom = atom<boolean>(false)
export const correctionUserNoteAtom = atom<string>('')

export interface CorrectionContext {
  elementSelector?: string
  textContent?: string
  boundingRect: { x: number; y: number; width: number; height: number }
  screenshotRegionPath?: string
  fallbackMode: boolean
}

export const correctionContextAtom = atom<CorrectionContext | null>(null)

// =========================================================================
// 快照列表
// =========================================================================

export const snapshotsListAtom = atom<Snapshot[]>([])

// =========================================================================
// 派生 atoms
// =========================================================================

export const isQuickModeAtom = atom((get) => get(projectModeAtom) === 'quick')
export const isLongtermModeAtom = atom((get) => get(projectModeAtom) === 'longterm')

export const documentPanelVisibleAtom = atom(
  (get) => get(isLongtermModeAtom) && get(currentProjectAtom) !== null,
)

export const hasActiveStreamAtom = atom((get) => {
  const sessionId = get(activeAgentSessionIdAtom)
  if (!sessionId) return false
  return get(agentStreamStateFamily(sessionId)).running
})

export const canUpgradeAtom = atom((get) => {
  const project = get(currentProjectAtom)
  return project?.mode === 'quick' && project?.status === 'completed'
})

// =========================================================================
// P0 用户可见文案：13 阶段 → 中文
// =========================================================================

export const STAGE_LABEL_MAP: Record<WorkflowStage, string> = {
  choosing_mode: '选择模式',
  clarifying: '正在了解你的需求',
  generating_sketch: '正在生成预览草图',
  sketch_ready: '草图已就绪，看看方向对吗？',
  generating_mvp: '正在生成完整版本',
  testing: '正在自动测试',
  judge_review: '正在做质量检查',
  repairing: '正在自动修复问题',
  ready: '已完成，可以继续调整',
  iterating: '正在迭代修改',
  completed: '项目已完成',
  upgrading: '正在升级为长期迭代模式',
  blocked_for_user_decision: '需要你来决定',
}

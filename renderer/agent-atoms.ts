/**
 * Agent Atoms — Jotai 状态管理
 *
 * 管理 Agent 会话 + 平台项目 + UI 交互的完整状态。
 * 这是 IPC 四层架构的 Layer 4。
 *
 * === 关键设计 ===
 *
 * 1. atomFamily 按 sessionId 隔离
 *    每个 Agent 会话有独立的 streamState atom。
 *    会话 A 的流式输出不会覆盖会话 B 的状态。
 *
 * 2. setupGlobalAgentListeners() 在 main.tsx 中调用一次，永不卸载
 *    使用 window.__jotai_store__ 直接操作 atoms，
 *    不依赖 React 组件生命周期。
 *
 * 3. 权限请求按 sessionId 入队
 *    支持多个 Agent 会话并行运行时各自的权限请求互不干扰。
 *
 * === 对齐说明 ===
 *
 * 核心结构对齐 A 的 Bloma project (E:\Psr\develop\sprint0\Bloma\renderer\agent-atoms.ts)
 * 新增平台扩展区（项目状态、UI 状态、点选纠错等）以满足 Sprint 1-3 需求。
 */

import { atom, type WritableAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  ElectronAPI,
  PermissionRequest,
  Project,
  ProjectMode,
  Snapshot,
  WorkflowStage,
} from '../shared/types'

// =========================================================================
// 0. 全局类型声明
// =========================================================================

declare global {
  interface Window {
    electronAPI?: ElectronAPI
    __jotai_store__?: {
      set: <Value, Args extends unknown[], Result>(
        atom: WritableAtom<Value, Args, Result>,
        ...args: Args
      ) => Result
    }
  }
}

// =========================================================================
// 1. Agent 会话（对齐 A）
// =========================================================================

export const agentSessionsAtom = atom<AgentSessionMeta[]>([])

export const activeAgentSessionIdAtom = atom<string | null>(null)

// =========================================================================
// 2. 流式状态（atomFamily 按 sessionId 隔离）— 对齐 A
// =========================================================================

export interface AgentStreamState {
  running: boolean
  /** 完整事件历史 */
  events: AgentEvent[]
  /** 累积文本 */
  content: string
  /** 最近错误 */
  last_error?: string
}

export const agentStreamStateFamily = atomFamily((sessionId: string) =>
  atom<AgentStreamState>({
    running: false,
    events: [],
    content: '',
  }),
)

// =========================================================================
// 3. 消息列表（atomFamily）— 对齐 A
// =========================================================================

export const agentMessagesFamily = atomFamily((_sessionId: string) =>
  atom<AgentMessage[]>([]),
)

// =========================================================================
// 4. 权限请求队列（对齐 A）
// =========================================================================

export const pendingPermissionRequestsAtom = atom<Map<string, PermissionRequest[]>>(new Map())

export const currentSessionPermissionCountAtom = atom((get) => {
  const activeId = get(activeAgentSessionIdAtom)
  if (!activeId) return 0
  return get(pendingPermissionRequestsAtom).get(activeId)?.length ?? 0
})

// =========================================================================
// 5. setupGlobalAgentListeners（对齐 A：纯函数，非 React 组件）
// =========================================================================

/**
 * 在 main.tsx 中调用一次，永不卸载。
 * 使用 window.__jotai_store__ 直接操作 atoms，
 * 不依赖 React 组件生命周期。
 *
 * 用法：
 * ```ts
 * // main.tsx
 * import { Provider, createStore } from 'jotai'
 * import { setupGlobalAgentListeners } from './renderer/agent-atoms'
 *
 * const store = createStore()
 * window.__jotai_store__ = store
 * setupGlobalAgentListeners()
 * ```
 *
 * @returns cleanup 函数（仅在应用退出时调用）
 */
export function setupGlobalAgentListeners(): () => void {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api || !store) return () => undefined

  return api.onStreamEvent((event) => {
    const streamAtom = agentStreamStateFamily(event.session_id)
    store.set(streamAtom, (previous: AgentStreamState) => {
      // 权限请求：从 payload 提取并写入队列
      const permissionRequest =
        event.type === 'permission_requested'
          ? (event.payload.request as PermissionRequest | undefined)
          : undefined

      if (permissionRequest) {
        store.set(pendingPermissionRequestsAtom, (current) => {
          const next = new Map(current)
          const existing = next.get(permissionRequest.session_id) ?? []
          next.set(permissionRequest.session_id, [...existing, permissionRequest])
          return next
        })
      }

      // 阶段变更：同步全局工作流阶段
      if (event.type === 'stage_changed' && event.payload.stage) {
        store.set(workflowStageAtom, event.payload.stage as WorkflowStage)
        store.set(stageIndicatorLabelAtom, STAGE_LABEL_MAP[event.payload.stage as WorkflowStage] ?? '处理中')
      }

      const text = typeof event.payload.text === 'string' ? event.payload.text : ''

      return {
        running: event.type !== 'completed' && event.type !== 'error',
        events: [...previous.events, event],
        content: previous.content + text,
        last_error:
          event.type === 'error'
            ? String(event.payload.code ?? 'AGENT_SDK_ERROR')
            : previous.last_error,
      }
    })
  })
}

// =========================================================================
// 6. 平台扩展 — 项目状态
// =========================================================================

/** 当前项目 */
export const currentProjectAtom = atom<Project | null>(null)

/** 项目模式（独立于 project，用于模式选择阶段） */
export const projectModeAtom = atom<ProjectMode | null>(null)

/** 工作流当前阶段 */
export const workflowStageAtom = atom<WorkflowStage>('choosing_mode')

/** 模式选择是否已完成 */
export const modeSelectedAtom = atom<boolean>(false)

// =========================================================================
// 7. 平台扩展 — UI 状态
// =========================================================================

/** 时间轴面板是否展开 */
export const timelineExpandedAtom = atom<boolean>(false)

/** 文档面板是否展开（仅长期迭代型可见） */
export const documentPanelExpandedAtom = atom<boolean>(false)

/** 当前选中的快照 */
export const selectedSnapshotAtom = atom<Snapshot | null>(null)

/** 网络在线状态 */
export const networkOnlineAtom = atom<boolean>(navigator.onLine)

/** 阶段指示器文案（P0 用户可见） */
export const stageIndicatorLabelAtom = atom<string>('选择模式')

/** 全局用户可见错误 */
export const globalUserErrorAtom = atom<string | null>(null)

/** 升级确认弹窗可见性 */
export const upgradeConfirmVisibleAtom = atom<boolean>(false)

// =========================================================================
// 8. 平台扩展 — 点选纠错
// =========================================================================

/** 纠错弹窗是否可见 */
export const correctionModalVisibleAtom = atom<boolean>(false)

/** 纠错弹窗中的用户输入 */
export const correctionUserNoteAtom = atom<string>('')

/** 当前被点击元素的上下文 */
export const correctionContextAtom = atom<{
  elementSelector?: string
  textContent?: string
  boundingRect: { x: number; y: number; width: number; height: number }
  screenshotRegionPath?: string
  fallbackMode: boolean
} | null>(null)

// =========================================================================
// 9. 平台扩展 — 快照列表
// =========================================================================

export const snapshotsListAtom = atom<Snapshot[]>([])

// =========================================================================
// 10. 派生 atoms
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
// 11. Action helpers
// =========================================================================

/** 将消息添加到指定会话 */
export function appendMessageToSession(
  sessionId: string,
  message: AgentMessage,
): void {
  const store = window.__jotai_store__
  if (!store) return
  const messagesAtom = agentMessagesFamily(sessionId)
  store.set(messagesAtom, (prev) => [...prev, message])
}

/** 清除指定权限请求 */
export function clearPermissionRequest(sessionId: string, permissionId: string): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(pendingPermissionRequestsAtom, (prev) => {
    const next = new Map(prev)
    const existing = next.get(sessionId) ?? []
    next.set(
      sessionId,
      existing.filter((r) => r.id !== permissionId),
    )
    return next
  })
}

/** 重置项目状态 */
export function resetProjectState(): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(currentProjectAtom, null)
  store.set(projectModeAtom, null)
  store.set(workflowStageAtom, 'choosing_mode')
  store.set(modeSelectedAtom, false)
  store.set(timelineExpandedAtom, false)
  store.set(documentPanelExpandedAtom, false)
  store.set(snapshotsListAtom, [])
  store.set(selectedSnapshotAtom, null)
  store.set(stageIndicatorLabelAtom, '选择模式')
}

// =========================================================================
// 12. 阶段指示器文案（P0 用户可见中文）
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

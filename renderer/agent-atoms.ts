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

import { atom, type Atom, type WritableAtom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  AgentSessionRecord,
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
      get: <Value>(atom: Atom<Value>) => Value
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

/**
 * 决策卡片消费标记（per session）——修复「选了选项卡片还赖着不走」。
 *
 * 卡片是否显示由 `useUserDecisionCards` 从 events 反推（扫到 user_decision_required
 * 就显示，扫到 sketch_ready 才隐藏）。但草图走 LLM 后，从「用户点选」到「sketch_ready
 * 事件到达」有数秒到数十秒空窗，events 里最新仍是旧的 user_decision_required，卡片不消失，
 * 用户误以为没生效、再点一次就撞 AGENT_SESSION_BUSY。这个标记让点选动作立即消费卡片，
 * 不依赖后端事件时序；新一轮 user_decision_required 到达时重置，让新问题能重新弹出。
 */
export const decisionConsumedFamily = atomFamily((_sessionId: string) => atom(false))

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
    // 会话追踪：新出现的 session_id 追加到 agentSessionsAtom（已有索引的会话保持不变）
    store.set(agentSessionsAtom, (previous) => {
      if (previous.some((item) => item.session_id === event.session_id)) return previous
      return [
        ...previous,
        {
          session_id: event.session_id,
          project_id: event.project_id ?? '',
          title: '当前对话',
          created_at: event.created_at,
        },
      ]
    })

    // 预览地址：sketch_ready / mvp_ready 带回沙箱 preview_url，供预览区渲染真实产物
    if (event.type === 'sketch_ready' || event.type === 'mvp_ready') {
      const url = typeof event.payload.preview_url === 'string' ? event.payload.preview_url : null
      if (url) store.set(previewUrlAtom, url)
      const snapshotId = typeof event.payload.snapshot_id === 'string' ? event.payload.snapshot_id : null
      if (snapshotId) store.set(currentSnapshotIdAtom, snapshotId)
      // 时间轴数据源：后端每次落新快照即重新拉取快照列表，避免胶片条永远空
      if (event.project_id) void loadSnapshots(event.project_id)
    }

    // 终态事件：将本次运行累积的流式回复沉淀为一条助手消息，
    // 修复「completed 后 running=false，流式文本消失且从未进消息列表」。
    // 读取尚未被重置的 content（同步），随后 reducer 再清空。
    if (event.type === 'completed' || event.type === 'error') {
      const terminalStreamAtom = agentStreamStateFamily(event.session_id)
      const accumulated = store.get(terminalStreamAtom)?.content ?? ''
      if (accumulated.trim()) {
        store.set(agentMessagesFamily(event.session_id), (previous) => [
          ...previous,
          {
            role: 'assistant',
            content: [{ type: 'text', text: accumulated }],
            timestamp: Date.now(),
          },
        ])
      }
    }

    // 新一轮决策需求到达 → 重置消费标记，让新卡片能重新弹出
    if (event.type === 'user_decision_required') {
      store.set(decisionConsumedFamily(event.session_id), false)
    }

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
      const isTerminal = event.type === 'completed' || event.type === 'error'

      return {
        running: !isTerminal,
        events: [...previous.events, event],
        content: isTerminal ? '' : previous.content + text,
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

/** 最近一次 sketch_ready / mvp_ready 事件带回的沙箱预览地址；null = 尚无真实预览 */
export const previewUrlAtom = atom<string | null>(null)

/** 最近一次 sketch_ready / mvp_ready 事件带回的快照 id；null = 尚无快照（供「确认草图」回传） */
export const currentSnapshotIdAtom = atom<string | null>(null)

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

/** 标记当前会话的决策卡片已被消费（用户已点选），立即隐藏卡片。 */
export function markDecisionConsumed(sessionId: string): void {
  const store = window.__jotai_store__
  if (!store) return
  store.set(decisionConsumedFamily(sessionId), true)
}

/** 将后端会话索引记录映射为 renderer 侧会话元数据 */
function toSessionMeta(record: AgentSessionRecord): AgentSessionMeta {
  return {
    session_id: record.session_id,
    project_id: record.project_id,
    title: record.summary || record.session_id,
    created_at: record.created_at,
  }
}

/**
 * 拉取会话索引并灌入 agentSessionsAtom（回访恢复时调用）。
 * 无 electronAPI/agent.listSessions 环境时静默跳过（兼容测试环境）。
 */
export async function loadAgentSessions(projectId?: string): Promise<void> {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api?.listSessions || !store) return
  const result = await api.listSessions({
    request_id: crypto.randomUUID(),
    project_id: projectId,
  })
  if (!result.ok) return
  store.set(agentSessionsAtom, result.data.sessions.map(toSessionMeta))
}

/**
 * 从磁盘加载历史消息并灌入对应会话的 agentMessagesFamily（回访恢复时调用）。
 * 无 electronAPI/agent.loadMessages 环境时静默跳过（兼容测试环境）。
 */
export async function loadSessionHistory(sessionId: string): Promise<void> {
  const api = window.electronAPI?.agent
  const store = window.__jotai_store__
  if (!api?.loadMessages || !store) return
  const result = await api.loadMessages({
    request_id: crypto.randomUUID(),
    session_id: sessionId,
    limit: 200,
  })
  if (!result.ok) return
  store.set(agentMessagesFamily(sessionId), result.data.messages)
}

/**
 * 从磁盘加载项目快照列表并灌入 snapshotsListAtom（时间轴胶片条的数据源）。
 * 无 electronAPI/snapshots.list 环境时静默跳过（兼容测试环境）。
 */
export async function loadSnapshots(projectId: string): Promise<void> {
  const api = window.electronAPI?.snapshots
  const store = window.__jotai_store__
  if (!api?.list || !store) return
  const result = await api.list({
    request_id: crypto.randomUUID(),
    project_id: projectId,
  })
  if (!result.ok) return
  store.set(snapshotsListAtom, result.data.snapshots)
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
  clarifying: '等待你确认几个问题',
  generating_sketch: '正在生成草图',
  sketch_ready: '草图已生成',
  generating_mvp: '正在生成完整功能',
  testing: '正在检查能不能正常使用',
  judge_review: '正在确认功能是否到位',
  repairing: '正在尝试修复',
  ready: '可以试用了',
  iterating: '正在继续调整',
  completed: '已完成',
  upgrading: '正在升级为长期维护模式',
  blocked_for_user_decision: '需要你来决定',
}

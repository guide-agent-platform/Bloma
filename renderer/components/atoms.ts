<<<<<<< HEAD
/**
 * Sprint 1 Components Atoms — B 角色本地状态
 *
 * 集成到 Bloma 项目：
 * - 类型从 ../../shared/types 导入，不再重复定义
 * - 共享 atom 从 ../agent-atoms 导入
 * - 仅保留 B 特有类型和 atom
 */

import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  PermissionRequest,
=======
export * from '../agent-atoms'
export type {
  AgentEvent,
  AgentMessage,
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
  Project,
  ProjectMode,
  Snapshot,
  WorkflowStage,
} from '../../shared/types'
<<<<<<< HEAD

// 重新导出以便组件统一从 ./atoms 导入
export type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  PermissionRequest,
  Project,
  ProjectMode,
  Snapshot,
  WorkflowStage,
}

export type { ElectronAPI } from '../../shared/types'

// =========================================================================
// B 特有类型
// =========================================================================

export interface AgentStreamState {
  running: boolean
  events: AgentEvent[]
  content: string
  last_error?: string
}

export interface CorrectionPayload {
  position: { x: number; y: number }
  userNote: string
  fallbackMode: boolean
}

export interface CardOption {
  id: string
  label: string
  description?: string
}

// =========================================================================
// 共享 atom（从 agent-atoms.ts 重新导出）
// =========================================================================

export {
  agentSessionsAtom,
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
  agentMessagesFamily,
  pendingPermissionRequestsAtom,
  currentSessionPermissionCountAtom,
  currentProjectAtom,
  projectModeAtom,
  workflowStageAtom,
  modeSelectedAtom,
  timelineExpandedAtom,
  documentPanelExpandedAtom,
  selectedSnapshotAtom,
  networkOnlineAtom,
  stageIndicatorLabelAtom,
  globalUserErrorAtom,
  upgradeConfirmVisibleAtom,
  correctionModalVisibleAtom,
  correctionUserNoteAtom,
  correctionContextAtom,
  snapshotsListAtom,
  isQuickModeAtom,
  isLongtermModeAtom,
  documentPanelVisibleAtom,
  hasActiveStreamAtom,
  canUpgradeAtom,
  STAGE_LABEL_MAP,
  appendMessageToSession,
  clearPermissionRequest,
  resetProjectState,
} from '../agent-atoms'

// =========================================================================
// B 特有 atom
// =========================================================================

/** 工作区等待状态（本地 UI 状态，无需跨组件持久化） */
export const workspaceWaitingAtom = atom<boolean>(false)
export const workspaceWaitStartAtom = atom<number | undefined>(undefined)
=======
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84

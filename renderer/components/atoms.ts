/**
 * Sprint 1 Components Atoms — B 角色本地状态
 *
 * 类型从 ../../shared/types 导入，共享 atom 从 ../agent-atoms 导入，仅保留 B 特有类型和 atom。
 */

import { atom } from 'jotai'
import type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  PermissionRequest,
  Project,
  ProjectMode,
  Snapshot,
  SnapshotDocumentEntry,
  WorkflowStage,
} from '../../shared/types'

export type {
  AgentEvent,
  AgentMessage,
  AgentSessionMeta,
  PermissionRequest,
  Project,
  ProjectMode,
  Snapshot,
  SnapshotDocumentEntry,
  WorkflowStage,
}
export type { ElectronAPI } from '../../shared/types'

export interface AgentStreamState { running: boolean; events: AgentEvent[]; content: string; last_error?: string }
export interface CorrectionPayload { position: { x: number; y: number }; userNote: string; fallbackMode: boolean }
export interface CardOption { id: string; label: string; description?: string }

export type { DelegationView, DelegationViewStatus } from '../agent-atoms'

export {
  agentSessionsAtom, activeAgentSessionIdAtom, agentStreamStateFamily, agentMessagesFamily,
  pendingPermissionRequestsAtom, currentSessionPermissionCountAtom,
  currentProjectAtom, projectModeAtom, workflowStageAtom, modeSelectedAtom,
  timelineExpandedAtom, documentPanelExpandedAtom, collaborationPanelExpandedAtom, selectedSnapshotAtom,
  networkOnlineAtom, stageIndicatorLabelAtom, globalUserErrorAtom, upgradeConfirmVisibleAtom,
  correctionModalVisibleAtom, correctionUserNoteAtom, correctionContextAtom,
  snapshotsListAtom, isQuickModeAtom, isLongtermModeAtom, documentPanelVisibleAtom,
  hasActiveStreamAtom, canUpgradeAtom, previewUrlsAtom, currentSnapshotIdAtom, STAGE_LABEL_MAP,
  delegationsFamily, emptyDelegationsFallback,
  appendMessageToSession, markDecisionConsumed, clearPermissionRequest, resetProjectState,
  loadAgentSessions, loadSessionHistory, loadSnapshots,
} from '../agent-atoms'

export const workspaceWaitingAtom = atom<boolean>(false)
export const workspaceWaitStartAtom = atom<number | undefined>(undefined)

/**
 * 提示词族：prompt list/read/save/reset（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dialog } from 'electron'
import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentConfirmRequirementsInput,
  AgentForkSessionInput,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AgentSteerQueryInput,
  AgentSteerResolveInput,
  AnalyticsTrackInput,
  CategoryRoutingUpdateEnvelope,
  CategoryRoutingRoleUpdateEnvelope,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ChannelTestDirectEnvelope,
  ChannelUpdateEnvelope,
  FetchModelsEnvelope,
  DocumentListInput,
  DocumentReadInput,
  DocumentSyncInput,
  PermissionResponseInput,
  PastedImageSaveInput,
  PermissionSetModeInput,
  ProjectFileReadInput,
  PromptReadInput,
  PromptResetInput,
  PromptSaveInput,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectUpgradeExportInput,
  AppSwitchStateResult,
  ProjectFinalizeInput,
  ProjectListInput,
  ProjectReopenInput,
  ProjectRenameInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotDocumentListInput,
  SnapshotDocumentReadInput,
  SnapshotListInput,
  SnapshotRollbackInput,
  SnapshotScreenshotInput,
} from '../../shared/types'
import { IPC_CHANNELS } from '../../shared/types'
import { fail, ok } from '../../shared/api-result'
import { cancelAgent, getSdkQuery, hasForegroundRun, isSessionActive, persistSteerDeferredNotice, publishSteerStatusEvent, registerBackgroundRun, runAgent, setAgentStreamPublisher, unregisterBackgroundRun } from '../orchestration/orchestrator'
import { enqueueSteer, getSteerStatuses, pendingSteerCount, registerSteer, resolveSteer, setSteerStatusListener, steerConfirmEnabled } from '../agent/loop/steer-queue'
import { savePastedImage } from '../platform/shell/pasted-images'
import { clearPendingReviewAction, setForegroundRunChecker, setProgrammingEventPublisher } from '../coding/programming-orchestrator'
import { handleAgentStreamEvent } from '../platform/shell/notifications'
import { assertToolAllowed, getPermissionMode, resolvePermission, setPermissionMode, setPermissionRequestPublisher } from '../agent/permissions/permission-service'
import {
  abandonProject,
  archiveProject,
  confirmSketch,
  createProject,
  deleteProject,
  finalizeProject,
  findProject,
  getProjectProgressSummary,
  listProjects,
  renameProject,
  reopenProject,
  unarchiveProject,
  updateProject,
  upgradeProject,
} from '../project/project-service'
import { cleanOrphanSessions, forkFrom, listSessions, loadMessages, setSessionActiveChecker } from '../platform/sessions/session-service'
import { exportProjectHandoff } from '../delivery/project-export'
import { upgradeExport } from '../coding/export-manifest'
import { readExperimentSwitches } from '../platform/shell/experiment-switches'
import { dirname } from 'node:path'
import { resolveRequirementConfirm } from '../guide/guide-agent-service'
import { createChannel, deleteChannel, fetchModels, listChannels, testChannel, testChannelDirect, updateChannel } from '../platform/llm/channel-manager'
import {
  buildCategoryRoutingRoleViews,
  buildCategoryRoutingViews,
  updateCategoryRouting,
  updateCategoryRoutingRoles,
} from '../platform/llm/category-routing'
import { listPromptSlots, readPromptSlot, resetPromptSlot, savePromptSlot } from '../agent/prompting/prompt-service'
import { listDocuments, readDocument, syncDocuments, isPrdUserConfirmed } from '../project/document-engine'
import { isCircuitBreakSettled, convergeStageFromEvidence, evaluateDiskArtifact } from '../project/recovery-service'
import { runSandbox, stopSandbox } from '../delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, listSnapshots, loadSnapshotScreenshot, readSnapshotDocument, rollbackSnapshot } from '../delivery/snapshots'
import { trackAnalytics } from '../delivery/track-analytics'
import { hasRequestId, isRecord, requireValue } from '../../shared/validators'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { safeInvoke, errorCodeFrom, extractRequestId, requireFields, resolvePermissionSession, validateAgentSend, validateCancel, validateConfirmRequirements, validatePermissionResponse, validateProjectCreate } from './shared'

export function registerPromptsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.PROMPT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return listPromptSlots()
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptReadInput>(payload, ['prompt_id'])
      return readPromptSlot(input.prompt_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_SAVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptSaveInput>(payload, ['prompt_id', 'content'])
      return savePromptSlot(input.prompt_id, input.content)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROMPT_RESET, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PromptResetInput>(payload, ['prompt_id'])
      return resetPromptSlot(input.prompt_id)
    })
  })
}

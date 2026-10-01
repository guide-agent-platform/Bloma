/**
 * 渠道与路由族：analytics-track + channel×7 + category-routing×4（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
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

export function registerChannelsRoutingIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TRACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AnalyticsTrackInput>(payload, ['event'])
      return trackAnalytics(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return listChannels()
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelCreateEnvelope>(payload, ['name', 'provider_type', 'base_url', 'api_key'])
      return createChannel(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelUpdateEnvelope>(payload, ['channel_id', 'input'])
      const updated = updateChannel(input.channel_id, input.input)
      if (!updated) {
        throw new Error('CHANNEL_NOT_FOUND: channel does not exist')
      }
      return updated
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_TEST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelTestEnvelope>(payload, ['channel_id'])
      return testChannel(input.channel_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_TEST_DIRECT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelTestDirectEnvelope>(payload, ['input'])
      return testChannelDirect(input.input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_FETCH_MODELS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<FetchModelsEnvelope>(payload, ['input'])
      return fetchModels(input.input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.CHANNEL_DELETE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelDeleteEnvelope>(payload, ['channel_id'])
      if (!deleteChannel(input.channel_id)) {
        throw new Error('CHANNEL_NOT_FOUND: channel does not exist')
      }
      return { deleted: true, channel_id: input.channel_id }
    })
  })

  // M5：类别 → 渠道路由（职责分工）。list 返回视图模型（渠道名/模型预览，不含明文 key）。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return buildCategoryRoutingViews()
    })
  })

  // M5：全量覆盖路由表。结构非法走 VALIDATION_ERROR；无效引用（已删除/非本项目/
  // 非 Anthropic 协议）在 updateCategoryRouting 内剥离 + console.warn，不阻塞其余类别。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CategoryRoutingUpdateEnvelope>(payload, ['routing'])
      return updateCategoryRouting(input.routing)
    })
  })

  // M5：三角色渠道路由（向导 / 编程 / 裁判）。角色配置在保存时展开到底层类别。
  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<RequestEnvelope>(payload, [])
      return buildCategoryRoutingRoleViews()
    })
  })

  ipcMain.handle(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_UPDATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<CategoryRoutingRoleUpdateEnvelope>(payload, ['routing'])
      return updateCategoryRoutingRoles(input.routing)
    })
  })

  // ==================== 提示词配置（设置页「提示词配置」Tab） ====================

}

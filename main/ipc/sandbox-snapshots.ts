/**
 * 沙箱/快照/文档族：sandbox run/stop/restore + snapshot×6 + document×3 + project-file-read（PR4d 自 ipc.ts 拆出；纯机械搬移，行为零变化）。
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
  ConfirmSketchInput,
  DocumentListInput,
  DocumentReadInput,
  DocumentSyncInput,
  DomCollectContextInput,
  DomScrollPreviewInput,
  PermissionResponseInput,
  PastedImageSaveInput,
  PermissionSetModeInput,
  PointCorrectionInput,
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
import { collectDomContext, scrollPreview } from '../verification/dom-context'
import { clearPendingReviewAction, runAgentLoopPostTesting, runIterationTask, runMvpTask, setForegroundRunChecker, setProgrammingEventPublisher } from '../coding/programming-orchestrator'
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
  submitCorrection,
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
import { isCircuitBreakSettled, convergeStageFromEvidence, evaluateDiskArtifact } from '../orchestration/recovery-service'
import { runSandbox, stopSandbox } from '../delivery/sandbox'
import { createSnapshot, listSnapshotDocuments, listSnapshots, loadSnapshotScreenshot, readSnapshotDocument, rollbackSnapshot } from '../delivery/snapshots'
import { trackAnalytics } from '../delivery/track-analytics'
import { hasRequestId, isRecord, requireValue } from '../../shared/validators'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { safeInvoke, errorCodeFrom, extractRequestId, requireFields, resolvePermissionSession, validateAgentSend, validateCancel, validateConfirmRequirements, validatePermissionResponse, validateProjectCreate, extractCorrectionPrompt, truncateForCorrection, MAX_CORRECTION_TARGET_LEN } from './shared'

export function registerSandboxSnapshotsIpc(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  void mainWindow
  ipcMain.handle(IPC_CHANNELS.SANDBOX_RUN, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxRunInput>(payload, ['project_id'])
      // 用户显式操作（沙箱运行按钮）走当前权限模式（默认 ask，可在设置中切换）
      await assertToolAllowed(
        'run_project',
        { project_id: input.project_id, command: input.command },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      return runSandbox(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_STOP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxStopInput>(payload, ['project_id'])
      return stopSandbox(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_RESTORE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxRunInput>(payload, ['project_id'])
      // 恢复路径（P0-2）：项目已产出草图/MVP 文件，但沙箱进程随主进程退出而亡，
      // 旧端口必死。用默认静态服务器直接重跑并回填 preview_url，不弹权限确认
      // （该本地项目本就归当前用户所有，命令受 runSandbox 白名单约束）。
      return runSandbox({ request_id: input.request_id, project_id: input.project_id })
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotCreateInput>(payload, ['project_id', 'kind', 'summary', 'health_status'])
      await assertToolAllowed(
        'create_snapshot',
        { project_id: input.project_id, kind: input.kind },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      return createSnapshot(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_ROLLBACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotRollbackInput>(payload, ['project_id', 'snapshot_id', 'reason'])
      // 危险操作（手动回滚）走当前权限模式（默认 ask，可在设置中切换）
      await assertToolAllowed(
        'rollback_snapshot',
        { project_id: input.project_id, snapshot_id: input.snapshot_id },
        resolvePermissionSession(input.project_id),
        getPermissionMode(),
        input.project_id,
      )
      const result = await rollbackSnapshot(input)
      // research-plan §5：user_undo 埋点（用户主动回滚使用率）。熔断/升级失败回滚走
      // self_repair_triggered / decision-log，不算用户主动撤销。
      if (input.reason === 'user_undo') {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'user_undo',
            project_id: input.project_id,
            session_id: resolvePermissionSession(input.project_id),
            payload: {
              snapshot_id: input.snapshot_id,
              reason: input.reason,
              stage: findProject(input.project_id).current_stage,
            },
            privacy_level: 'research_safe',
          },
        })
      }
      return result
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotListInput>(payload, ['project_id'])
      return { snapshots: listSnapshots(input.project_id) }
    })
  })

  // U9：快照缩略图——主进程读截图文件转 base64 data URL，供渲染端 `<img>` 展示。
  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_SCREENSHOT, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotScreenshotInput>(payload, ['project_id', 'snapshot_id'])
      return { data_url: await loadSnapshotScreenshot(input.project_id, input.snapshot_id) }
    })
  })

  // T7 文档版本化：时间轴回看某快照冻结的文档（「当时的想法」与代码快照对齐）。
  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_DOCUMENT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotDocumentListInput>(payload, ['project_id', 'snapshot_id'])
      return listSnapshotDocuments(input.project_id, input.snapshot_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_DOCUMENT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotDocumentReadInput>(payload, ['project_id', 'snapshot_id', 'document_id'])
      return readSnapshotDocument(input.project_id, input.snapshot_id, input.document_id)
    })
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_SYNC, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentSyncInput>(payload, ['project_id', 'session_id', 'checkpoint'])
      // 主进程内部生命周期节点（迭代收尾 / 模式升级）不允许 renderer 主动触发：
      // 防伪造 changelog/模式文档（2026-08-27 多角色审查 P2-IPC）。
      if (input.checkpoint === 'iteration_completed' || input.checkpoint === 'mode_upgraded') {
        throw new Error(`DOCUMENT_SYNC_FAILED: checkpoint ${input.checkpoint} is internal-only`)
      }
      return syncDocuments(input)
    })
  })

  // U2：文档面板——列出/读取项目文档（PRD/GWT/测试报告）。
  ipcMain.handle(IPC_CHANNELS.DOCUMENT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentListInput>(payload, ['project_id'])
      return { documents: listDocuments(input.project_id) }
    })
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentReadInput>(payload, ['project_id', 'document_id'])
      return readDocument(input.project_id, input.document_id)
    })
  })

  // W4/W6 文档面板：产物文件只读查看（项目根内；拒基础设施目录/标记/二进制；256KB 截断）
  ipcMain.handle(IPC_CHANNELS.PROJECT_FILE_READ, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectFileReadInput>(payload, ['project_id', 'path'])
      const project = findProject(input.project_id) // 缺项目时自抛 PROJECT_NOT_FOUND
      const rel = String(input.path).replace(/\\/g, '/').replace(/^\.\//, '')
      if (!rel || rel.includes('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) {
        throw new Error('FILE_READ_BAD_PATH: 路径必须是项目内相对路径')
      }
      const lower = rel.toLowerCase()
      const denied = lower.startsWith('node_modules/') || lower.startsWith('.git/') || lower.startsWith('data-backups/') || lower === '.bloma-real-variant'
      if (denied) throw new Error('FILE_READ_DENIED: 该路径不属于产物文件（基础设施/平台管理件）')
      const abs = join(project.root_path, rel)
      const stat = statSync(abs)
      if (!stat.isFile()) throw new Error('FILE_READ_NOT_FILE: 目标不是文件')
      const buf = readFileSync(abs)
      // 二进制喰探（前 8KB 出现 NUL 即判二进制，只读视图不支持）
      if (buf.subarray(0, 8192).includes(0)) throw new Error('FILE_READ_BINARY: 二进制文件不支持文本查看')
      const MAX = 256 * 1024
      const truncated = buf.byteLength > MAX
      return { path: rel, content: buf.subarray(0, MAX).toString('utf8'), truncated, bytes: buf.byteLength }
    })
  })

}

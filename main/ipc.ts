import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ConfirmSketchInput,
  DocumentSyncInput,
  PermissionResponseInput,
  PointCorrectionInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotRollbackInput,
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'
import { fail, ok } from './api-result'
import { cancelAgent, runAgent, setAgentStreamPublisher } from './orchestrator'
import { runMvpTask, runPostMvpTestingFlow, setProgrammingEventPublisher } from './programming-orchestrator'
import { assertToolAllowed, resolvePermission, setPermissionRequestPublisher } from './permission-service'
import { archiveProject, confirmSketch, createProject, findProject, listProjects, submitCorrection, upgradeProject } from './project-service'
import { listSessions, loadMessages } from './session-service'
import { createChannel, deleteChannel, listChannels, testChannel } from './channel-manager'
import { syncDocuments } from './document-engine'
import {
  createSnapshot,
  rollbackSnapshot,
  runSandbox,
  stopSandbox,
  trackAnalytics,
} from './platform-services'
import { hasRequestId, isRecord, requireValue } from './validators'

export function registerIpcHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  setAgentStreamPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
  })
  setProgrammingEventPublisher((event) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, event)
  })
  setPermissionRequestPublisher((request) => {
    mainWindow.webContents.send(IPC_CHANNELS.AGENT_STREAM_EVENT, {
      event_id: request.id,
      session_id: request.session_id,
      project_id: request.project_id,
      type: 'permission_requested',
      payload: { request },
      created_at: request.created_at,
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateAgentSend(payload)
      return runAgent(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateCancel(payload)
      return cancelAgent(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_LIST_SESSIONS, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentListSessionsInput>(payload, [])
      return listSessions(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_LOAD_MESSAGES, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<AgentLoadMessagesInput>(payload, ['session_id'])
      return loadMessages(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RESPONSE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validatePermissionResponse(payload)
      return resolvePermission(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = validateProjectCreate(payload)
      const project = createProject(input)
      trackAnalytics({
        request_id: input.request_id,
        event: {
          event_type: 'project_created',
          project_id: project.project_id,
          payload: { mode: project.mode },
          privacy_level: 'research_safe',
        },
      })
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      requireFields<{ request_id: string }>(payload, [])
      return listProjects()
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_ARCHIVE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectArchiveInput>(payload, ['project_id'])
      return archiveProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ConfirmSketchInput>(payload, ['project_id', 'session_id', 'snapshot_id', 'decision'])
      const project = confirmSketch(input)
      if (input.decision === 'accepted') {
        // 决策 D5：接受后 main 侧直接下发 MVP 生成，无需用户再次发消息；
        // MVP 就绪后自动进入测试与状态机后半段（A2-09）
        void runMvpTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: project.mode,
        })
          .then((mvp) =>
            runPostMvpTestingFlow({
              request_id: input.request_id,
              session_id: input.session_id,
              project_id: input.project_id,
              mode: project.mode,
              preview_url: mvp.preview_url,
            }),
          )
          .catch(() => undefined)
      }
      return project
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<PointCorrectionInput>(payload, ['project_id', 'session_id', 'mode'])
      return submitCorrection(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ProjectUpgradeInput>(payload, ['project_id', 'session_id'])
      // 切换模式前先创建 upgrade 快照，保留升级前的可回滚状态
      await createSnapshot({
        request_id: input.request_id,
        project_id: input.project_id,
        kind: 'upgrade',
        summary: '升级为长期迭代模式前的快照',
        include_documents: true,
        health_status: 'healthy',
      })
      return upgradeProject(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_RUN, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SandboxRunInput>(payload, ['project_id'])
      // 用户显式操作（沙箱运行按钮）走完整 ask 流程
      await assertToolAllowed(
        'run_project',
        { project_id: input.project_id, command: input.command },
        resolvePermissionSession(input.project_id),
        'ask',
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

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_CREATE, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotCreateInput>(payload, ['project_id', 'kind', 'summary', 'health_status'])
      await assertToolAllowed(
        'create_snapshot',
        { project_id: input.project_id, kind: input.kind },
        resolvePermissionSession(input.project_id),
        'ask',
        input.project_id,
      )
      return createSnapshot(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_ROLLBACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotRollbackInput>(payload, ['project_id', 'snapshot_id', 'reason'])
      // 危险操作（手动回滚）必须用户确认
      await assertToolAllowed(
        'rollback_snapshot',
        { project_id: input.project_id, snapshot_id: input.snapshot_id },
        resolvePermissionSession(input.project_id),
        'ask',
        input.project_id,
      )
      return rollbackSnapshot(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_SYNC, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<DocumentSyncInput>(payload, ['project_id', 'session_id', 'checkpoint'])
      return syncDocuments(input)
    })
  })

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

  ipcMain.handle(IPC_CHANNELS.CHANNEL_TEST, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<ChannelTestEnvelope>(payload, ['channel_id'])
      return testChannel(input.channel_id)
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
}

async function safeInvoke<T>(requestId: string, fn: () => T | Promise<T>) {
  try {
    return ok(requestId, await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
    if (message.includes('CHANNEL_NOT_FOUND')) return fail<T>(requestId, 'CHANNEL_NOT_FOUND', message)
    if (message.includes('SESSION_NOT_FOUND')) return fail<T>(requestId, 'SESSION_NOT_FOUND', message)
    if (message.includes('PROJECT_NOT_FOUND')) return fail<T>(requestId, 'PROJECT_NOT_FOUND', message)
    if (message.includes('PERMISSION_REQUEST_NOT_FOUND')) return fail<T>(requestId, 'PERMISSION_REQUEST_NOT_FOUND', message)
    if (message.includes('PERMISSION_DENIED')) return fail<T>(requestId, 'PERMISSION_DENIED', message)
    if (message.includes('SANDBOX_RUN_FAILED')) {
      return fail<T>(requestId, 'SANDBOX_RUN_FAILED', message, true, {
        category: message.split(':')[1] ?? 'unknown',
      })
    }
    if (message.includes('SNAPSHOT_CREATE_FAILED')) return fail<T>(requestId, 'SNAPSHOT_CREATE_FAILED', message, true)
    if (message.includes('DOCUMENT_SYNC_FAILED')) return fail<T>(requestId, 'DOCUMENT_SYNC_FAILED', message, true)
    if (message.includes('ANALYTICS_WRITE_FAILED')) return fail<T>(requestId, 'ANALYTICS_WRITE_FAILED', message, true)
    return fail<T>(requestId, 'VALIDATION_ERROR', message)
  }
}

function validateAgentSend(payload: unknown): AgentSendMessageInput {
  const input = requireFields<AgentSendMessageInput>(payload, ['session_id', 'project_id', 'content', 'mode', 'current_stage'])
  return input
}

function validateCancel(payload: unknown): AgentCancelInput {
  return requireFields<AgentCancelInput>(payload, ['session_id', 'reason'])
}

function validatePermissionResponse(payload: unknown): PermissionResponseInput {
  return requireFields<PermissionResponseInput>(payload, ['permission_request_id', 'session_id', 'decision'])
}

function validateProjectCreate(payload: unknown): ProjectCreateInput {
  const input = requireFields<ProjectCreateInput>(payload, ['mode'])
  if (input.mode !== 'quick' && input.mode !== 'longterm') throw new Error('mode must be quick or longterm')
  return input
}

function extractRequestId(payload: unknown): string {
  return hasRequestId(payload) ? payload.request_id : ''
}

/** IPC 层权限门禁的会话标识：优先取项目最近会话，缺失时退化为 project_id。 */
function resolvePermissionSession(projectId: string): string {
  try {
    return findProject(projectId).last_session_id ?? projectId
  } catch {
    return projectId
  }
}

function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}

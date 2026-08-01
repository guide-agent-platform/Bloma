import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  ConfirmSketchInput,
  DocumentSyncInput,
  PermissionResponseInput,
  PointCorrectionInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectUpgradeInput,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotRollbackInput,
} from '../shared/types'
import { IPC_CHANNELS } from '../shared/types'
import { fail, ok } from './api-result'
import { cancelAgent, runAgent, setAgentStreamPublisher } from './orchestrator'
import { resolvePermission, setPermissionRequestPublisher } from './permission-service'
import { archiveProject, confirmSketch, createProject, listProjects, submitCorrection, upgradeProject } from './project-service'
import {
  createSnapshot,
  rollbackSnapshot,
  runSandbox,
  stopSandbox,
  syncDocuments,
  trackAnalytics,
} from './platform-services'
import { hasRequestId, isRecord, requireValue } from './validators'

export function registerIpcHandlers(ipcMain: IpcMain, mainWindow: BrowserWindow): void {
  setAgentStreamPublisher((event) => {
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
      return confirmSketch(input)
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
      return createSnapshot(input)
    })
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_ROLLBACK, async (_event, payload: unknown) => {
    return safeInvoke(extractRequestId(payload), async () => {
      const input = requireFields<SnapshotRollbackInput>(payload, ['project_id', 'snapshot_id', 'reason'])
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
}

async function safeInvoke<T>(requestId: string, fn: () => T | Promise<T>) {
  try {
    return ok(requestId, await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
    if (message.includes('CHANNEL_NOT_FOUND')) return fail<T>(requestId, 'CHANNEL_NOT_FOUND', message)
    if (message.includes('PROJECT_NOT_FOUND')) return fail<T>(requestId, 'PROJECT_NOT_FOUND', message)
    if (message.includes('PERMISSION_REQUEST_NOT_FOUND')) return fail<T>(requestId, 'PERMISSION_REQUEST_NOT_FOUND', message)
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

function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!isRecord(payload)) throw new Error('Invalid payload: expected object')
  if (!hasRequestId(payload)) throw new Error('Missing required field: request_id')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}

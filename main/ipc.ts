import type { BrowserWindow, IpcMain } from 'electron'
import type {
  AgentCancelInput,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  ConfirmSketchInput,
  DocumentSyncInput,
  PermissionResponseInput,
  PointCorrectionInput,
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
import { confirmSketch, createProject, submitCorrection, upgradeProject } from './project-service'
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
    const input = validateAgentSend(payload)
    return safeInvoke(input.request_id, () => runAgent(input))
  })

  ipcMain.handle(IPC_CHANNELS.AGENT_STOP, async (_event, payload: unknown) => {
    const input = validateCancel(payload)
    return safeInvoke(input.request_id, () => cancelAgent(input))
  })

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RESPONSE, async (_event, payload: unknown) => {
    const input = validatePermissionResponse(payload)
    return safeInvoke(input.request_id, () => resolvePermission(input))
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, payload: unknown) => {
    const input = validateProjectCreate(payload)
    return safeInvoke(input.request_id, () => createProject(input))
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, async (_event, payload: unknown) => {
    const input = requireFields<ConfirmSketchInput>(payload, ['project_id', 'session_id', 'snapshot_id', 'decision'])
    return safeInvoke(input.request_id, () => confirmSketch(input))
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION, async (_event, payload: unknown) => {
    const input = requireFields<PointCorrectionInput>(payload, ['project_id', 'session_id', 'mode'])
    return safeInvoke(input.request_id, () => submitCorrection(input))
  })

  ipcMain.handle(IPC_CHANNELS.PROJECT_UPGRADE, async (_event, payload: unknown) => {
    const input = requireFields<ProjectUpgradeInput>(payload, ['project_id', 'session_id'])
    return safeInvoke(input.request_id, () => upgradeProject(input))
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_RUN, async (_event, payload: unknown) => {
    const input = requireFields<SandboxRunInput>(payload, ['project_id'])
    return safeInvoke(input.request_id, () => runSandbox(input))
  })

  ipcMain.handle(IPC_CHANNELS.SANDBOX_STOP, async (_event, payload: unknown) => {
    const input = requireFields<SandboxStopInput>(payload, ['project_id'])
    return safeInvoke(input.request_id, () => stopSandbox(input))
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_CREATE, async (_event, payload: unknown) => {
    const input = requireFields<SnapshotCreateInput>(payload, ['project_id', 'kind', 'summary', 'health_status'])
    return safeInvoke(input.request_id, () => createSnapshot(input))
  })

  ipcMain.handle(IPC_CHANNELS.SNAPSHOT_ROLLBACK, async (_event, payload: unknown) => {
    const input = requireFields<SnapshotRollbackInput>(payload, ['project_id', 'snapshot_id', 'reason'])
    return safeInvoke(input.request_id, () => rollbackSnapshot(input))
  })

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_SYNC, async (_event, payload: unknown) => {
    const input = requireFields<DocumentSyncInput>(payload, ['project_id', 'session_id', 'checkpoint'])
    return safeInvoke(input.request_id, () => syncDocuments(input))
  })

  ipcMain.handle(IPC_CHANNELS.ANALYTICS_TRACK, async (_event, payload: unknown) => {
    const input = requireFields<AnalyticsTrackInput>(payload, ['event'])
    return safeInvoke(input.request_id, () => trackAnalytics(input))
  })
}

async function safeInvoke<T>(requestId: string, fn: () => T | Promise<T>) {
  try {
    return ok(requestId, await fn())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('AGENT_SESSION_BUSY')) return fail<T>(requestId, 'AGENT_SESSION_BUSY', message, true)
    if (message.includes('PROJECT_NOT_FOUND')) return fail<T>(requestId, 'PROJECT_NOT_FOUND', message)
    if (message.includes('PERMISSION_REQUEST_NOT_FOUND')) return fail<T>(requestId, 'PERMISSION_REQUEST_NOT_FOUND', message)
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

function requireFields<T extends { request_id: string }>(payload: unknown, fields: string[]): T {
  if (!hasRequestId(payload) || !isRecord(payload)) throw new Error('request_id is required')
  for (const field of fields) requireValue(payload, field)
  return payload as T
}

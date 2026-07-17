import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  AgentCancelInput,
  AgentEvent,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  ConfirmSketchInput,
  DocumentSyncInput,
  ElectronAPI,
  PermissionResponseInput,
  PointCorrectionInput,
  ProjectCreateInput,
  ProjectUpgradeInput,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotRollbackInput,
} from '../shared/types'

const electronAPI: ElectronAPI = {
  agent: {
    sendMessage: (input: AgentSendMessageInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, input),
    cancel: (input: AgentCancelInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP, input),
    onStreamEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AgentEvent) => listener(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_EVENT, handler)
    },
  },
  permissions: {
    respond: (input: PermissionResponseInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RESPONSE, input),
  },
  project: {
    create: (input: ProjectCreateInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, input),
    confirmSketch: (input: ConfirmSketchInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, input),
    submitCorrection: (input: PointCorrectionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION, input),
    upgrade: (input: ProjectUpgradeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPGRADE, input),
  },
  sandbox: {
    run: (input: SandboxRunInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_RUN, input),
    stop: (input: SandboxStopInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_STOP, input),
  },
  snapshots: {
    create: (input: SnapshotCreateInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_CREATE, input),
    rollback: (input: SnapshotRollbackInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_ROLLBACK, input),
  },
  documents: {
    sync: (input: DocumentSyncInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_SYNC, input),
  },
  analytics: {
    track: (input: AnalyticsTrackInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.ANALYTICS_TRACK, input),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

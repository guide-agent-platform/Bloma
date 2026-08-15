/**
 * Preload 脚本
 *
 * 通过 contextBridge 将主进程 API 安全地暴露给渲染进程。
 * 这是 IPC 四层架构的 Layer 3。
 *
 * === 四层架构全貌 ===
 *
 * Layer 1: shared/types.ts (IPC_CHANNELS 常量 + 所有类型)
 * Layer 2: main/ipc.ts (ipcMain.handle(IPC_CHANNELS.AGENT_SEND_MESSAGE, handler))
 * Layer 3: preload/bridge.ts (← 你在这里)
 * Layer 4: renderer/agent-atoms.ts (window.electronAPI.agent.sendMessage(input))
 *
 * === 禁止暴露 ===
 * - fs, path, child_process 等 Node.js 内置模块
 * - process.env（API Key 等敏感信息）
 * - ipcRenderer 直接调用
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CHANNELS } from '../shared/types'
import type {
  AgentCancelInput,
  AgentEvent,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AnalyticsTrackInput,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ChannelTestDirectEnvelope,
  ChannelUpdateEnvelope,
  FetchModelsEnvelope,
  ConfirmSketchInput,
  DocumentSyncInput,
  ElectronAPI,
  PermissionResponseInput,
  PointCorrectionInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectListInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotListInput,
  SnapshotRollbackInput,
} from '../shared/types'

const electronAPI: ElectronAPI = {
  agent: {
    sendMessage: (input: AgentSendMessageInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, input),
    cancel: (input: AgentCancelInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP, input),
    listSessions: (input: AgentListSessionsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST_SESSIONS, input),
    loadMessages: (input: AgentLoadMessagesInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_LOAD_MESSAGES, input),
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
    list: (input: ProjectListInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST, input),
    archive: (input: ProjectArchiveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ARCHIVE, input),
    unarchive: (input: ProjectUnarchiveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UNARCHIVE, input),
    delete: (input: ProjectDeleteInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELETE, input),
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
    restore: (input: SandboxRunInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SANDBOX_RESTORE, input),
  },
  snapshots: {
    create: (input: SnapshotCreateInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_CREATE, input),
    rollback: (input: SnapshotRollbackInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_ROLLBACK, input),
    list: (input: SnapshotListInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_LIST, input),
  },
  documents: {
    sync: (input: DocumentSyncInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_SYNC, input),
  },
  analytics: {
    track: (input: AnalyticsTrackInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.ANALYTICS_TRACK, input),
  },
  channels: {
    list: (input: RequestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_LIST, input),
    create: (input: ChannelCreateEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_CREATE, input),
    update: (input: ChannelUpdateEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_UPDATE, input),
    test: (input: ChannelTestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_TEST, input),
    testDirect: (input: ChannelTestDirectEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_TEST_DIRECT, input),
    fetchModels: (input: FetchModelsEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_FETCH_MODELS, input),
    delete: (input: ChannelDeleteEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_DELETE, input),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

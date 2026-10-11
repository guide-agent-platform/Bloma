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
  AgentConfirmRequirementsInput,
  AgentEvent,
  AgentListSessionsInput,
  AgentLoadMessagesInput,
  AgentSendMessageInput,
  AgentSteerMessageInput,
  AgentSteerQueryInput,
  AgentSteerResolveInput,
  AgentForkSessionInput,
  AnalyticsTrackInput,
  CategoryRoutingUpdateEnvelope,
  CategoryRoutingRoleUpdateEnvelope,
  ChannelCreateEnvelope,
  ChannelDeleteEnvelope,
  ChannelTestEnvelope,
  ChannelTestDirectEnvelope,
  ChannelUpdateEnvelope,
  DesktopArtifactEventPayload,
  DesktopArtifactImageInput,
  DesktopArtifactSubscribeInput,
  FetchModelsEnvelope,
  DocumentListInput,
  DocumentReadInput,
  DocumentSyncInput,
  ElectronAPI,
  PermissionResponseInput,
  PermissionSetModeInput,
  PromptReadInput,
  PromptResetInput,
  PromptSaveInput,
  ProjectAbandonInput,
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectDeleteInput,
  ProjectExportInput,
  ProjectFileReadInput,
  ProjectUpgradeExportInput,
  AppSwitchStateInput,
  ProjectFinalizeInput,
  ProjectListInput,
  ProjectReopenInput,
  ProjectRenameInput,
  ProjectUnarchiveInput,
  ProjectUpgradeInput,
  RequestEnvelope,
  PastedImageSaveInput,
  SpeechTranscribeInput,
  NotificationSpeakInput,
  SandboxRunInput,
  SandboxStopInput,
  SnapshotCreateInput,
  SnapshotListInput,
  SnapshotRollbackInput,
  SnapshotDocumentListInput,
  SnapshotDocumentReadInput,
  SnapshotScreenshotInput,
} from '../shared/types'

const electronAPI: ElectronAPI = {
  clipboard: {
    writeText: (input) => ipcRenderer.invoke(IPC_CHANNELS.CLIPBOARD_WRITE_TEXT, input),
  },
  app: {
    switchState: (input: AppSwitchStateInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_SWITCH_STATE, input),
  },
  composer: {
    load: (input) => ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_LOAD, input),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_SAVE, input),
    importImage: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_IMPORT, input),
    preview: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_PREVIEW, input),
    read: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_READ, input),
    submit: (input) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SUBMIT, input),
    receipt: (input) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_RECEIPT, input),
    receipts: (input) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_RECEIPTS, input),
    recover: (input) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_RECOVER, input),
    history: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_HISTORY, input),
    reuse: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_REUSE, input),
  },
  pastedImage: {
    save: (input: PastedImageSaveInput) => ipcRenderer.invoke(IPC_CHANNELS.PASTED_IMAGE_SAVE, input),
  },
  speech: {
    speakNotification: (input: NotificationSpeakInput) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_SPEAK, input),
    catalog: (input: RequestEnvelope) => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_CATALOG, input),
    prepare: (input: RequestEnvelope) => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_PREPARE, input),
    cancelPreparation: (input: RequestEnvelope) => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_CANCEL_PREPARATION, input),
    transcribe: (input: SpeechTranscribeInput) => ipcRenderer.invoke(IPC_CHANNELS.SPEECH_TRANSCRIBE, input),
  },
  agent: {
    sendMessage: (input: AgentSendMessageInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, input),
    steerMessage: (input: AgentSteerMessageInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER_MESSAGE, input),
    steerResolve: (input: AgentSteerResolveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER_RESOLVE, input),
    steerQuery: (input: AgentSteerQueryInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STEER_QUERY, input),
    forkSession: (input: AgentForkSessionInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_FORK_SESSION, input),
    cancel: (input: AgentCancelInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_STOP, input),
    listSessions: (input: AgentListSessionsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_LIST_SESSIONS, input),
    loadMessages: (input: AgentLoadMessagesInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_LOAD_MESSAGES, input),
    cleanOrphans: (input: RequestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.SESSION_CLEAN_ORPHANS, input),
    confirmRequirements: (input: AgentConfirmRequirementsInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_CONFIRM_REQUIREMENTS, input),
    onStreamEvent: (listener: (event: AgentEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: AgentEvent) => listener(data)
      ipcRenderer.on(IPC_CHANNELS.AGENT_STREAM_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_STREAM_EVENT, handler)
    },
  },
  permissions: {
    respond: (input: PermissionResponseInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_RESPONSE, input),
    setMode: (input: PermissionSetModeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PERMISSION_SET_MODE, input),
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
    export: (input: ProjectExportInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_EXPORT, input),
    upgradeExport: (input: ProjectUpgradeExportInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPGRADE_EXPORT, input),
    fileRead: (input: ProjectFileReadInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_FILE_READ, input),
    rename: (input: ProjectRenameInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_RENAME, input),
    abandon: (input: ProjectAbandonInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_ABANDON, input),
    reopen: (input: ProjectReopenInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_REOPEN, input),
    upgrade: (input: ProjectUpgradeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_UPGRADE, input),
    finalize: (input: ProjectFinalizeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_FINALIZE, input),
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
    screenshot: (input: SnapshotScreenshotInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_SCREENSHOT, input),
    documentList: (input: SnapshotDocumentListInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_DOCUMENT_LIST, input),
    documentRead: (input: SnapshotDocumentReadInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.SNAPSHOT_DOCUMENT_READ, input),
  },
  documents: {
    sync: (input: DocumentSyncInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_SYNC, input),
    list: (input: DocumentListInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_LIST, input),
    read: (input: DocumentReadInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_READ, input),
  },
  dom: {
  },
  projectDeliverables: {
    get: (input: import('../shared/types').ProjectDeliverablesInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_DELIVERABLES, input),
    launch: (input: import('../shared/types').ProjectLaunchAppInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LAUNCH_APP, input),
  },
  correction: {
    start: (input: import('../shared/types').CorrectionStartInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.CORRECTION_START, input),
    picks: (input: import('../shared/types').CorrectionPicksInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.CORRECTION_PICKS, input),
    finish: (input: import('../shared/types').CorrectionFinishInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.CORRECTION_FINISH, input),
  },
  desktopArtifacts: {
    subscribe: (input: DesktopArtifactSubscribeInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_ARTIFACT_SUBSCRIBE, input),
    image: (input: DesktopArtifactImageInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.DESKTOP_ARTIFACT_IMAGE, input),
    onArtifactEvent: (listener: (payload: DesktopArtifactEventPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, data: DesktopArtifactEventPayload) => listener(data)
      ipcRenderer.on(IPC_CHANNELS.DESKTOP_ARTIFACT_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.DESKTOP_ARTIFACT_EVENT, handler)
    },
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
    categoryRoutingList: (input: RequestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATEGORY_ROUTING_LIST, input),
    categoryRoutingUpdate: (input: CategoryRoutingUpdateEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATEGORY_ROUTING_UPDATE, input),
    categoryRoutingRoleList: (input: RequestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_LIST, input),
    categoryRoutingRoleUpdate: (input: CategoryRoutingRoleUpdateEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.CATEGORY_ROUTING_ROLE_UPDATE, input),
  },
  prompts: {
    list: (input: RequestEnvelope) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROMPT_LIST, input),
    read: (input: PromptReadInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROMPT_READ, input),
    save: (input: PromptSaveInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROMPT_SAVE, input),
    reset: (input: PromptResetInput) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROMPT_RESET, input),
  },
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

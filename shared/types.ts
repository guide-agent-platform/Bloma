/**
 * @proma/shared — 共享类型 + IPC 通道常量
 *
 * 这是 IPC 四层架构的 Layer 1：单一真相源。
 * 所有 IPC 通道的请求/响应类型在这里定义，
 * main/preload/renderer 三层都引用这里的类型。
 *
 * 版本：v1.1-sprint0 | 日期：2026-07-18
 * 对齐：A 的 Bloma project (E:\Psr\develop\sprint0\Bloma\shared\types.ts)
 * 依赖：DOC-4.1 api-spec.md、DOC-3.4 data-model.md
 */

// =========================================================================
// 1. IPC 通道常量（单一扁平对象）
// =========================================================================

export const IPC_CHANNELS = {
  AGENT_SEND_MESSAGE: 'agent:send-message',
  AGENT_STOP: 'agent:stop',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PROJECT_CREATE: 'project:create',
  PROJECT_CONFIRM_SKETCH: 'project:confirm-sketch',
  PROJECT_SUBMIT_CORRECTION: 'project:submit-correction',
  PROJECT_UPGRADE: 'project:upgrade',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_STOP: 'sandbox:stop',
  SNAPSHOT_CREATE: 'snapshot:create',
  SNAPSHOT_ROLLBACK: 'snapshot:rollback',
  DOCUMENT_SYNC: 'document:sync',
  ANALYTICS_TRACK: 'analytics:track',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

// =========================================================================
// 2. 通用基础类型
// =========================================================================

/** 请求包装（所有 invoke input 必须 extend） */
export interface RequestEnvelope {
  request_id: string
}

export type ApiResult<T> =
  | { ok: true; request_id: string; data: T }
  | { ok: false; request_id: string; error: ApiError }

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'IPC_CHANNEL_NOT_FOUND'
  | 'AGENT_SESSION_BUSY'
  | 'AGENT_SDK_ERROR'
  | 'AGENT_SDK_TIMEOUT'
  | 'AGENT_CANCELLED'
  | 'CHANNEL_NOT_FOUND'
  | 'API_KEY_DECRYPT_FAILED'
  | 'PERMISSION_REQUEST_NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'PROJECT_NOT_FOUND'
  | 'SANDBOX_CREATE_FAILED'
  | 'SANDBOX_RUN_FAILED'
  | 'SANDBOX_PERMISSION_DENIED'
  | 'SNAPSHOT_CREATE_FAILED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'ROLLBACK_FAILED'
  | 'DOCUMENT_SYNC_FAILED'
  | 'ANALYTICS_WRITE_FAILED'
  | 'LOCAL_STORE_WRITE_FAILED'

export interface ApiError {
  code: ErrorCode
  message: string
  user_visible_message?: string
  retryable: boolean
  details?: Record<string, unknown>
}

/** 取消订阅函数 */
export type Unsubscribe = () => void

// =========================================================================
// 3. 平台枚举
// =========================================================================

export type ProjectMode = 'quick' | 'longterm'

export type WorkflowStage =
  | 'choosing_mode'
  | 'clarifying'
  | 'generating_sketch'
  | 'sketch_ready'
  | 'generating_mvp'
  | 'testing'
  | 'judge_review'
  | 'repairing'
  | 'ready'
  | 'iterating'
  | 'completed'
  | 'upgrading'
  | 'blocked_for_user_decision'

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'choosing_mode',
  'clarifying',
  'generating_sketch',
  'sketch_ready',
  'generating_mvp',
  'testing',
  'judge_review',
  'repairing',
  'ready',
  'iterating',
  'completed',
  'upgrading',
  'blocked_for_user_decision',
]

export type SnapshotKind = 'sketch' | 'mvp' | 'iteration' | 'pre_risk' | 'upgrade' | 'rollback_guard'
export type ProviderType = 'anthropic' | 'openai' | 'google' | 'deepseek' | 'zhipu' | 'minimax' | 'doubao' | 'qwen' | 'custom'
export type TemplateType = 'web_fullstack' | 'desktop_tool' | 'personal_tool' | 'ai_app'
export type PermissionDecision = 'allow' | 'deny'
export type DangerLevel = 'safe' | 'warning' | 'dangerous'
export type PromaPermissionMode = 'safe' | 'ask' | 'allow-all'
export type HealthStatus = 'healthy' | 'unhealthy'

// =========================================================================
// 4. 渠道（A 的 snake_case 约定）
// =========================================================================

export interface ChannelModel {
  id: string
  name: string
  enabled: boolean
}

export interface Channel {
  id: string
  name: string
  provider_type: ProviderType
  base_url: string
  /** safeStorage.encryptString() 加密后的 hex 字符串 */
  api_key: string
  models: ChannelModel[]
  enabled: boolean
}

export interface ChannelCreateInput {
  name: string
  provider_type: ProviderType
  base_url: string
  api_key: string
  models?: ChannelModel[]
}

// =========================================================================
// 5. Agent 核心类型
// =========================================================================

export interface MessageContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system'
  content: MessageContentBlock[]
  timestamp: number
}

export interface SDKMessage {
  type: 'user' | 'assistant' | 'system' | 'result'
  message?: { role: string; content: MessageContentBlock[] }
  subtype?: string
}

/** Agent 会话元数据（renderer 侧定义，非 IPC 传输） */
export interface AgentSessionMeta {
  session_id: string
  project_id: string
  title: string
  created_at: string
}

// =========================================================================
// 6. Agent IPC 输入/输出
// =========================================================================

export interface AgentSendMessageInput extends RequestEnvelope {
  session_id: string
  project_id: string
  content: string
  mode: ProjectMode
  current_stage: WorkflowStage
  channel_id?: string
  metadata?: {
    source: 'chat' | 'card_option' | 'system_resume'
    selected_option_id?: string
  }
}

export interface AgentSendMessageResult {
  accepted: true
  session_id: string
  stream_started: boolean
}

export interface AgentCancelInput extends RequestEnvelope {
  session_id: string
  reason: 'user_cancelled' | 'route_change' | 'shutdown'
}

export interface AgentCancelResult {
  cancelled: boolean
  session_id: string
}

// =========================================================================
// 7. 权限
// =========================================================================

export interface PermissionRequest {
  id: string
  session_id: string
  project_id?: string
  tool_name: string
  tool_input: Record<string, unknown>
  danger_level: DangerLevel
  user_visible_summary: string
  created_at: string
}

export interface PermissionResponseInput extends RequestEnvelope {
  permission_request_id: string
  session_id: string
  decision: PermissionDecision
  remember_for_session?: boolean
}

export interface PermissionResponseResult {
  resolved: true
  permission_request_id: string
}

// =========================================================================
// 8. Agent 流式事件
// =========================================================================

export interface AgentEvent {
  event_id: string
  session_id: string
  project_id?: string
  type:
    | 'message_delta'
    | 'message_completed'
    | 'stage_changed'
    | 'tool_call_started'
    | 'tool_call_completed'
    | 'permission_requested'
    | 'sketch_ready'
    | 'mvp_ready'
    | 'repairing'
    | 'rollback_done'
    | 'judge_result'
    | 'user_decision_required'
    | 'retrying'
    | 'error'
    | 'completed'
  payload: Record<string, unknown>
  created_at: string
}

// =========================================================================
// 9. 项目
// =========================================================================

export interface ProjectCreateInput extends RequestEnvelope {
  mode: ProjectMode
  initial_message?: string
}

export interface Project {
  project_id: string
  workspace_slug: string
  name: string
  mode: ProjectMode
  template_type: TemplateType
  status: 'active' | 'completed' | 'abandoned' | 'archived'
  current_stage: WorkflowStage
  root_path: string
  current_snapshot_id?: string
  created_at: string
  updated_at: string
}

export interface ConfirmSketchInput extends RequestEnvelope {
  project_id: string
  session_id: string
  snapshot_id: string
  decision: 'accepted' | 'needs_change'
  note?: string
}

export interface CorrectionContext {
  element_selector?: string
  text_content?: string
  bounding_rect: { x: number; y: number; width: number; height: number }
  screenshot_region_path?: string
  fallback_mode: boolean
}

export interface PointCorrectionInput extends RequestEnvelope {
  project_id: string
  session_id: string
  context: CorrectionContext
  user_note?: string
  mode: 'user_note' | 'guess'
}

export interface RevisionAccepted {
  accepted: true
  task_id: string
}

export interface ProjectUpgradeInput extends RequestEnvelope {
  project_id: string
  session_id: string
}

// =========================================================================
// 10. 沙箱
// =========================================================================

export interface SandboxRunInput extends RequestEnvelope {
  project_id: string
  command?: string
  timeout_ms?: number
}

export interface SandboxRunResult {
  status: 'running' | 'failed'
  preview_url?: string
  port?: number
  error_summary?: { category: string; user_visible_summary: string }
}

export interface SandboxStopInput extends RequestEnvelope {
  project_id: string
}

export interface SandboxStopResult {
  stopped: boolean
}

// =========================================================================
// 11. 快照
// =========================================================================

export interface SnapshotCreateInput extends RequestEnvelope {
  project_id: string
  kind: SnapshotKind
  summary: string
  include_documents: boolean
  health_status: HealthStatus
}

export interface Snapshot {
  snapshot_id: string
  project_id: string
  kind: SnapshotKind
  name: string
  summary: string
  screenshot_path?: string
  files_archive_path: string
  documents_archive_path?: string
  health_status: HealthStatus
  parent_snapshot_id?: string
  created_at: string
}

export interface SnapshotRollbackInput extends RequestEnvelope {
  project_id: string
  snapshot_id: string
  reason: 'user_undo' | 'repair_fuse' | 'upgrade_failed'
}

export interface RollbackResult {
  rolled_back: true
  project_id: string
  current_snapshot_id: string
  guard_snapshot_id: string
  preview_url?: string
}

// =========================================================================
// 12. 文档
// =========================================================================

export interface DocumentSyncInput extends RequestEnvelope {
  project_id: string
  session_id: string
  checkpoint: 'sketch_confirmed' | 'mvp_before_generation' | 'mvp_tested' | 'iteration_completed' | 'mode_upgraded'
  changed_files?: string[]
}

export interface DocumentRef {
  document_id: string
  type: 'prd' | 'user_story' | 'plantuml' | 'gwt_feature' | 'test_report' | 'changelog'
  path: string
  status: 'draft' | 'synced' | 'stale' | 'confirmed'
}

export interface DocumentSyncResult {
  documents: DocumentRef[]
  stale_documents: DocumentRef[]
}

// =========================================================================
// 13. 分析/埋点
// =========================================================================

export interface AnalyticsTrackInput extends RequestEnvelope {
  event: {
    event_type:
      | 'project_created'
      | 'conversation_submitted'
      | 'guide_role_switched'
      | 'sketch_generated'
      | 'mvp_delivered'
      | 'user_undo'
      | 'point_correction'
      | 'mode_upgraded'
      | 'programming_execution'
      | 'self_repair_triggered'
      | 'judge_verdict'
      | 'satisfaction_marked'
      | 'project_finalized'
    project_id?: string
    session_id?: string
    payload: Record<string, unknown>
    privacy_level: 'raw' | 'masked' | 'research_safe'
  }
}

export interface AnalyticsTrackResult {
  recorded: true
  event_id: string
}

// =========================================================================
// 14. Renderer Bridge API 契约（ElectronAPI）
// =========================================================================

export type ElectronAPI = {
  agent: {
    sendMessage(input: AgentSendMessageInput): Promise<ApiResult<AgentSendMessageResult>>
    cancel(input: AgentCancelInput): Promise<ApiResult<AgentCancelResult>>
    onStreamEvent(listener: (event: AgentEvent) => void): () => void
  }
  permissions: {
    respond(input: PermissionResponseInput): Promise<ApiResult<PermissionResponseResult>>
  }
  project: {
    create(input: ProjectCreateInput): Promise<ApiResult<Project>>
    confirmSketch(input: ConfirmSketchInput): Promise<ApiResult<Project>>
    submitCorrection(input: PointCorrectionInput): Promise<ApiResult<RevisionAccepted>>
    upgrade(input: ProjectUpgradeInput): Promise<ApiResult<Project>>
  }
  sandbox: {
    run(input: SandboxRunInput): Promise<ApiResult<SandboxRunResult>>
    stop(input: SandboxStopInput): Promise<ApiResult<SandboxStopResult>>
  }
  snapshots: {
    create(input: SnapshotCreateInput): Promise<ApiResult<Snapshot>>
    rollback(input: SnapshotRollbackInput): Promise<ApiResult<RollbackResult>>
  }
  documents: {
    sync(input: DocumentSyncInput): Promise<ApiResult<DocumentSyncResult>>
  }
  analytics: {
    track(input: AnalyticsTrackInput): Promise<ApiResult<AnalyticsTrackResult>>
  }
}

// =========================================================================
// 15. 全局类型声明
// =========================================================================

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}

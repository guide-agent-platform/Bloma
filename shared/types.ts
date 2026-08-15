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
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_LOAD_MESSAGES: 'agent:load-messages',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_CONFIRM_SKETCH: 'project:confirm-sketch',
  PROJECT_SUBMIT_CORRECTION: 'project:submit-correction',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_UNARCHIVE: 'project:unarchive',
  PROJECT_DELETE: 'project:delete',
  PROJECT_UPGRADE: 'project:upgrade',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_STOP: 'sandbox:stop',
  SANDBOX_RESTORE: 'sandbox:restore',
  SNAPSHOT_CREATE: 'snapshot:create',
  SNAPSHOT_ROLLBACK: 'snapshot:rollback',
  SNAPSHOT_LIST: 'snapshot:list',
  DOCUMENT_SYNC: 'document:sync',
  ANALYTICS_TRACK: 'analytics:track',
  CHANNEL_LIST: 'channel:list',
  CHANNEL_CREATE: 'channel:create',
  CHANNEL_UPDATE: 'channel:update',
  CHANNEL_TEST: 'channel:test',
  CHANNEL_TEST_DIRECT: 'channel:test-direct',
  CHANNEL_FETCH_MODELS: 'channel:fetch-models',
  CHANNEL_DELETE: 'channel:delete',
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
  | 'SESSION_NOT_FOUND'
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
export type ProviderType =
  | 'anthropic'
  | 'anthropic-compatible'
  | 'openai'
  | 'openai-responses'
  | 'deepseek'
  | 'google'
  | 'kimi-api'
  | 'kimi-coding'
  | 'opencode-go-openai'
  | 'zhipu'
  | 'zhipu-coding'
  | 'zhipu-coding-team'
  | 'ark-coding-plan'
  | 'minimax'
  | 'doubao'
  | 'qwen'
  | 'qwen-anthropic'
  | 'qwen-token-plan'
  | 'xiaomi'
  | 'xiaomi-token-plan'
  | 'custom'
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
  /** 来源：manual=手填，fetched=从供应商 API 拉取（默认 manual） */
  source?: 'manual' | 'fetched'
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
  /** 单次响应的最大 token 数（缺省 1200，见 orchestrator 默认值） */
  max_tokens?: number
}

export interface ChannelCreateInput {
  name: string
  provider_type: ProviderType
  base_url: string
  api_key: string
  models?: ChannelModel[]
  max_tokens?: number
}

/** IPC 层渠道创建输入：在 ChannelCreateInput 上叠加 request_id 包装（复用 §4 域模型）。 */
export type ChannelCreateEnvelope = RequestEnvelope & ChannelCreateInput

/** 渠道更新输入：全字段可选；api_key 传空字符串表示不更新（编辑表单留空时）。 */
export interface ChannelUpdateInput {
  name?: string
  provider_type?: ProviderType
  base_url?: string
  /** 明文 API Key；空字符串表示不更新 */
  api_key?: string
  models?: ChannelModel[]
  enabled?: boolean
  max_tokens?: number
}

export interface ChannelUpdateEnvelope extends RequestEnvelope {
  channel_id: string
  input: ChannelUpdateInput
}

export interface ChannelTestEnvelope extends RequestEnvelope {
  channel_id: string
}

/** 连接测试失败归一化分类 */
export type ChannelTestErrorType =
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limit'
  | 'quota'
  | 'bad_request'
  | 'server'
  | 'network'
  | 'timeout'
  | 'unknown'

export interface ChannelTestResult {
  ok: boolean
  message: string
  errorType?: ChannelTestErrorType
  statusCode?: number
  detail?: string
}

/** 保存前直接测试连接（无需已保存渠道，明文凭证） */
export interface ChannelDirectTestInput {
  provider_type: ProviderType
  base_url: string
  api_key: string
  model_id?: string
  /** api_key 为空时回退到已保存渠道的密钥（编辑表单不改 Key 时使用） */
  channel_id?: string
}

export interface ChannelTestDirectEnvelope extends RequestEnvelope {
  input: ChannelDirectTestInput
}

/** 拉取模型列表（无需已保存渠道，明文凭证） */
export interface FetchModelsInput {
  provider_type: ProviderType
  base_url: string
  api_key: string
  /** api_key 为空时回退到已保存渠道的密钥（编辑表单不改 Key 时使用） */
  channel_id?: string
}

export interface FetchModelsEnvelope extends RequestEnvelope {
  input: FetchModelsInput
}

export interface FetchModelsResult {
  success: boolean
  message: string
  models: ChannelModel[]
}

export interface ChannelDeleteEnvelope extends RequestEnvelope {
  channel_id: string
}

export interface ChannelDeleteResult {
  deleted: true
  channel_id: string
}

// =========================================================================
// 4.1 渠道 provider 常量（renderer UI 与 main 共用）
// =========================================================================

/** 各 provider 的默认 Base URL（空串表示必须由用户显式填写） */
export const PROVIDER_DEFAULT_URLS: Record<ProviderType, string> = {
  anthropic: 'https://api.anthropic.com',
  'anthropic-compatible': '',
  openai: 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/anthropic',
  google: 'https://generativelanguage.googleapis.com',
  'kimi-api': 'https://api.moonshot.cn/anthropic',
  'kimi-coding': 'https://api.kimi.com/coding/v1',
  'opencode-go-openai': 'https://opencode.ai/zen/go/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  'zhipu-coding': 'https://open.bigmodel.cn/api/anthropic',
  'zhipu-coding-team': 'https://open.bigmodel.cn/api/anthropic',
  'ark-coding-plan': 'https://ark.cn-beijing.volces.com/api/plan',
  minimax: 'https://api.minimaxi.com/anthropic',
  doubao: 'https://ark.cn-beijing.volces.com/api/v3',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'qwen-anthropic': 'https://dashscope.aliyuncs.com/apps/anthropic',
  'qwen-token-plan': 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1/messages',
  xiaomi: 'https://api.xiaomimimo.com/anthropic',
  'xiaomi-token-plan': 'https://token-plan-cn.xiaomimimo.com/anthropic',
  custom: '',
}

/** 各 provider 的显示名称（面向用户） */
export const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic',
  'anthropic-compatible': 'Anthropic 兼容格式',
  openai: 'OpenAI',
  'openai-responses': 'OpenAI Responses 格式',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kimi-api': 'Kimi API (Anthropic 协议)',
  'kimi-coding': 'Kimi Coding Plan',
  'opencode-go-openai': 'OpenCode Go (OpenAI 协议)',
  zhipu: '智谱 AI',
  'zhipu-coding': '智谱 Coding Plan',
  'zhipu-coding-team': '智谱 Coding Plan 团队版',
  'ark-coding-plan': '火山方舟 Coding Plan',
  minimax: 'MiniMax (API&编程包)',
  doubao: '豆包',
  qwen: '通义千问',
  'qwen-anthropic': '通义千问 (Anthropic 协议)',
  'qwen-token-plan': '通义千问 Token Plan',
  xiaomi: '小米 MiMo (API)',
  'xiaomi-token-plan': '小米 MiMo Token Plan',
  custom: 'OpenAI Chat Completions（自定义地址）',
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
// 6.5 会话历史（历史对话管理）
// =========================================================================

/** Agent 会话索引记录（对齐 data-model §5 Session 实体，后端持久化） */
export interface AgentSessionRecord {
  session_id: string
  project_id: string
  summary?: string
  status: 'active' | 'waiting_for_user' | 'completed'
  jsonl_path: string
  created_at: string
  updated_at: string
}

export interface AgentListSessionsInput extends RequestEnvelope {
  /** 按项目过滤；缺省返回全部会话 */
  project_id?: string
}

export interface AgentListSessionsResult {
  sessions: AgentSessionRecord[]
}

export interface AgentLoadMessagesInput extends RequestEnvelope {
  session_id: string
  /** 返回最近 N 条消息（尾部截取），缺省 200 */
  limit?: number
  /** 排除内部终态标记（[terminal] 行），缺省 true */
  exclude_terminal?: boolean
}

export interface AgentLoadMessagesResult {
  session: AgentSessionRecord
  messages: AgentMessage[]
  total: number
  truncated: boolean
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
  /** 最后活跃会话 ID，用于启动恢复时续接上下文 */
  last_session_id?: string
  /** 自动修复计数（component-design §7）：runtime 与 test 各 ≤3，成功归零 */
  runtime_repair_count?: number
  test_repair_count?: number
  /** 裁判退回计数（A2-11）：quick=2 / longterm=3，达上限让渡 */
  judge_return_count?: number
  /** 安全问题独立计数（PRD §10.5）：上限 3 次强制修复，不计入普通退回次数 */
  security_repair_count?: number
  /** 被阻塞的编程操作（A2 resume 闭环）：非阻塞态为 undefined */
  blocked_action?: 'mvp_repair' | 'test_repair' | 'judge_return'
  created_at: string
  updated_at: string
}

export interface ConfirmSketchInput extends RequestEnvelope {
  project_id: string
  session_id: string
  snapshot_id: string
  decision: 'accepted' | 'needs_change'
  note?: string
  channel_id?: string
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

export interface ProjectArchiveInput extends RequestEnvelope {
  project_id: string
}

/** 取消归档：archived → active（对齐 Proma archived toggle） */
export interface ProjectUnarchiveInput extends RequestEnvelope {
  project_id: string
}

/** 硬删除项目：清理索引条目 + 项目/文档/快照/事件文件 + 关联会话 */
export interface ProjectDeleteInput extends RequestEnvelope {
  project_id: string
}

/** 历史项目列表视角：active（默认，过滤归档）/ archived / all */
export interface ProjectListInput extends RequestEnvelope {
  scope?: 'active' | 'archived' | 'all'
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

export interface SnapshotListInput extends RequestEnvelope {
  project_id: string
}

export interface SnapshotListResult {
  snapshots: Snapshot[]
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
    listSessions(input: AgentListSessionsInput): Promise<ApiResult<AgentListSessionsResult>>
    loadMessages(input: AgentLoadMessagesInput): Promise<ApiResult<AgentLoadMessagesResult>>
    onStreamEvent(listener: (event: AgentEvent) => void): () => void
  }
  permissions: {
    respond(input: PermissionResponseInput): Promise<ApiResult<PermissionResponseResult>>
  }
  project: {
    create(input: ProjectCreateInput): Promise<ApiResult<Project>>
    list(input: ProjectListInput): Promise<ApiResult<Project[]>>
    archive(input: ProjectArchiveInput): Promise<ApiResult<Project>>
    unarchive(input: ProjectUnarchiveInput): Promise<ApiResult<Project>>
    delete(input: ProjectDeleteInput): Promise<ApiResult<{ deleted: true }>>
    confirmSketch(input: ConfirmSketchInput): Promise<ApiResult<Project>>
    submitCorrection(input: PointCorrectionInput): Promise<ApiResult<RevisionAccepted>>
    upgrade(input: ProjectUpgradeInput): Promise<ApiResult<Project>>
  }
  sandbox: {
    run(input: SandboxRunInput): Promise<ApiResult<SandboxRunResult>>
    stop(input: SandboxStopInput): Promise<ApiResult<SandboxStopResult>>
    restore(input: SandboxRunInput): Promise<ApiResult<SandboxRunResult>>
  }
  snapshots: {
    create(input: SnapshotCreateInput): Promise<ApiResult<Snapshot>>
    rollback(input: SnapshotRollbackInput): Promise<ApiResult<RollbackResult>>
    list(input: SnapshotListInput): Promise<ApiResult<SnapshotListResult>>
  }
  documents: {
    sync(input: DocumentSyncInput): Promise<ApiResult<DocumentSyncResult>>
  }
  analytics: {
    track(input: AnalyticsTrackInput): Promise<ApiResult<AnalyticsTrackResult>>
  }
  channels: {
    list(input: RequestEnvelope): Promise<ApiResult<Channel[]>>
    create(input: ChannelCreateEnvelope): Promise<ApiResult<Channel>>
    update(input: ChannelUpdateEnvelope): Promise<ApiResult<Channel>>
    test(input: ChannelTestEnvelope): Promise<ApiResult<ChannelTestResult>>
    testDirect(input: ChannelTestDirectEnvelope): Promise<ApiResult<ChannelTestResult>>
    fetchModels(input: FetchModelsEnvelope): Promise<ApiResult<FetchModelsResult>>
    delete(input: ChannelDeleteEnvelope): Promise<ApiResult<ChannelDeleteResult>>
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

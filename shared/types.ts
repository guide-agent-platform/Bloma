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
  /** 运行中转向（P0-1 steer，2026-09-08）：活跃主 loop 期间输入框改道本通道，批间注入 */
  AGENT_STEER_MESSAGE: 'agent:steer-message',
  /** I3 转向生效确认链（P7-7，2026-09-11）：中/高档影响卡三选回执 */
  AGENT_STEER_RESOLVE: 'agent:steer-resolve',
  /** I3：会话 steer 状态查询（渲染端刷新后状态条恢复） */
  AGENT_STEER_QUERY: 'agent:steer-query',
  /** 会话 fork（P0-2，2026-09-08）：从任意 user 消息重开，复制前缀到新会话 */
  AGENT_FORK_SESSION: 'agent:fork-session',
  PASTED_IMAGE_SAVE: 'pasted-image:save',
  AGENT_STOP: 'agent:stop',
  AGENT_LIST_SESSIONS: 'agent:list-sessions',
  AGENT_LOAD_MESSAGES: 'agent:load-messages',
  AGENT_CONFIRM_REQUIREMENTS: 'agent:confirm-requirements',
  SESSION_CLEAN_ORPHANS: 'session:clean-orphans',
  AGENT_STREAM_EVENT: 'agent:stream-event',
  PERMISSION_RESPONSE: 'permission:response',
  PERMISSION_SET_MODE: 'permission:set-mode',
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_CONFIRM_SKETCH: 'project:confirm-sketch',
  PROJECT_SUBMIT_CORRECTION: 'project:submit-correction',
  PROJECT_ARCHIVE: 'project:archive',
  PROJECT_UNARCHIVE: 'project:unarchive',
  PROJECT_DELETE: 'project:delete',
  PROJECT_UPGRADE: 'project:upgrade',
  PROJECT_FINALIZE: 'project:finalize',
  PROJECT_EXPORT: 'project:export',
  PROJECT_RENAME: 'project:rename',
  PROJECT_UPGRADE_EXPORT: 'project:upgrade-export',
  APP_SWITCH_STATE: 'app:switch-state',
  PROJECT_ABANDON: 'project:abandon',
  PROJECT_REOPEN: 'project:reopen',
  SANDBOX_RUN: 'sandbox:run',
  SANDBOX_STOP: 'sandbox:stop',
  SANDBOX_RESTORE: 'sandbox:restore',
  SNAPSHOT_CREATE: 'snapshot:create',
  SNAPSHOT_ROLLBACK: 'snapshot:rollback',
  SNAPSHOT_LIST: 'snapshot:list',
  SNAPSHOT_SCREENSHOT: 'snapshot:screenshot',
  SNAPSHOT_DOCUMENT_LIST: 'snapshot:document-list',
  SNAPSHOT_DOCUMENT_READ: 'snapshot:document-read',
  DOCUMENT_SYNC: 'document:sync',
  DOCUMENT_LIST: 'document:list',
  DOCUMENT_READ: 'document:read',
  DOM_COLLECT_CONTEXT: 'dom:collect-context',
  DOM_SCROLL_PREVIEW: 'dom:scroll-preview',
  ANALYTICS_TRACK: 'analytics:track',
  CHANNEL_LIST: 'channel:list',
  CHANNEL_CREATE: 'channel:create',
  CHANNEL_UPDATE: 'channel:update',
  CHANNEL_TEST: 'channel:test',
  CHANNEL_TEST_DIRECT: 'channel:test-direct',
  CHANNEL_FETCH_MODELS: 'channel:fetch-models',
  CHANNEL_DELETE: 'channel:delete',
  CATEGORY_ROUTING_LIST: 'category-routing:list',
  CATEGORY_ROUTING_UPDATE: 'category-routing:update',
  CATEGORY_ROUTING_ROLE_LIST: 'category-routing:role-list',
  CATEGORY_ROUTING_ROLE_UPDATE: 'category-routing:role-update',
  PROMPT_LIST: 'prompt:list',
  PROMPT_READ: 'prompt:read',
  PROMPT_SAVE: 'prompt:save',
  PROMPT_RESET: 'prompt:reset',
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
  | 'AGENT_PROJECT_BUSY'
  | 'AGENT_SDK_ERROR'
  | 'AGENT_SDK_TIMEOUT'
  | 'AGENT_CANCELLED'
  | 'CHANNEL_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  /** P0-2 fork：源会话找不到目标锚点 / 锚点非 user 文本消息（缺 entry_id+entry_timestamp 也归此码） */
  | 'SESSION_FORK_ENTRY_NOT_FOUND'
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

export type SnapshotKind = 'sketch' | 'mvp' | 'iteration' | 'pre_risk' | 'upgrade' | 'rollback_guard' | 'restored'
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
export type TemplateType = 'web_fullstack' | 'desktop_tool' | 'personal_tool' | 'game' | 'ai_app'
/** 硬约束等级（PRD 12.4 三档；严格=二期）。与 TemplateType 正交（方案 §二维度二/三）。 */
export type ConstraintLevel = 'loose' | 'standard' | 'strict'
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
  /** Agent Loop 能力位：显式 false = 已知不支持 tool use（分流直接回退管道）；
   *  true / 缺省 = 允许走 loop（缺省时首用可探测，探测失败回退并落决策日志）。 */
  supports_tools?: boolean
  /** 编辑格式能力位（Aider 结论：弱渠道用 diff 编辑不可靠）：
   *  diff = old_string/new_string 精确替换（默认）；whole = 整文件重写。 */
  edit_format?: 'diff' | 'whole'
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
// 4.2 提示词配置（引擎 system prompt 外置覆盖，界面化配置）
// 覆盖文件位于 {PROMA_HOME}/prompts/{id}.md，存在即全量替换内置默认（见 main/prompt-config.ts）。
// =========================================================================

/** 提示词槽位 ID：六槽位全部接线 loadPromptOverride（prd/sketch/mvp/guide/enricher/normalizer）。 */
export type PromptSlotId = 'prd-system' | 'sketch-system' | 'guide-system' | 'enricher-system' | 'normalizer-system' | 'loop-system'

/** 槽位列表项（设置页左侧列表） */
export interface PromptSlotInfo {
  id: PromptSlotId
  /** 用户可读名称，如「PRD 需求提炼提示词」 */
  label: string
  description: string
  /** 是否已接入 override 机制（false = 预留槽位，暂不可编辑） */
  enabled: boolean
  /** 是否存在自定义覆盖文件 */
  has_override: boolean
}

/** 槽位详情（设置页编辑器加载当前生效内容） */
export interface PromptSlotDetail extends PromptSlotInfo {
  /** 当前生效的提示词全文：有覆盖 = 覆盖内容；无覆盖 = 内置默认；未启用槽位为空串 */
  content: string
}

export interface PromptReadInput extends RequestEnvelope {
  prompt_id: PromptSlotId
}

export interface PromptSaveInput extends RequestEnvelope {
  prompt_id: PromptSlotId
  /** 覆盖文件全文；空白内容拒绝保存（VALIDATION_ERROR） */
  content: string
}

export interface PromptResetInput extends RequestEnvelope {
  prompt_id: PromptSlotId
}

export interface PromptSaveResult {
  saved: true
  prompt_id: PromptSlotId
}

export interface PromptResetResult {
  reset: true
  prompt_id: PromptSlotId
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

/**
 * 走 Anthropic Messages 协议的 provider（M5 单一真相源，main 校验与 renderer 下拉共用）。
 * Bloma 运行时查询固定请求 `${baseUrl}/v1/messages`，OpenAI 协议渠道（zhipu/doubao/
 * qwen/openai/custom 等）会 404——类别路由与渠道下拉均须过滤。
 */
export const ANTHROPIC_PROTOCOL_PROVIDERS: readonly ProviderType[] = [
  'anthropic',
  'anthropic-compatible',
  'deepseek',
  'minimax',
  'xiaomi',
  'xiaomi-token-plan',
  'qwen-anthropic',
  'qwen-token-plan',
  'zhipu-coding',
  'zhipu-coding-team',
  'ark-coding-plan',
  'kimi-api',
  'kimi-coding',
]

/** 判定 provider 是否走 Anthropic Messages 协议（M5：路由保存校验/解析复核/下拉过滤）。 */
export function isAnthropicProtocolProvider(provider: ProviderType): boolean {
  return ANTHROPIC_PROTOCOL_PROVIDERS.includes(provider)
}

// =========================================================================
// 4.2 文档类别与类别路由（M4 类别→模型 / M5 类别→渠道）
// =========================================================================

/**
 * 文档类别（M4）：代码里写类别不写模型名，由 main/model-resolution 单点解析到模型。
 * M5 起迁移至 shared（renderer 设置页与 main 路由共用）；main 侧 re-export 保持兼容。
 * 注：gwt 不参与渠道路由（走浏览器探针/静态启发式，从不解析 LLM 渠道）。
 */
export type DocumentCategory = 'guide' | 'prd' | 'sketch' | 'mvp' | 'gwt' | 'judge' | 'audit' | 'summary'

/** M5 类别路由条目（~/.proma/category-routing.json，snake_case）。 */
export interface CategoryRoutingEntry {
  /** 该类别固定渠道；缺省 = 全局自动 */
  channel_id?: string
  /** 基础设施故障时的备用渠道优先顺序；未设置 = 沿用 T9「任意 enabled 渠道」 */
  fallback_channel_ids?: string[]
}

/** 用户可配置的三类 Agent 角色；gwt 由浏览器探针执行，不属于 LLM 渠道角色。 */
export type AgentRoutingRole = 'guide' | 'programming' | 'judge'

/** 角色到运行时文档类别的固定聚合映射（设置层与测试共用）。audit（内审，2026-09-01
 *  决议 4/7）是裁判角色的附属类别：允许与 judge 主渠道不同渠道（厂商隔离），
 *  保存展开时缺省随 judge 主渠道、可显式指定 audit_channel_id 覆盖。 */
export const AGENT_ROLE_CATEGORIES: Record<AgentRoutingRole, readonly DocumentCategory[]> = {
  guide: ['guide', 'prd', 'summary'],
  programming: ['sketch', 'mvp'],
  judge: ['judge', 'audit'],
}

export const AGENT_ROUTING_ROLES: readonly AgentRoutingRole[] = ['guide', 'programming', 'judge']

export interface CategoryRoutingRoleView {
  role: AgentRoutingRole
  label: string
  description: string
  categories: DocumentCategory[]
  channel_id?: string
  fallback_channel_ids?: string[]
  channel_name?: string
  model_name?: string
  effective: 'routed' | 'auto' | 'dangling' | 'mixed'
  /** 裁判角色专属（2026-09 内审闭环）：内审（audit）类别的渠道子视图。
   *  audit 允许与 judge 主渠道不同（厂商隔离需要）；缺省同主渠道。 */
  audit?: {
    channel_id?: string
    fallback_channel_ids?: string[]
    channel_name?: string
    model_name?: string
    effective: 'routed' | 'auto' | 'dangling'
  }
}

export interface CategoryRoutingRoleListResult {
  version: number
  views: CategoryRoutingRoleView[]
}

/** 角色保存条目（2026-09 内审闭环）：在类别条目之上允许为裁判角色显式指定内审渠道。
 *  audit_channel_id 缺省 = 随 channel_id 展开（向后兼容：老 payload 行为不变）。 */
export interface RoleRoutingEntry extends CategoryRoutingEntry {
  /** 仅 judge 角色：内审（audit）类别渠道；不传则同 channel_id */
  audit_channel_id?: string
  audit_fallback_channel_ids?: string[]
}

export interface CategoryRoutingRoleUpdateEnvelope extends RequestEnvelope {
  routing: Partial<Record<AgentRoutingRole, RoleRoutingEntry>>
}

export type CategoryRoutingConfig = Partial<Record<DocumentCategory, CategoryRoutingEntry>>

export interface CategoryRoutingFile {
  version: 1
  routing: CategoryRoutingConfig
}

/** 设置页「职责分工」单行视图模型（不含明文 key，供 UI 直接渲染）。 */
export interface CategoryRoutingView {
  category: DocumentCategory
  /** 中文职责名（与 M5 设计 §1 映射表逐字一致） */
  label: string
  /** 配置值；dangling 态仍保留原配置值用于展示 */
  channel_id?: string
  /** 配置的备用渠道顺序；dangling 态保留原配置值供展示/编辑 */
  fallback_channel_ids?: string[]
  /** 当前解析到的渠道名（routed=路由渠道；auto/dangling=生效的全局默认渠道） */
  channel_name?: string
  /** M4 在该渠道解析到的模型名（预览；auto/dangling 为全局默认渠道解析结果） */
  model_name?: string
  /** routed=命中路由；auto=全局默认（含禁用渠道生效期）；dangling=已删除渠道 */
  effective: 'routed' | 'auto' | 'dangling'
}

export interface CategoryRoutingListResult {
  version: number
  views: CategoryRoutingView[]
}

export interface CategoryRoutingUpdateEnvelope extends RequestEnvelope {
  routing: CategoryRoutingConfig
}

// =========================================================================
// 5. Agent 核心类型
// =========================================================================

export interface MessageContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  /** tool_result 专用：true 表示该工具执行失败/被拒，模型据此自纠 */
  is_error?: boolean
  /** image 块专用：短引用 pasted-images/<sessionId>/<uuid>.<ext>——JSONL/内存只落此 id 不落 base64 */
  imageId?: string
  /** image 块专用：image/png | image/jpeg | image/gif | image/webp */
  media_type?: string
  /** image 块水合产物（Anthropic base64 source）：只在 anthropicMessagesQuery 请求体出现，
   *  禁止写入 JSONL 或回传 renderer（契约测试 S4-AGENT-091/095 锁定） */
  source?: { type: 'base64'; media_type: string; data: string }
}

/** 粘贴图片引用（AgentSendMessageInput.images / ChatPanel 发送第二参） */
export interface PastedImageRef {
  imageId: string
  media_type: string
}

/** 粘贴图存盘 IPC 输入：base64 载荷（无 dataURL 前缀）+ 扩展名（png/jpeg/gif/webp） */
export interface PastedImageSaveInput extends RequestEnvelope {
  session_id: string
  base64: string
  ext: string
}

export interface PastedImageSaveResult {
  imageId: string
  media_type: string
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
  /** message_delta 的 stop_reason（'tool_use' = 模型要求继续工具循环；Agent Loop 据此判定续轮） */
  stop_reason?: string
  /** 渠道返回的用量（message_start/message_delta 的 usage 聚合；Agent Loop 逐轮埋点用） */
  usage?: { input_tokens?: number; output_tokens?: number }
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

/** 需求确认弹窗决策回传（confirm_requirements 流，2026-08-26）：confirm=勾选子集开工，delegate=用户让渡由向导定。 */
export interface AgentConfirmRequirementsInput extends RequestEnvelope {
  session_id: string
  project_id: string
  decision: 'confirm' | 'delegate'
  /** confirm 时勾选的需求 id 子集；空集/缺省视为全量（兑底防误操作全清空） */
  requirement_ids?: string[]
  /** confirm 时勾选采纳的市调想法（label 原文，2026-08-29 灵感参考改造）：并入需求清单追加 F-00N */
  adopted_ideas?: string[]
  /** 可选参考网页链接（web-reference-extractor，2026-08-28）：仅 http(s)，提取失败静默降级 */
  reference_url?: string
}

/** 市调提炼想法（2026-08-29 灵感参考改造）：向导把搜索结果提炼成可勾选采纳的「市面上的做法」。 */
export interface ResearchIdea {
  /** 想法短句（≤20 字，如「虚拟键盘实时弹奏」） */
  label: string
  /** 一句说明（≤40 字，来自搜索结果的要点） */
  note: string
  /** 来源域名（展示用，如 example.com） */
  source: string
}

export interface AgentConfirmRequirementsResult {
  started: boolean
  prd_written: boolean
}

export interface AgentSendMessageInput extends RequestEnvelope {
  session_id: string
  project_id: string
  content: string
  mode: ProjectMode
  current_stage: WorkflowStage
  channel_id?: string
  /** 剪贴板粘贴图片引用（clipboard-paste P1，2026-08-29）：随消息一同进模型与 JSONL */
  images?: PastedImageRef[]
  metadata?: {
    source: 'chat' | 'card_option' | 'system_resume'
    selected_option_id?: string
    /** PRD 确认卡 confirm 时勾选采纳的市调想法（2026-08-29 灵感参考，四段式卡同样可采纳） */
    adopted_ideas?: string[]
    /** 裁判审查逐题选择题的答案（2026-08-30）：弹窗一次性回传，每题 issue_id/option_id/label */
    review_answers?: Array<{ issue_id: string; option_id: string; label: string }>
  }
}

export interface AgentSendMessageResult {
  accepted: true
  session_id: string
  stream_started: boolean
  /** message-queue（2026-08-27）：true = 会话忙，消息已入队待 run 完成后自动派发 */
  queued?: boolean
}

/**
 * 运行中转向入参（P0-1 steer，2026-09-08 pi 差距方案 §1）：**形态复用 AgentSendMessageInput**
 * （ipc 层走 validateAgentSend 同一清洗口径，无第二套校验）。语义差异：
 * - 会话有活跃主 loop（delegationDepth 0 的 runAgentLoop）→ 入 steer 队列，工具批间注入
 *   （内容以 `【用户中途补充】` 包裹，模型可识别优先级）；
 * - 无活跃主 loop（空闲 / guide 单发 run / 后台间隙）→ 主进程内部回退 runAgent，
 *   与 agent:send-message 行为完全一致（忙则入 SessionMessageQueue、空闲则开新 run）。
 */
export type AgentSteerMessageInput = AgentSendMessageInput

/** I3 转向生效确认链（P7-7，2026-09-11，实施稿 §3）：steer 影响档位。
 * v0 确定性关键词分级，**宁低勿高**——低档=简短确认即注入（与现状行为一致，误判代价最小）；
 * 中档=新功能/改流程（影响卡三选）；高档=核心目标/数据模型转向（v0 建议「停止本轮」承接）。 */
export type SteerImpact = 'low' | 'medium' | 'high'

/** I3 状态机：received（已入队待注入）→ pending_impact（中/高档待用户确认）
 * → merged_this_run（注入完成事件推进——不由对话层单方面宣布）
 * | deferred_next_run（留待下一轮，形成可见待办）| rejected（未采用：用户选不改了/本轮停止）。 */
export type SteerStatus = 'received' | 'pending_impact' | 'merged_this_run' | 'deferred_next_run' | 'rejected'

export interface AgentSteerMessageResult {
  session_id: string
  /** true = 已入 steer 队列，当前主 loop 下一批间注入；回执气泡由 steer_injected 事件承担 */
  steered: boolean
  /** 队列中待注入条数（含本次；仅 steered=true 时有意义） */
  pending?: number
  /** steered=false：主进程已回退 runAgent，本字段为 send-message 语义结果（含 queued） */
  fallback?: AgentSendMessageResult
  /** I3（仅 BLOMA_STEER_CONFIRM=on 时返回）：本次 steer 状态与档位。后续状态由
   *  steer_status 事件驱动（低档 received→注入后 merged；中/高档 pending_impact 等三选）。 */
  status?: SteerStatus
  impact?: SteerImpact
  steer_id?: string
}

/** I3：影响卡三选回执（中档 [本轮就改/本轮完成后再改/不改了]；高档 [仍要本轮注入] 同通道）。 */
export interface AgentSteerResolveInput extends RequestEnvelope {
  session_id: string
  steer_id: string
  /** inject_now=本轮就改（入队注入）；defer=本轮完成后再改（可见待办）；reject=不改了 */
  action: 'inject_now' | 'defer' | 'reject'
}

export interface AgentSteerResolveResult {
  session_id: string
  steer_id: string
  status: SteerStatus
}

/** I3：会话 steer 状态查询（渲染端刷新后恢复状态条）。 */
export interface AgentSteerQueryInput extends RequestEnvelope {
  session_id: string
}

/** 主进程账本条目镜像（steer-queue.ts SteerLedgerEntry 的传输形态）。 */
export interface SteerStatusItem {
  steer_id: string
  content: string
  impact: SteerImpact
  status: SteerStatus
  /** 状态最后推进时间（epoch ms） */
  updated_at: number
}

export interface AgentSteerQueryResult {
  session_id: string
  items: SteerStatusItem[]
}

/**
 * 会话 fork 入参（P0-2，2026-09-08 pi 差距方案 §2）：从源会话的某条 user 消息处重开——
 * 把「首行到该消息」的前缀复制进新会话文件，原会话一字不动。
 * 锚点解析：v2 文件优先 entry_id（行 id）；旧文件无 id 时按 entry_timestamp 定位。
 */
export interface AgentForkSessionInput extends RequestEnvelope {
  session_id: string
  project_id: string
  /** v2 行 id（8 位 hex）；缺省时用 entry_timestamp */
  entry_id?: string
  /** 目标 user 消息的落盘 timestamp（ms）；至少与 entry_id 二选一 */
  entry_timestamp?: number
}

export interface AgentForkSessionResult {
  /** fork 出的新会话 id（调用方续接会话时使用） */
  new_session_id: string
  forked: true
  /** 复制进新会话的消息条数 */
  copied_messages: number
}

export interface AgentCancelInput extends RequestEnvelope {
  session_id: string
  /** 可选 project_id：同项目不同会话切换/停止时一并中止全部顶层运行。旧客户端只传 session_id 仍兼容。 */
  project_id?: string
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
  /** delegation-persistence 阶段 1（2026-08-28）：委派子会话归属——重启后按 delegationId 找回 */
  parent_session_id?: string
  source_delegation_id?: string
  /** P0-2 fork（2026-09-08）：本会话由哪个会话的哪条消息 fork 而来（源文件一字不动） */
  fork_entry_id?: string
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

/** U11：清理孤儿会话的结果——被移除的会话数量（无孤儿时 removed=0）。 */
export interface SessionCleanOrphansResult {
  removed: number
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

/** 权限模式切换：在设置页把 safe / ask / allow-all 同步到主进程 enforcement。 */
export interface PermissionSetModeInput extends RequestEnvelope {
  mode: PromaPermissionMode
}

export interface PermissionSetModeResult {
  mode: PromaPermissionMode
}

// =========================================================================
// 8. Agent 流式事件
// =========================================================================

/** Agent Loop 结束状态（loop-aware judge M4-B 用；与 main/agent-loop 的 AgentLoopResult.status 同构）。 */
export type AgentLoopStatus = 'completed' | 'turn_limit' | 'budget_exhausted' | 'cancelled'

/** W2-F4（咨询 D2/D4，2026-09-09）：loop 自验状态的宿主快照——终验失败 source 五分类的
 *  确定性判据（loop 是否自测过/上次失败集/验证面是否全过）。由 attachUsage 从工具状态拼装，
 *  纯增量字段，旧调用方零感知。 */
/** P2a（2026-09-11）：loop 异常终止真实出口原因（纯增量观测字段，不改 status 语义）。 */
export interface LoopTerminationDetail {
  reason: 'degenerate_output'
  /** 传输事故反馈重试次数（DEGENERATE_RETRY_LIMIT 内） */
  retries: number
}

export interface LoopValidationSnapshot {
  /** run_gwt_tests 执行次数（0=loop 从未自测） */
  gwt_runs: number
  /** run_api_contract_tests 执行次数（0=loop 从未验过 API 契约） */
  api_contract_runs: number
  /** 上一次 run_gwt_tests 的失败场景名集合（全过重置为空） */
  last_gwt_failures: string[]
  gwt_all_passed: boolean
  api_all_passed: boolean
  security_all_passed: boolean
  /** W3 收口预检结果（BLOMA_PREFLIGHT 跑过才带；Phase 7 U1 H1 delivery_status 消费：false=有未过验证面，从严不称 verified） */
  preflight_passed?: boolean
  /** 已读文件版本戳（path→rev，W2-F1 证据包/候选指纹原料）；未启用版本戳功能时为空对象 */
  file_revisions: Record<string, string>
}

/** JudgeInput 的 loop 元数据（M4-B）：judge 对 loop 异常终止态判「不达标/让渡」，不信模型自述。 */
export interface AgentLoopJudgeMetadata {
  status: AgentLoopStatus
  turns: number
  finalText: string
  toolCalls: Array<{ name: string; turn: number }>
  /** W2-F4：自验状态快照（终验 source 分类用）；存量/重建路径缺省无 */
  validation?: LoopValidationSnapshot
  /** P2a（2026-09-11 狗粮 94f449c6）：异常终止的真实出口原因——status 语义不变
 *  （终验/裁判照旧），degenerate_output = 末轮输出退化（DSML/协议原文漏进正文），
 *  与「真实跑满轮数」区分，防 turn_limit 标签误导归因与用户话术。 */
  termination_detail?: LoopTerminationDetail
}

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
    /** 权限模式切换广播（F8）：主进程 setMode 成功后同步渲染端 atom，payload.mode 为新模式 */
    | 'permission_mode_changed'
    /** 委派子 agent 冒泡提问（M3）：payload.delegation_id / child_session_id / role / question */
    | 'delegation_question'
    /** 委派生命周期（M4-C）：payload 含 delegation_id / child_session_id / role / goal / status */
    | 'delegation_started'
    | 'delegation_completed'
    | 'delegation_failed'
    | 'delegation_cancelled'
    /** usage 竹节压缩（闭环 PR6）：payload 含 at_turn / input_tokens / compactions；messages 已重置为 task+交接文档 */
    | 'loop_compaction'
    /** 排队消息开始派发（message-queue 2026-08-27）：payload.queue_message_id；渲染端把「已排队」气泡翻转 */
    | 'queued_started'
    /** 排队消息派发失败（onDropped 气泡，r79）：payload.queue_message_id / reason；渲染端红泡告知 */
    | 'queue_dropped'
    /** 运行中转向已注入（P0-1 steer，2026-09-08）：payload 含 content（原文）/ message（包裹后全文）
     *  / at_turn（注入所在轮）/ remaining（队列余量）；渲染端回执气泡对齐 queue_dropped 模式。
     *  I3（P7-7，仅 BLOMA_STEER_CONFIRM=on）：payload 追加 steer_id / status='merged_this_run'
     *  ——注入完成是状态推进到 merged 的唯一事实源（off 时 payload 字节不变）。 */
    | 'steer_injected'
    /** I3 转向生效确认链（P7-7，仅 on 时发）：steer 状态每次变化推送；payload 含
     *  steer_id / content / impact / status / at。渲染端聊天流内嵌轻量状态条由此驱动。 */
    | 'steer_status'
    /** 会话用量汇总（usage-guard 渲染层 2026-08-28）：loop 结束发布，渲染端显示透明条 */
    | 'usage_summary'
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
  blocked_action?: 'mvp_repair' | 'test_repair' | 'judge_return' | 'security_repair'
  /** 需求确认后已自动命名过（autoNameProject）：此后不再覆盖，保住用户手动改名 */
  auto_named?: boolean
  /** 最近一次草图的生成来源（§4.2 质量门：仅 'llm' 草图可升格 UX 契约） */
  sketch_source?: 'llm' | 'template'
  /** 最近一次草图生成时间（ux_contract 刷新判定：确认晚于生成才登记新草图） */
  sketch_generated_at?: string
  /** normalizer 判定的范围声明（「不要 X」），buildPrdBackplane 时并入 out_of_scope */
  scope_exclusions?: string[]
  /** 用户声明过的约束（T4-L1：「不含登录」「必须离线可用」），buildPrdBackplane 时并入 constraints 常驻注入 */
  constraints?: string[]
  /** U16：最近进展摘要（取自最近一次 sketch_generated 需求，列表卡片纯展示用，不经落盘） */
  progress_summary?: string
  /** 最近一次 MVP 生成是否走 Agent Loop（M4-A：resume 时据此选「只终验不重修」路径） */
  via_agent_loop?: boolean
  /** 最近一次 Agent Loop 的结束状态（M4-B：judge loop-aware 读；resume 时透传给终验） */
  agent_loop_status?: AgentLoopStatus
  /**
   * 交付状态（Phase 7 U1 H1，2026-09-10）：这一版实际验证到什么程度的三态结论。
   * 只由终验链路规则函数计算写入（main/coding/delivery-status.ts），Agent/loop 工具面
   * 无写入口；每次终验重算——旧版本通过不给新版本背书。BLOMA_DELIVERY_STATUS
   * 缺省 off=不计算不写入（project 无此键，字节级现状）。
   */
  delivery_status?: DeliveryStatus
  created_at: string
  updated_at: string
}

/** 交付状态三态（Phase 7 U1 H1，规则见 main/coding/delivery-status.ts）。 */
export type DeliveryStatus = 'verified' | 'partial' | 'unavailable'

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
  /** 同一区域连续纠错计数（含本次，1-based）；用于 R-CORR-07 重复纠错追问 */
  repeat_count?: number
  /** 本次提交前同一区域已被连续纠错的次数；≥2 表示已连续两次纠错过 */
  prior_count?: number
  /** 连续两次已纠错（本次为第三次及以上）→ 向导 Agent 应主动追问，不再盲目自动修改 */
  should_follow_up?: boolean
}

/**
 * U8：点选纠错 DOM 上下文收集。
 * 渲染进程无法直接读取跨域预览 iframe 的 DOM，改由主进程通过
 * subframe.executeJavaScript(document.elementFromPoint) 收集。
 * 对齐 api-spec §12.8 `collect_dom_context`。
 */
export interface DomCollectContextInput extends RequestEnvelope {
  project_id: string
  session_id: string
  /** 点击坐标，相对预览 iframe 左上角（CSS 像素） */
  click: { x: number; y: number }
}

export interface DomCollectContextResult {
  element_selector?: string
  text_content?: string
  bounding_rect: { x: number; y: number; width: number; height: number }
  /** true 表示未能定位到具体元素（回退为纯坐标模式） */
  fallback_mode: boolean
}

/**
 * 点选纠错模式下把滚轮/中键拖拽滚动转发到跨域预览 iframe。
 * 渲染端捕获层盖在 iframe 上方拦截点击，顺带挡住了滚动；主进程经
 * subframe.executeJavaScript(window.scrollBy) 越过同源限制滚动预览。
 */
export interface DomScrollPreviewInput extends RequestEnvelope {
  /** 水平滚动增量（CSS 像素，正值向右） */
  delta_x: number
  /** 垂直滚动增量（CSS 像素，正值向下） */
  delta_y: number
}

export interface DomScrollPreviewResult {
  /** 是否找到预览子帧并执行了滚动（找不到子帧时 false，前端静默忽略） */
  scrolled: boolean
  /** 执行滚动后预览 iframe 的实际水平滚动位置（window.scrollX，CSS 像素） */
  scroll_x: number
  /** 执行滚动后预览 iframe 的实际垂直滚动位置（window.scrollY，CSS 像素） */
  scroll_y: number
}

export interface ProjectUpgradeInput extends RequestEnvelope {
  project_id: string
  session_id: string
}

/** U6：用户满意后「标记为完成」——产品闭环最后一步（PRD §5.1 阶段 3） */
export interface ProjectFinalizeInput extends RequestEnvelope {
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

/** U10：手动导出项目——把生成的项目代码复制到用户选定的目录（PRD §14.2）。 */
export interface ProjectExportInput extends RequestEnvelope {
  project_id: string
}

/**
 * Phase 10 落地旅程（2026-09-16）：升级导出——选旧导出包目录，平台产「新代码+旧数据+
 * 真实迁移+报告」的升级包（W1-6 upgradeExport 的 IPC 化）。主进程弹系统目录选择器
 * 选落地产物，destination=其父目录（<名>-upgraded）。
 */
export interface ProjectUpgradeExportInput extends RequestEnvelope {
  project_id: string
}

export interface ProjectUpgradeExportResult {
  canceled: boolean
  target?: string
  /** ran=迁移已执行 | none=无需迁移 | failed=迁移失败（详见 upgrade-report.json） */
  migration?: 'ran' | 'none' | 'failed'
  summary?: string
  drift?: { changed: number; missing: number; extra: number; clean: boolean }
}

/** Phase 10：实验开关只读面板（渲染端 I5 两口径文案/设置页用；I4 透传待办的窄收口）。 */
export interface AppSwitchStateInput extends RequestEnvelope {}

export interface AppSwitchStateResult {
  switches: Record<string, boolean>
}

/** U13：项目重命名——零基础用户的首个项目名来自首句口述，改名提升列表辨识度。 */
export interface ProjectRenameInput extends RequestEnvelope {
  project_id: string
  name: string
}

/** U15：标记项目为「已放弃」——active → abandoned，让列表状态可主动流转。 */
export interface ProjectAbandonInput extends RequestEnvelope {
  project_id: string
}

/** U15：放弃的项目「恢复进行」——abandoned → active，与归档/取消归档对称。 */
export interface ProjectReopenInput extends RequestEnvelope {
  project_id: string
}

/** U10：导出结果。canceled=true 表示用户在保存对话框取消了操作。 */
export interface ProjectExportResult {
  canceled: boolean
  /** 实际导出目录（已取消时 undefined） */
  destination?: string
  /** 复制的文件数（已取消时 undefined） */
  file_count?: number
}

// =========================================================================
// 10. 沙箱
// =========================================================================

export interface SandboxRunInput extends RequestEnvelope {
  project_id: string
  command?: string
  timeout_ms?: number
  /** 产物 AI 代理环境（完整程序渠道，2026-09-06）：注入产物 static-server 进程的
   * BLOMA_APP_LLM_*（base/key/model/protocol）。密钥只落服务器进程 env，绝不进
   * 前端代码/项目文件；env 签名参与沙箱幂等守卫比对（变化即重启）。 */
  llm_env?: Record<string, string>
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
  /** 恢复指针（Phase 7 U3 I6）：restored 快照指向被恢复的源版本；其余 kind 忽略 */
  derived_from?: string
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
  /** 恢复指针（Phase 7 U3 I6，2026-09-10）：restored 快照指向被恢复的源版本——
   * 「第 N 版·从第 M 版恢复」的指针链；其余 kind 缺省无。 */
  derived_from?: string
  created_at: string
}

export interface SnapshotListInput extends RequestEnvelope {
  project_id: string
}

export interface SnapshotListResult {
  snapshots: Snapshot[]
}

/**
 * U9：快照缩略图。渲染进程受 CSP 约束（img-src 'self' data: blob:）无法直接加载
 * 磁盘上的 file:// 截图，改由主进程读文件转 base64 data URL 回传。
 */
export interface SnapshotScreenshotInput extends RequestEnvelope {
  project_id: string
  snapshot_id: string
}

export interface SnapshotScreenshotResult {
  /** base64 data URL（如 data:image/png;base64,…）；无截图时为 null */
  data_url: string | null
}

/**
 * T7 文档版本化：时间轴回看某快照冻结的文档（「当时的想法」与代码快照对齐）。
 * 存量快照（T7 前归档）无冻结文档——frozen=false 如实提示缺失，不补造。
 */
export interface SnapshotDocumentEntry {
  document_id: string
  type: DocumentRef['type']
  status: DocumentRef['status']
  /** 归档内相对路径（manifest 存的是冻结时的绝对路径，读取按相对 documents 根重锚定，保留 features/ 等子目录） */
  file: string
}

export interface SnapshotDocumentListInput extends RequestEnvelope {
  project_id: string
  snapshot_id: string
}

export interface SnapshotDocumentListResult {
  snapshot_id: string
  /** 该快照冻结时是否归档了文档 */
  frozen: boolean
  documents: SnapshotDocumentEntry[]
}

export interface SnapshotDocumentReadInput extends RequestEnvelope {
  project_id: string
  snapshot_id: string
  document_id: string
}

export interface SnapshotDocumentReadResult {
  snapshot_id: string
  document: SnapshotDocumentEntry
  content: string
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
  /** T7：文档是否随回滚恢复（目标快照无冻结文档时为 false——存量快照如实提示缺失，不补造） */
  documents_restored?: boolean
}

// =========================================================================
// 12. 文档
// =========================================================================

export interface DocumentSyncInput extends RequestEnvelope {
  project_id: string
  session_id: string
  checkpoint: 'requirement_confirmed' | 'sketch_confirmed' | 'mvp_before_generation' | 'mvp_tested' | 'iteration_completed' | 'mode_upgraded'
  changed_files?: string[]
}

export interface DocumentRef {
  document_id: string
  type: 'prd' | 'user_story' | 'plantuml' | 'gwt_feature' | 'test_report' | 'changelog' | 'decisions' | 'plan' | 'loop_log'
  path: string
  status: 'draft' | 'synced' | 'stale' | 'confirmed'
}

export interface DocumentSyncResult {
  documents: DocumentRef[]
  stale_documents: DocumentRef[]
}

/** U2：列出项目已产出的文档（PRD/GWT/测试报告等）。 */
export interface DocumentListInput extends RequestEnvelope {
  project_id: string
}

export interface DocumentListResult {
  documents: DocumentRef[]
}

/** U2：读取单个文档内容。 */
export interface DocumentReadInput extends RequestEnvelope {
  project_id: string
  document_id: string
}

export interface DocumentReadResult {
  document: DocumentRef
  content: string
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
      | 'sketch_fallback'
      | 'mvp_delivered'
      | 'user_undo'
      | 'point_correction'
      | 'mode_upgraded'
      | 'programming_execution'
      | 'self_repair_triggered'
      | 'repair_round_completed'
      | 'agent_loop_turn'
      | 'agent_loop_completed'
      | 'agent_loop_compact'
      | 'test_completed'
      | 'experience_exposure'
      | 'judge_verdict'
      | 'satisfaction_marked'
      | 'project_finalized'
      /** Phase 7 U5 J5（2026-09-10）：北极星地基事件 */
      | 'scope_confirmed'
      | 'delivery_presented'
      /** Phase 7 U5 J5（P7-9b，2026-09-10）：漏斗中层与决策转化事件 */
      | 'clarification_responded'
      | 'decision_selected'
      /** Phase 10 W4（F 系列 4.2 转正，2026-09-16）：报障行为信号——源=一键反馈卡（非意图识别） */
      | 'issue_reported'
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
  app: {
    /** 实验开关只读状态（Phase 10 落地旅程：I5 两口径文案等渲染端消费） */
    switchState(input: AppSwitchStateInput): Promise<ApiResult<AppSwitchStateResult>>
  }
  pastedImage: {
    /** 剪贴板粘贴图存盘（clipboard-paste P1）：base64→{PROMA_HOME}/pasted-images/<sessionId>/，返回短引用 */
    save(input: PastedImageSaveInput): Promise<ApiResult<PastedImageSaveResult>>
  }
  agent: {
    sendMessage(input: AgentSendMessageInput): Promise<ApiResult<AgentSendMessageResult>>
    /** P0-1 steer：活跃主 loop 期间输入框改道；无活跃 loop 时主进程回退 send-message 语义 */
    steerMessage(input: AgentSteerMessageInput): Promise<ApiResult<AgentSteerMessageResult>>
    /** I3 转向确认链：中/高档影响卡三选回执（inject_now/defer/reject） */
    steerResolve(input: AgentSteerResolveInput): Promise<ApiResult<AgentSteerResolveResult>>
    /** I3：会话 steer 状态查询（渲染端刷新后状态条恢复） */
    steerQuery(input: AgentSteerQueryInput): Promise<ApiResult<AgentSteerQueryResult>>
    /** P0-2 fork：从任意 user 消息重开（复制前缀到新会话），返回新会话 id */
    forkSession(input: AgentForkSessionInput): Promise<ApiResult<AgentForkSessionResult>>
    cancel(input: AgentCancelInput): Promise<ApiResult<AgentCancelResult>>
    listSessions(input: AgentListSessionsInput): Promise<ApiResult<AgentListSessionsResult>>
    loadMessages(input: AgentLoadMessagesInput): Promise<ApiResult<AgentLoadMessagesResult>>
    /** U11：清理孤儿会话（project_id 已失效），返回移除数量。 */
    cleanOrphans(input: RequestEnvelope): Promise<ApiResult<SessionCleanOrphansResult>>
    confirmRequirements(input: AgentConfirmRequirementsInput): Promise<ApiResult<AgentConfirmRequirementsResult>>
    onStreamEvent(listener: (event: AgentEvent) => void): () => void
  }
  permissions: {
    respond(input: PermissionResponseInput): Promise<ApiResult<PermissionResponseResult>>
    setMode(input: PermissionSetModeInput): Promise<ApiResult<PermissionSetModeResult>>
  }
  project: {
    create(input: ProjectCreateInput): Promise<ApiResult<Project>>
    list(input: ProjectListInput): Promise<ApiResult<Project[]>>
    archive(input: ProjectArchiveInput): Promise<ApiResult<Project>>
    unarchive(input: ProjectUnarchiveInput): Promise<ApiResult<Project>>
    delete(input: ProjectDeleteInput): Promise<ApiResult<{ deleted: true }>>
    export(input: ProjectExportInput): Promise<ApiResult<ProjectExportResult>>
    /** Phase 10 落地旅程：升级导出（旧导出包→新代码+旧数据+迁移+报告） */
    upgradeExport(input: ProjectUpgradeExportInput): Promise<ApiResult<ProjectUpgradeExportResult>>
    rename(input: ProjectRenameInput): Promise<ApiResult<Project>>
    abandon(input: ProjectAbandonInput): Promise<ApiResult<Project>>
    reopen(input: ProjectReopenInput): Promise<ApiResult<Project>>
    confirmSketch(input: ConfirmSketchInput): Promise<ApiResult<Project>>
    submitCorrection(input: PointCorrectionInput): Promise<ApiResult<RevisionAccepted>>
    upgrade(input: ProjectUpgradeInput): Promise<ApiResult<Project>>
    finalize(input: ProjectFinalizeInput): Promise<ApiResult<Project>>
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
    screenshot(input: SnapshotScreenshotInput): Promise<ApiResult<SnapshotScreenshotResult>>
    documentList(input: SnapshotDocumentListInput): Promise<ApiResult<SnapshotDocumentListResult>>
    documentRead(input: SnapshotDocumentReadInput): Promise<ApiResult<SnapshotDocumentReadResult>>
  }
  documents: {
    sync(input: DocumentSyncInput): Promise<ApiResult<DocumentSyncResult>>
    list(input: DocumentListInput): Promise<ApiResult<DocumentListResult>>
    read(input: DocumentReadInput): Promise<ApiResult<DocumentReadResult>>
  }
  dom: {
    collectContext(input: DomCollectContextInput): Promise<ApiResult<DomCollectContextResult>>
    /** 点选纠错模式下转发滚轮/中键拖拽滚动到跨域预览 iframe */
    scrollPreview(input: DomScrollPreviewInput): Promise<ApiResult<DomScrollPreviewResult>>
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
    /** M5：列出「职责分工」视图模型（类别→渠道路由 + 模型预览）。 */
    categoryRoutingList(input: RequestEnvelope): Promise<ApiResult<CategoryRoutingListResult>>
    /** M5：全量覆盖类别路由表（缺省类别 = 未配置）。 */
    categoryRoutingUpdate(input: CategoryRoutingUpdateEnvelope): Promise<ApiResult<CategoryRoutingListResult>>
    /** 三角色渠道配置：向导 / 编程 / 裁判。 */
    categoryRoutingRoleList(input: RequestEnvelope): Promise<ApiResult<CategoryRoutingRoleListResult>>
    categoryRoutingRoleUpdate(input: CategoryRoutingRoleUpdateEnvelope): Promise<ApiResult<CategoryRoutingRoleListResult>>
  }
  prompts: {
    list(input: RequestEnvelope): Promise<ApiResult<PromptSlotInfo[]>>
    read(input: PromptReadInput): Promise<ApiResult<PromptSlotDetail>>
    save(input: PromptSaveInput): Promise<ApiResult<PromptSaveResult>>
    reset(input: PromptResetInput): Promise<ApiResult<PromptResetResult>>
  }
}

// =========================================================================
// 15. 全局类型声明
// =========================================================================

// ---------------------------------------------------------------------------
// Phase 10 W1-3（2026-09-16，咨询 G 收口）：ContextPack 侦察包——变更前确定性组装的
// 项目事实速览（代码文件/契约与路由对账/数据形状/可复用模块/基线测试），供迭代轮/
// 修复轮 task 头注入。零 LLM 纯组装；空态如实为空不编造（openQuestions v0 恒空占位）。
// ---------------------------------------------------------------------------

/** 契约/路由来源双标（对账用）：背板 interface_spec vs server/routes 目录卖描。 */
export type ContextPackRouteSource = 'backplane' | 'routes_dir' | 'both'

export interface ContextPackRoute {
  label: string
  source: ContextPackRouteSource
}

export interface ContextPackDataFile {
  file: string
  shape: 'array' | 'object' | 'file' | 'unreadable'
  sampleKeys: string[]
}

export interface ContextPackBaseline {
  total: number
  passed: number
  failed: number
  failedScenarios: string[]
}

export interface ContextPack {
  codeFiles: string[]
  routes: ContextPackRoute[]
  dataFiles: ContextPackDataFile[]
  reusableModules: string[]
  baseline: ContextPackBaseline | null
  affectedHints: string[]
  openQuestions: string[]
}

// ---------------------------------------------------------------------------
// Phase 10 W1-4（2026-09-16，咨询 G 收口）：ChangeContract 变更契约——RoundAnchor
// 的一般化：变更目标/必须保留（兼容性）/范围外/三向验收（正向/负向/兼容）/基线。
// 负向断言 v0 从不变量词表确定性派生（非负/非空/唯一/上限/时间边界/禁止类），
// 无命中如实为空不编造；LLM 加厚留 v1。
// ---------------------------------------------------------------------------

export interface ChangeContractAcceptance {
  /** 本变更的正向验收（来自聚焦项断言/诉求） */
  positive: string[]
  /** 负向断言：违反规则的输入必须被拒绝（状态机禁令/不变量） */
  negative: string[]
  /** 兼容性约束：既有契约端点与数据在变更后保持可用 */
  compat: string[]
}

export interface ChangeContractBaseline {
  testReportPresent: boolean
  passed: number
  total: number
  /** 产物 git 基线（W1-1 开启时为短 hash；未启用时缺省） */
  gitCommit?: string
}

export interface ChangeContract {
  goal: string
  mustPreserve: string[]
  outOfScope: string[]
  acceptance: ChangeContractAcceptance
  baseline: ChangeContractBaseline
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

export {}

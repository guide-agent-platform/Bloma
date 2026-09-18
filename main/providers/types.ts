/**
 * Provider 适配器类型定义（照抄 Proma 上游 packages/core/src/providers/types.ts @ bf3e98c）。
 *
 * R1-providers（2026-09-19「照抄 Proma」稳健性对齐）：上游全仓零 DSML 处理的根因
 * 在这套类型背后的解析口径——tool_use 走结构化事件（tool_call_start/delta），容错
 * 分支覆盖 provider 缺事件等 quirk。Bloma 搬运面收敛为流式侧（sse-reader + parse），
 * 上游聊天侧（ChatMessage history / attachments / title 生成）不搬——Bloma loop 是
 * 全量 agent 形态消息，由 loop-provider-query 自行构建请求体。
 *
 * 与上游的差异（唯一一处）：增补 StreamUsageEvent——上游聊天层不消费流内 usage，
 * Bloma 的用量核算（压缩触发/埋点）依赖 message_start/message_delta 的 usage 字段。
 */

/** 模型返回的工具调用（上游 ToolCall 原样） */
export interface ToolCall {
  /** 工具调用 ID（用于匹配结果） */
  id: string
  /** 工具名称 */
  name: string
  /** 解析后的参数 */
  arguments: Record<string, unknown>
  /** 供应商特定的元数据（如 Google 的 thought_signature） */
  metadata?: Record<string, unknown>
}

/**
 * Anthropic 协议的 thinking 块（上游原样）。
 *
 * 多轮工具调用时必须把 thinking 块原样（含签名）回传给服务端，否则
 * Anthropic 原生拒绝请求；DeepSeek v4 / Kimi K2 Thinking 等 Anthropic 兼容
 * 端点以 "reasoning_content is missing" 拒绝。
 */
export interface ThinkingBlock {
  thinking: string
  signature?: string
}

// ===== 流式事件（上游 StreamEvent 联合 + Bloma usage 扩展） =====

/** 文本增量事件 */
export interface StreamChunkEvent {
  type: 'chunk'
  delta: string
}

/** 推理增量事件 */
export interface StreamReasoningEvent {
  type: 'reasoning'
  delta: string
}

/** 推理签名事件（Anthropic 协议的 signature_delta） */
export interface StreamReasoningSignatureEvent {
  type: 'reasoning_signature'
  signature: string
}

/** 推理块开始事件（content_block_start with type=thinking） */
export interface StreamReasoningBlockStartEvent {
  type: 'reasoning_block_start'
}

/** 推理块结束事件（content_block_stop 对应 thinking 块） */
export interface StreamReasoningBlockStopEvent {
  type: 'reasoning_block_stop'
}

/** 流式错误事件 */
export interface StreamErrorEvent {
  type: 'error'
  error: string
}

/** 流式完成事件 */
export interface StreamDoneEvent {
  type: 'done'
  /** 停止原因：'tool_use' 表示需要执行工具后继续 */
  stopReason?: 'end_turn' | 'tool_use' | string
}

/** 工具调用开始事件 */
export interface StreamToolCallStartEvent {
  type: 'tool_call_start'
  toolCallId: string
  toolName: string
  /** 供应商特定的元数据（如 Google 的 thought_signature） */
  metadata?: Record<string, unknown>
}

/** 工具调用参数增量事件 */
export interface StreamToolCallDeltaEvent {
  type: 'tool_call_delta'
  /** 为空时由 reader 按 metadata / 当前工具调用关联 */
  toolCallId: string
  /** 参数增量；finalArguments 存在时可为空字符串 */
  argumentsDelta: string
  /** 完整参数兜底（如 provider 的 arguments.done 事件），存在时替换已累积参数 */
  finalArguments?: string
  /** 供应商特定的元数据（如 OpenAI Responses 的 outputIndex） */
  metadata?: Record<string, unknown>
}

/** Bloma 扩展（上游无）：usage 增量事件——message_start / message_delta 携带的用量字段 */
export interface StreamUsageEvent {
  type: 'usage'
  inputTokens?: number
  outputTokens?: number
}

/** 所有流式事件的联合类型 */
export type StreamEvent =
  | StreamChunkEvent
  | StreamReasoningEvent
  | StreamReasoningSignatureEvent
  | StreamReasoningBlockStartEvent
  | StreamReasoningBlockStopEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamToolCallStartEvent
  | StreamToolCallDeltaEvent
  | StreamUsageEvent

/** 流式事件回调函数 */
export type StreamEventCallback = (event: StreamEvent) => void

/** 构建好的 HTTP 请求配置（用于 fetch） */
export interface ProviderRequest {
  /** 完整的请求 URL */
  url: string
  /** HTTP 请求头 */
  headers: Record<string, string>
  /** JSON 序列化后的请求体 */
  body: string
}

/**
 * 流式解析适配器接口（上游 ProviderAdapter 的流式子集）。
 *
 * 适配器是纯逻辑：不执行 fetch、不访问文件系统。
 */
export interface StreamAdapter {
  /** 解析 SSE 数据行，提取流式事件（可能为空数组） */
  parseSSELine(jsonLine: string): StreamEvent[]
}

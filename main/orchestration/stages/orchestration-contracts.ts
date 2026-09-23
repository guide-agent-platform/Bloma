/**
 * 编排契约类型（PR4b 拆出）：StreamPublisher/ToolDefinition/ConversationTurn/SDKQuery(Options)/GuideModelOptions——被 kernel 等外部模块 type-import 的契约面。
 * 纯机械搬移（零行为变化）；对外契约经 orchestrator re-export 保持不变。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AgentCancelInput,
  AgentCancelResult,
  AgentEvent,
  AgentLoopJudgeMetadata,
  AgentMessage,
  AgentSendMessageInput,
  AgentSendMessageResult,
  MessageContentBlock,
  PastedImageRef,
  SDKMessage,
  WorkflowStage,
} from '../../../shared/types'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import { appendSessionMessage } from '../../platform/sessions/session-tree'
import { buildThinkingFragment, type ThinkingLevel } from '../../../shared/reasoning-profile'
import { SessionMessageQueue, type QueueEntry } from '../../platform/sessions/message-queue'
import { clearSteerQueue, rejectPendingSteer, steerConfirmEnabled, type SteerLedgerEntry } from '../../agent/loop/steer-queue'
import { emitAgentEvent } from '../../platform/events/agent-event-bus'
import { hydrateMessagesImageBlocks } from '../../platform/shell/pasted-images'
import { trackAnalytics } from '../../delivery/track-analytics'
export { buildSdkEnv } from '../../platform/llm/channel-manager'
import {
  extractErrorStatusCode,
  isInfrastructureFailure,
  isUserCancelledQuery,
  pickBackupChannelEnv,
  readFallbackContext,
  recordChannelSwitch,
  resolveChannelEnv,
} from '../../platform/llm/runtime-fallback'
import { categoryForStage, categoryTemperature } from '../../platform/llm/model-resolution'
import { handleGuideMessage } from '../../guide/guide-agent-service'
import {
  READY_COMPLETION_COPY,
  clearPendingReviewAction,
  feedbackCardEnabled,
  isIterationDecisionId,
  nextRequirementId,
  publishDeliveryFeedbackCard,
  publishReadyNextStepsCard,
  refineModificationDescription,
  resolveBlockedDecision,
  resumeBlockedFlow,
  runBlockedTestRepair,
  ensureResumePreview,
  runAgentLoopPostTesting,
  runIterationTask,
  runSketchTask,
  setPendingReviewAction,
  setProgrammingEventPublisher,
  takeFailedIteration,
  takePendingReviewAction,
} from '../../coding/programming-orchestrator'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from '../../guide/requirement-normalizer'
import { readPrdBackplane } from '../../project/document-engine'
import { backplaneInterfaceSpec } from '../../model/prd-backplane'
import { isDegenerateText } from '../../coding/output-integrity'
import { createWhitespaceArtifactCleaner } from '../../agent/loop/agent-loop'
import { recordDecision } from '../../project/decision-log'
import { captureConstraints, extractConstraints, readProjectConstraints, scanSessionConstraints } from '../../guide/constraint-extractor'
import { isCircuitBreakSettled } from '../recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import { appendExperienceEvent } from '../../experience/event-log'
import { isThinkingLogEnabled, logThinking } from '../../agent/loop/thinking-log'
import { extractErrorMessage } from '../../platform/llm/channel-test-error'
import { anthropicMessagesQueryViaProviders, providerAdapterEnabled } from '../../platform/upstream/providers/loop-query'

import { runAgent } from './agent-dispatch'

export type StreamPublisher = (event: AgentEvent) => void

/**
 * 传给 SDK 的工具定义（Agent Loop，PR1）。
 * 形态对齐 Anthropic Messages API 的 tools 数组元素，原样透传请求体。
 */
export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

/**
 * 传给 SDK 的历史消息轮次（PR1 起 content 支持块数组）。
 * 纯文本轮次照旧传 string（逐字节与改造前一致）；Agent Loop 的 tool_use（assistant）
 * 与 tool_result（user）轮次传 MessageContentBlock[]——tool_result 必须包在 user 消息
 * 的 content 数组里、紧跟对应 tool_use 的 assistant 轮之后（陷阱 11 扩展）。
 */
export interface ConversationTurn {
  role: 'system' | 'user' | 'assistant'
  content: string | MessageContentBlock[]
}

export interface SDKQueryOptions {
  env: Record<string, string>
  signal: AbortSignal
  sessionId: string
  /** 多轮历史（不含当前 prompt）；anthropicMessagesQuery 追加 {role:'user', content: prompt} */
  history?: ConversationTurn[]
  /** 剪贴板粘贴图片引用（clipboard-paste P1，2026-08-29）：prompt 同轮组装 [text,...image] 块数组 */
  images?: PastedImageRef[]
  /**
   * 完整 messages 数组（含末尾 user 轮，Agent Loop 的 tool_result 回填用）。
   * 提供时忽略 history + prompt 拼装，数组原样作为请求 messages（system 轮仍提取到
   * 顶层 system 字段）；不传 = 现状拼装路径，零行为变化。
   */
  messages?: ConversationTurn[]
  /** 单次响应的最大 token 数，缺省 1200（去硬编码：由渠道配置传入） */
  maxTokens?: number
  /** 采样温度（§7.7 类别校准表：guide 0.3 / 生成与判定类 0.1）；缺省不传，由 API 默认 */
  temperature?: number
  /** 工具定义（Agent Loop）：不传 = 现状，请求体不携带 tools 字段 */
  tools?: ToolDefinition[]
  /** 推理档位（reasoning-profile 2026-08-27）：仅判定/校验类任务显式传入；缺省 off = 现状（thinking:disabled） */
  thinkingLevel?: ThinkingLevel
  /** 渠道 providerType（omit 黑名单判断用；不传 = 不做 omit，off 档下与现状一致） */
  providerType?: string
}

export type SDKQuery = (prompt: string, options: SDKQueryOptions) => AsyncIterable<SDKMessage>

/** 引导对话的模型驱动选项（由 runAgent 注入，避免 guide-agent-service 反向依赖 orchestrator 运行时）。 */
export interface GuideModelOptions {
  query: SDKQuery
  env: Record<string, string>
  signal: AbortSignal
  sessionId: string
  history: ConversationTurn[]
  maxTokens: number
  /** §7.7 类别温度：guide 澄清要发散（0.3），由 runAgent 按类别注入 */
  temperature?: number
  persistAssistant: (text: string) => void
}


/**
 * 运行注册表（PR4b 拆出）：项目/会话活跃互斥、前后台运行注册与查询。
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
  clearPendingReviewAction,
  isIterationDecisionId,
  nextRequirementId,
  refineModificationDescription,
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
import { isCircuitBreakSettled } from '../../project/recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import { appendExperienceEvent } from '../../experience/event-log'
import { isThinkingLogEnabled, logThinking } from '../../agent/loop/thinking-log'
import { extractErrorMessage } from '../../platform/llm/channel-test-error'
import { anthropicMessagesQueryViaProviders } from '../../platform/upstream/providers/loop-query'

import { StreamPublisher } from './orchestration-contracts'
import { streamPublisher } from './sdk-glue'
import { runAgent } from './agent-dispatch'
import { makeEvent } from './persistence'

export interface ActiveRun {
  abortController: AbortController
  iterator?: AsyncIterator<SDKMessage>
  projectId: string
  /** 唯一运行令牌；release 时按令牌校验，旧任务不能清掉新任务。 */
  runId: string
  /** 运行的发布通道；后台任务不能污染后来切换的会话。 */
  publisher: StreamPublisher
}

export interface BackgroundRun {
  controller: AbortController
  projectId: string
  runId: string
  publisher: StreamPublisher
}

export const MAX_CONCURRENT_RUNS_PER_PROJECT = 1

export const MAX_RETRIES = 25
export const MAX_RETRY_DURATION_MS = 5 * 60 * 1000
export const SILENT_RETRY_THRESHOLD = 5

export const activeSessions = new Map<string, ActiveRun>()
export const activeProjects = new Map<string, string>()

/**
 * 后台编程任务的取消注册表（U4/U5）。按 runId 保存而不是只按 sessionId：
 * 一个旧任务完成时不能误删同 session 的新任务；project 级互斥由 activeProjects 统一维护。
 */
export const backgroundRuns = new Map<string, BackgroundRun>()

export function activeRunCountForProject(projectId: string): number {
  return activeProjects.has(projectId) ? 1 : 0
}

export function projectBusyError(projectId: string): Error {
  return new Error(`AGENT_PROJECT_BUSY: project ${projectId} already has an active run`)
}

export function acquireProjectRun(projectId: string, runId: string): void {
  if (activeRunCountForProject(projectId) >= MAX_CONCURRENT_RUNS_PER_PROJECT) {
    throw projectBusyError(projectId)
  }
  activeProjects.set(projectId, runId)
}

export function releaseProjectRun(projectId: string, runId: string): void {
  if (activeProjects.get(projectId) === runId) activeProjects.delete(projectId)
}

export function hasRunForProject(projectId: string): boolean {
  return activeProjects.has(projectId)
}

/**
 * 会话消息队列（message-queue-port.md P1，2026-08-27）：生成期间用户消息不丢——
 * 忙时入队、run 完成后自动派发（对齐 ChatGPT/Claude 排队语义）。
 * 队列真相在 main（内存态，重启丢队列 v1 可接受）；renderer 只消费投影事件。
 */
export const sessionMessageQueue = new SessionMessageQueue({
  // 后台生成（runMvpTask/runIterationTask fire-and-forget）也计入「忙」：MVP/迭代是最长
  // 生成阶段，期间发消息同样排队而非直接开跑（审查 P2-⑤）
  isActive: (sessionId) => activeSessions.has(sessionId) || backgroundRuns.has(sessionId),
  // 派发失败安全网放弃钩子（queue-dispatch-requeue r68）：v1 先 console 留痕（观测），
  // 渲染端「发送失败可重试」气泡后续档接入
  onDropped: (sessionId, entry, reason) => {
    console.warn(`[message-queue] 排队消息派发放弃（session=${sessionId} msg=${entry.queueMessageId} reason=${reason}）`)
    // queue_dropped 渲染端红泡（onDropped 气泡，r79）：安全网放弃派发 → 渲染端告知用户（非静默）
    const input = entry.input as AgentSendMessageInput | undefined
    if (input) {
      streamPublisher(makeEvent(input, 'queue_dropped', { queue_message_id: entry.queueMessageId, reason }))
    }
  },
  startRun: async (sessionId, entry) => {
    const input = entry.input as AgentSendMessageInput | undefined
    if (!input) return
    // 派发 = 重新走 runAgent（activeSessions 此时已空，正常执行）；request_id 复用队列消息 id
    await runAgent({ ...input, request_id: entry.queueMessageId })
  },
  onDispatched: (sessionId, entry) => {
    const input = entry.input as AgentSendMessageInput | undefined
    if (!input) return
    streamPublisher(makeEvent(input, 'queued_started', { queue_message_id: entry.queueMessageId }))
  },
})

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId) || backgroundRuns.has(sessionId)
}

/**
 * 会话是否有前台 runAgent 运行。让渡终态补发用（programming-orchestrator 经
 * setForegroundRunChecker 注入）：前台运行自带 completed/error 终态，让渡路径
 * 此时不必（也不应）中途补发 completed 提前熄掉运行指示。
 */
export function hasForegroundRun(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export function isProjectActive(projectId: string): boolean {
  return hasRunForProject(projectId)
}

/** 注册后台编程任务；同一项目不能覆盖已有运行。 */
export function registerBackgroundRun(
  sessionId: string,
  controller: AbortController,
  projectId?: string,
  publisher: StreamPublisher = streamPublisher,
): string {
  const resolvedProjectId = projectId ?? sessionId
  if (backgroundRuns.has(sessionId)) throw new Error('AGENT_SESSION_BUSY')
  const runId = randomUUID()
  acquireProjectRun(resolvedProjectId, runId)
  backgroundRuns.set(sessionId, { controller, projectId: resolvedProjectId, runId, publisher })
  return runId
}

/** 移除后台句柄；只接受注册时返回的令牌，防旧 finally 误删新运行。 */
export function unregisterBackgroundRun(sessionId: string, runId?: string): void {
  const current = backgroundRuns.get(sessionId)
  if (!current || (runId !== undefined && current.runId !== runId)) return
  backgroundRuns.delete(sessionId)
  releaseProjectRun(current.projectId, current.runId)
  // message-queue：后台生成结束 → 尝试派发排队消息（isActive 已解除，若队列有货自动开跑）
  sessionMessageQueue.onRunComplete(sessionId, undefined, false)
}

export function registerForegroundRun(input: AgentSendMessageInput, run: ActiveRun): void {
  if (activeSessions.has(input.session_id)) throw new Error('AGENT_SESSION_BUSY')
  acquireProjectRun(input.project_id, run.runId)
  activeSessions.set(input.session_id, run)
}

// =========================================================================
// ready/completed 阶段模型直答（P1 自由度归还，2026-09-06）
//
// 此前该阶段一律 READY_COMPLETION_COPY 规则直答（反幻觉 P0 护栏）：彻底但用户每次
// 得到同一句。现把表达交还模型，事实底线留在平台：注入事实锚（阶段/项目/功能清单）
// + 校验（未完成措辞禁词/退行文本/长度）→ 带反馈重试一次 → 仍败回退模板（=现状，
// 最坏零回归）。校验在平台代码执行，不依赖模型服从——护栏语义与规则直答等价。
// =========================================================================

/** ready 直答硬校验长度上限（提示词口径 300 字，此处放一倍余量防失控）。 */
export const READY_REPLY_MAX_CHARS = 800


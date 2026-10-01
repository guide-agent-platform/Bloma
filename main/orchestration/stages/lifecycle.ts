/**
 * 生命周期（PR4b 拆出）：cancelAgent 取消、steer 状态事件与延迟提示。
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
import { activeSessions, backgroundRuns, releaseProjectRun, sessionMessageQueue } from './run-registry'
import { streamPublisher } from './sdk-glue'
import { runAgent } from './agent-dispatch'
import { makeEvent, persistTerminalMessage } from './persistence'

export async function cancelAgent(input: AgentCancelInput): Promise<AgentCancelResult> {
  const targets: Array<{ sessionId: string; controller: AbortController; projectId: string; runId: string; publisher: StreamPublisher }> = []

  const foreground = activeSessions.get(input.session_id)
  if (foreground && (!input.project_id || foreground.projectId === input.project_id)) {
    targets.push({
      sessionId: input.session_id,
      controller: foreground.abortController,
      projectId: foreground.projectId,
      runId: foreground.runId,
      publisher: foreground.publisher,
    })
  }
  const background = backgroundRuns.get(input.session_id)
  if (background && (!input.project_id || background.projectId === input.project_id)) {
    targets.push({
      sessionId: input.session_id,
      controller: background.controller,
      projectId: background.projectId,
      runId: background.runId,
      publisher: background.publisher,
    })
  }

  // project_id 是新客户端的主取消范围：一个项目可能由多个入口产生不同 session。
  if (input.project_id) {
    for (const [sessionId, run] of activeSessions) {
      if (run.projectId === input.project_id && !targets.some((target) => target.runId === run.runId)) {
        targets.push({ sessionId, controller: run.abortController, projectId: run.projectId, runId: run.runId, publisher: run.publisher })
      }
    }
    for (const [sessionId, run] of backgroundRuns) {
      if (run.projectId === input.project_id && !targets.some((target) => target.runId === run.runId)) {
        targets.push({ sessionId, controller: run.controller, projectId: run.projectId, runId: run.runId, publisher: run.publisher })
      }
    }
  }

  if (targets.length === 0) {
    // 兜底复位（2026-08-29 线上卡死案例 eb900c57）：点击停止却无可停运行，通常是运行
    // 早已结束但终态事件缺失（如让渡路径漏发 completed），渲染端 running 永久卡 true、
    // 停止按钮点了没反应。这里补发一个 completed 终态把流复位回空闲——幂等（对已空闲
    // 会话再收终态无副作用），不落 JSONL（会话真实终态以实际运行记录为准）。
    streamPublisher(
      makeEvent(
        {
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id ?? '',
          content: '',
          mode: 'quick',
          current_stage: 'choosing_mode',
        },
        'completed',
        { subtype: 'forced_reset' },
      ),
    )
    return { cancelled: false, session_id: input.session_id }
  }

  const reason = new Error(`AGENT_CANCELLED: ${input.reason}`)
  for (const target of targets) {
    target.controller.abort(reason)
    const foregroundRun = activeSessions.get(target.sessionId)
    if (foregroundRun?.runId === target.runId) {
      await foregroundRun.iterator?.return?.()
      activeSessions.delete(target.sessionId)
    }
    const backgroundRun = backgroundRuns.get(target.sessionId)
    if (backgroundRun?.runId === target.runId) {
      backgroundRuns.delete(target.sessionId)
    }
    releaseProjectRun(target.projectId, target.runId)
    // 取消必须有明确终态；后台链路没有 runAgent 的 catch 可以替它发 error。
    target.publisher(makeEvent({
      request_id: input.request_id,
      session_id: target.sessionId,
      project_id: target.projectId,
      content: '',
      mode: 'quick',
      current_stage: 'choosing_mode',
    }, 'error', { code: 'AGENT_CANCELLED' }))
    // 取消也要落盘终态：runAgent 侧收到取消后已释放归属、提前返回，不再写 JSONL，
    // 这里统一为每个目标补一条可还原的停止记录（前台/后台一致）。
    persistTerminalMessage(target.sessionId, 'error', { code: 'AGENT_CANCELLED', message: '用户停止了本次生成' })
  }
  // message-queue：用户停止 → 不自动派发排队消息（stoppedByUser=true，停止意图优先）
  // 并清空该会话排队消息，避免「已排队」气泡永久 limbo（审查 P2-④）。
  // T-4：按 project_id 停止是主取消范围——同项目其他 session 的队列同样清除/抑制，
  // 否则后台 run 注销时 onRunComplete（非 stoppedByUser）会把它们的排队消息自动派发，
  // 违背停止意图。
  for (const target of targets) {
    sessionMessageQueue.clear(target.sessionId)
    sessionMessageQueue.onRunComplete(target.sessionId, undefined, true)
    // P0-1 steer（2026-09-08）：停止即清空待注入队列——「停止后被注入」绝不允许
    //（注入语义以用户当前运行的 loop 存活为前提；runAgentLoop finally 另兜竞态窗口）。
    // I3（P7-7，on 时）：清空前把未注入条目标 rejected——状态条如实翻「未采用·本轮
    //  已停止」，用户提的修改不再静默消失（off 时零变化）。
    if (steerConfirmEnabled()) rejectPendingSteer(target.sessionId)
    clearSteerQueue(target.sessionId)
  }
  sessionMessageQueue.onRunComplete(input.session_id, undefined, true)
  sessionMessageQueue.clear(input.session_id)
  if (steerConfirmEnabled()) rejectPendingSteer(input.session_id)
  clearSteerQueue(input.session_id)
  return { cancelled: true, session_id: input.session_id }
}

/** I3 转向生效确认链（P7-7）：主进程侧发布 steer_status 事件（steer-queue 状态机
 *  每次推进时经 setSteerStatusListener 接入ipc层→此处→streamPublisher→渲染端）。
 *  事件形态对齐 makeEvent（steer-queue 不 import 本模块，注入式解耦）。 */
export function publishSteerStatusEvent(entry: SteerLedgerEntry): void {
  streamPublisher({
    event_id: randomUUID(),
    session_id: entry.sessionId,
    project_id: entry.projectId,
    type: 'steer_status',
    payload: {
      steer_id: entry.steerId,
      content: entry.content,
      impact: entry.impact,
      status: entry.status,
      at: entry.updatedAt,
    },
    created_at: new Date().toISOString(),
  })
}

/** I3 deferred 持久化（2026-09-11 尾批）：留待下一轮达成时会话 JSONL 追加一条
 *  [steer-deferred] system 行——状态条数据是内存态（重启丢），但待办作为文字记录
 *  跨重启可见（HistoryMessages 回放加载）；同一条只 advance 一次，无重复落盘。
 *  ipc 层 statusListener 单点拦截 deferred_next_run 时调用（与事件发布同源）。 */
export function persistSteerDeferredNotice(sessionId: string, content: string): void {
  try {
    appendSessionMessage(sessionId, {
      role: 'system',
      content: [{ type: 'text', text: `[steer-deferred] 留待下一轮的修改：${content}——需要处理时直接把这条修改再发一遍即可开始下一轮。` }],
      timestamp: Date.now(),
    })
  } catch {
    // 落盘失败不阻断状态机（降级：待办仅会话内状态条可见）
  }
}


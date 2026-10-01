/**
 * ready 阶段对话（PR4b 拆出）：事实构建、系统提示、应答校验与收集。
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
import { isCircuitBreakSettled } from '../../project/recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../project/project-service'
import { recordSessionActivity } from '../../platform/sessions/session-service'
import { appendExperienceEvent } from '../../experience/event-log'
import { isThinkingLogEnabled, logThinking } from '../../agent/loop/thinking-log'
import { extractErrorMessage } from '../../platform/llm/channel-test-error'
import { anthropicMessagesQueryViaProviders } from '../../platform/upstream/providers/loop-query'

import { ConversationTurn, SDKQuery } from './orchestration-contracts'
import { READY_REPLY_MAX_CHARS } from './run-registry'

/** 开关已删除（2026-10-01 开关面收敛批）：ready 直答无条件启用。 */

/** ready 直答事实性禁词：命中即判无效（「还没好」惯性幻觉是规则直答的立规原因）。 */
export const READY_REPLY_BANNED =
  /还没好|还未好|尚未(生成|完成|就绪)|还在生成|正在生成|后台(正在|在)?(跑|运行|生成)|请稍等|稍等片刻|正在处理/

/** 组装事实锚：阶段/项目/模式 + PRD 功能清单 + 产物成熟度（完整程序差距可计算，2026-09-06）。
 * 背板/索引缺失时逐项降级，不阻断直答。 */
export function buildReadyChatFacts(projectId: string, stage: WorkflowStage, aiReady: boolean): string {
  const lines: string[] = [`- 阶段：${stage}（可运行 MVP 已生成，右侧预览区可用）`]
  try {
    const project = findProject(projectId)
    lines.push(`- 项目：${project.name}（${project.mode === 'longterm' ? '长期' : '快消'}模式）`)
  } catch {
    // 项目索引缺失（测试环境）：降级为基础事实
  }
  try {
    const items = readPrdBackplane(projectId).requirements.slice(0, 8)
    if (items.length > 0) {
      lines.push('- 功能清单：')
      for (const item of items) {
        lines.push(`  - ${item.id} ${item.description}${item.priority ? `（${item.priority}）` : ''}`)
      }
    }
  } catch {
    // 背板缺失（存量项目）：事实锚只留阶段
  }
  // 产物成熟度（终点拍板 2026-09-06：终点不是 MVP，是前后端分离的完整程序）——
  // 从磁盘/背板可计算的差距，模型据此如实回答「还差什么」并给具体建议
  try {
    const root = findProject(projectId).root_path
    const routesDir = join(root, 'server', 'routes')
    const routeCount = existsSync(routesDir) ? readdirSync(routesDir).filter((f) => f.endsWith('.js')).length : 0
    lines.push(
      routeCount > 0
        ? `- 后端路由：server/routes 已有 ${routeCount} 个路由模块`
        : '- 后端路由：尚未创建 server/routes/（数据留存仍可能在前端）',
    )
    lines.push(existsSync(join(root, 'data')) ? '- 数据持久化：data/ 目录已在使用' : '- 数据持久化：data/ 目录尚未建立')
  } catch {
    // 磁盘读取失败：跳过成熟度行
  }
  try {
    const endpoints = backplaneInterfaceSpec(readPrdBackplane(projectId))
    lines.push(
      endpoints.length > 0
        ? `- 接口契约：${endpoints.length} 条（${endpoints.map((ep) => `${ep.method ?? 'GET'} ${ep.endpoint}`).join('、')}）`
        : '- 接口契约：无（纯展示类产物）',
    )
  } catch {
    // 背板缺失：跳过契约行
  }
  lines.push(aiReady ? '- AI 能力：/api/llm 模型代理可用（渠道已注入）' : '- AI 能力：未配置（/api/llm 会返回 llm_not_configured）')
  return lines.join('\n')
}

export function buildReadyChatSystem(facts: string): string {
  return [
    '你是「向导 Agent」。用户的软件项目已经生成完成（可运行 MVP 就绪、右侧预览区可用），用户在完成后的对话里说了一句话，你要像一个真人产品经理那样直接回答。',
    '',
    '【项目事实（以此为准，不得编造）】',
    facts,
    '',
    '【引导职责（终点是前后端分离的完整程序，MVP 只是里程碑）】',
    '- 用户问「还算完整吗/还差什么/下一步/怎么导出」时：基于成熟度事实如实回答差距，并给 1~2 条具体建议（数据存到服务端、补充功能、配置真实 AI、导出部署）。',
    '- 建议要贴合差距：缺后端路由就建议把数据存到服务端；已齐备就如实说已经比较完整并建议导出。',
    '',
    '【硬性底线（违反会被平台判无效并重试）】',
    '- 项目已经生成好：不得出现「还没好」「还在生成」「后台运行」等任何未完成措辞。',
    '- 不得承诺平台没有的能力（真实部署到云、多用户账号等后端托管类能力）。',
    '- 只回答与用户这句话相关的内容，不重复项目介绍全文，不复述功能清单。',
    '',
    '直接输出回复正文（简体中文口语，300 字以内），不要 JSON、不要标题、不要格式围栏。',
  ].join('\n')
}

/** ready 直答校验：null = 通过；否则返回失败原因（反馈重试的输入）。 */
export function validateReadyReply(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return '回复为空'
  if (trimmed.length > READY_REPLY_MAX_CHARS) return `回复过长（超过 ${READY_REPLY_MAX_CHARS} 字）`
  if (isDegenerateText(trimmed)) return '回复混入了工具调用协议原文或退行性重复文本'
  if (READY_REPLY_BANNED.test(trimmed)) return '回复否认了已生成状态（出现未完成措辞）'
  return null
}

export interface ReadyChatParams {
  query: SDKQuery
  env: Record<string, string>
  signal: AbortSignal
  sessionId: string
  history: ConversationTurn[]
  maxTokens: number
  providerType?: string
  system: string
  userContent: string
}

/** 采集一次直答调用的完整文本（无 tools；ds 空白伪增量清洗复用 loop 的 cleaner，陷阱 38）。 */
export async function collectReadyChatText(params: ReadyChatParams, messages: ConversationTurn[]): Promise<string> {
  const cleaner = createWhitespaceArtifactCleaner()
  let text = ''
  for await (const sdk of params.query('', {
    env: params.env,
    signal: params.signal,
    sessionId: params.sessionId,
    maxTokens: params.maxTokens,
    ...(params.providerType !== undefined ? { providerType: params.providerType } : {}),
    temperature: categoryTemperature('guide'),
    messages,
  })) {
    if (sdk.type === 'assistant' && sdk.message) {
      for (const block of sdk.message.content) {
        if (block.type === 'text' && block.text) {
          for (const piece of cleaner.push(block.text)) text += piece
        }
      }
    }
  }
  for (const piece of cleaner.end()) text += piece
  return text
}

/**
 * ready 直答：一次调用 + 校验失败带反馈重试一次。不流式上屏（失败重试不污染气泡），
 * 校验通过后由调用方整段发布。渠道故障（非取消）回退模板；用户取消向上传播不吞信号。
 */
export async function runReadyStageChat(params: ReadyChatParams): Promise<{ text: string; ok: boolean }> {
  const messages: ConversationTurn[] = [
    { role: 'system', content: params.system },
    ...params.history,
    { role: 'user', content: [{ type: 'text', text: params.userContent }] },
  ]
  let first = ''
  try {
    first = await collectReadyChatText(params, messages)
  } catch (error) {
    if (params.signal.aborted) throw error
    return { text: '', ok: false }
  }
  const firstProblem = validateReadyReply(first)
  if (!firstProblem) return { text: first.trim(), ok: true }
  try {
    // 带反馈重试：把首次作答与失败原因放进对话，模型看得见自己错在哪
    const second = await collectReadyChatText(params, [
      ...messages,
      { role: 'assistant', content: [{ type: 'text', text: first }] },
      { role: 'user', content: [{ type: 'text', text: `你刚才的回复没有通过平台校验（${firstProblem}）。请重新回答用户这句话：「${params.userContent}」` }] },
    ])
    if (!validateReadyReply(second)) return { text: second.trim(), ok: true }
  } catch (error) {
    if (params.signal.aborted) throw error
  }
  return { text: first.trim(), ok: false }
}


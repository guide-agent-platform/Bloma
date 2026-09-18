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
} from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { appendSessionMessage } from './session-tree'
import { buildThinkingFragment, type ThinkingLevel } from '../shared/reasoning-profile'
import { SessionMessageQueue, type QueueEntry } from './message-queue'
import { clearSteerQueue, rejectPendingSteer, steerConfirmEnabled, type SteerLedgerEntry } from './steer-queue'
import { emitAgentEvent } from './agent-event-bus'
import { hydrateMessagesImageBlocks } from './pasted-images'
import { trackAnalytics } from './platform-services'
export { buildSdkEnv } from './channel-manager'
import {
  extractErrorStatusCode,
  isInfrastructureFailure,
  isUserCancelledQuery,
  pickBackupChannelEnv,
  readFallbackContext,
  recordChannelSwitch,
  resolveChannelEnv,
} from './runtime-fallback'
import { categoryForStage, categoryTemperature } from './model-resolution'
import { handleGuideMessage } from './guide-agent-service'
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
} from './programming-orchestrator'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from './requirement-normalizer'
import { readPrdBackplane } from './document-engine'
import { backplaneInterfaceSpec } from './model/prd-backplane'
import { isDegenerateText } from './coding/output-integrity'
import { createWhitespaceArtifactCleaner } from './coding/agent-loop'
import { recordDecision } from './decision-log'
import { captureConstraints, extractConstraints, readProjectConstraints, scanSessionConstraints } from './constraint-extractor'
import { isCircuitBreakSettled } from './recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from './project-service'
import { recordSessionActivity } from './session-service'
import { appendExperienceEvent } from './experience/event-log'
import { isThinkingLogEnabled, logThinking } from './thinking-log'
import { extractErrorMessage } from './channel-test-error'

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

interface ActiveRun {
  abortController: AbortController
  iterator?: AsyncIterator<SDKMessage>
  projectId: string
  /** 唯一运行令牌；release 时按令牌校验，旧任务不能清掉新任务。 */
  runId: string
  /** 运行的发布通道；后台任务不能污染后来切换的会话。 */
  publisher: StreamPublisher
}

interface BackgroundRun {
  controller: AbortController
  projectId: string
  runId: string
  publisher: StreamPublisher
}

const MAX_CONCURRENT_RUNS_PER_PROJECT = 1

const MAX_RETRIES = 25
const MAX_RETRY_DURATION_MS = 5 * 60 * 1000
const SILENT_RETRY_THRESHOLD = 5

const activeSessions = new Map<string, ActiveRun>()
const activeProjects = new Map<string, string>()

/**
 * 后台编程任务的取消注册表（U4/U5）。按 runId 保存而不是只按 sessionId：
 * 一个旧任务完成时不能误删同 session 的新任务；project 级互斥由 activeProjects 统一维护。
 */
const backgroundRuns = new Map<string, BackgroundRun>()

function activeRunCountForProject(projectId: string): number {
  return activeProjects.has(projectId) ? 1 : 0
}

function projectBusyError(projectId: string): Error {
  return new Error(`AGENT_PROJECT_BUSY: project ${projectId} already has an active run`)
}

function acquireProjectRun(projectId: string, runId: string): void {
  if (activeRunCountForProject(projectId) >= MAX_CONCURRENT_RUNS_PER_PROJECT) {
    throw projectBusyError(projectId)
  }
  activeProjects.set(projectId, runId)
}

function releaseProjectRun(projectId: string, runId: string): void {
  if (activeProjects.get(projectId) === runId) activeProjects.delete(projectId)
}

function hasRunForProject(projectId: string): boolean {
  return activeProjects.has(projectId)
}

/**
 * 会话消息队列（message-queue-port.md P1，2026-08-27）：生成期间用户消息不丢——
 * 忙时入队、run 完成后自动派发（对齐 ChatGPT/Claude 排队语义）。
 * 队列真相在 main（内存态，重启丢队列 v1 可接受）；renderer 只消费投影事件。
 */
const sessionMessageQueue = new SessionMessageQueue({
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

let streamPublisher: StreamPublisher = () => undefined
let sdkQuery: SDKQuery = queryWithRuntimeFallback
let retrySleep: (ms: number) => Promise<void> = sleep

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  // P2-A 事件总线（2026-09-08）：接线时套一层 emit——事件先广播到 onAgentEvent 订阅面
  // 再转发原发布目标；原发布链路零改动（行为不变，总线只读旁路）
  streamPublisher = (event) => {
    emitAgentEvent(event)
    publisher(event)
  }
}

export function setSDKQueryForTests(query: SDKQuery): void {
  sdkQuery = query
}

export function resetSDKQueryForTests(): void {
  sdkQuery = queryWithRuntimeFallback
}

/** 生产侧 query 访问器：读取模块级 sdkQuery（默认 anthropicMessagesQuery），供 ipc.ts 透传给 runMvpTask。 */
export function getSdkQuery(): SDKQuery {
  return sdkQuery
}

export function setRetrySleepForTests(sleepFn: (ms: number) => Promise<void>): void {
  retrySleep = sleepFn
}

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

function registerForegroundRun(input: AgentSendMessageInput, run: ActiveRun): void {
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
const READY_REPLY_MAX_CHARS = 800

/** ready 直答开关（缺省 on）：BLOMA_READY_CHAT=0/off/false 回退纯模板现状（灰度/回滚杠杆）。 */
function readyChatEnabled(): boolean {
  const raw = process.env.BLOMA_READY_CHAT
  if (raw === undefined || raw.trim() === '') return true
  const normalized = raw.trim().toLowerCase()
  return normalized !== '0' && normalized !== 'off' && normalized !== 'false'
}

/** ready 直答事实性禁词：命中即判无效（「还没好」惯性幻觉是规则直答的立规原因）。 */
const READY_REPLY_BANNED =
  /还没好|还未好|尚未(生成|完成|就绪)|还在生成|正在生成|后台(正在|在)?(跑|运行|生成)|请稍等|稍等片刻|正在处理/

/** 组装事实锚：阶段/项目/模式 + PRD 功能清单 + 产物成熟度（完整程序差距可计算，2026-09-06）。
 * 背板/索引缺失时逐项降级，不阻断直答。 */
function buildReadyChatFacts(projectId: string, stage: WorkflowStage, aiReady: boolean): string {
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

function buildReadyChatSystem(facts: string): string {
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
function validateReadyReply(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return '回复为空'
  if (trimmed.length > READY_REPLY_MAX_CHARS) return `回复过长（超过 ${READY_REPLY_MAX_CHARS} 字）`
  if (isDegenerateText(trimmed)) return '回复混入了工具调用协议原文或退行性重复文本'
  if (READY_REPLY_BANNED.test(trimmed)) return '回复否认了已生成状态（出现未完成措辞）'
  return null
}

interface ReadyChatParams {
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
async function collectReadyChatText(params: ReadyChatParams, messages: ConversationTurn[]): Promise<string> {
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
async function runReadyStageChat(params: ReadyChatParams): Promise<{ text: string; ok: boolean }> {
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

export async function runAgent(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
  if (activeSessions.has(input.session_id)) {
    // message-queue（message-queue-port.md P1，2026-08-27）：生成期间消息排队不丢——
    // 排队中仅 UI 投影（queued 态），run 完成后自动派发；用户可撤回。
    sessionMessageQueue.enqueue(input.session_id, {
      queueMessageId: input.request_id,
      userMessage: input.content,
      input,
    })
    return { accepted: true, session_id: input.session_id, stream_started: false, queued: true }
  }
  const runId = randomUUID()
  const abortController = new AbortController()
  const run: ActiveRun = {
    abortController,
    projectId: input.project_id,
    runId,
    publisher: streamPublisher,
  }
  registerForegroundRun(input, run)

  const received: SDKMessage[] = []
  // message-queue：run 终态收口判断用户是否主动停止（isUserCancelled 分支置 true）
  let stoppedByUser = false

  try {
    // 权威项目阶段（工作项 1）：以项目存储为准，渲染端上报阶段仅为回退。
    // 前移到渠道解析之前——类别路由（§6.4）需要按阶段选文档类别。
    let authoritativeStage: WorkflowStage = input.current_stage
    try {
      authoritativeStage = findProject(input.project_id).current_stage
    } catch {
      // 项目索引缺失（如测试环境）时退回渲染端上报的阶段
    }

    // 渠道 + 类别 → env 统一收口（runtime-fallback）：类别路由（§6.4）按权威阶段解析
    // 模型（模型名用 name 真实模型 ID）；主渠道密钥不可解密/无启用模型时按 T9 切备用
    // 渠道（切换已落决策日志），无备用才降级。env 携带回退上下文供请求期被动切换。
    const resolution = resolveChannelEnv({
      channelId: input.channel_id,
      category: categoryForStage(authoritativeStage),
      projectId: input.project_id,
      sessionId: input.session_id,
    })
    const channel = resolution.channel
    const env = resolution.env
    if (env) {
      console.debug?.(`[runAgent] channel ${channel?.id} (${channel?.name}) 解析成功（类别 ${categoryForStage(authoritativeStage)}）`)
    } else if (resolution.unusableReason === 'no_channel') {
      // 无可用渠道（无启用渠道 / 密钥均不可解密且无备用）：引导回规则路由、草图落模板，
      // 全链路静默降级。必须留日志——2026-08-15 赛车模拟器案例正是这一支无声
      // 瞬断（模型缺席 18ms 出模板草图），事后只能靠毫秒级时间差反推。
      console.error('[runAgent] 未解析到可用渠道（input.channel_id='
        + `${input.channel_id ?? 'auto'}，getFirstEnabledChannel 无可用项），本次模型不参与：引导走规则路由、草图走模板`)
    } else {
      // 主渠道不可用且无备用（decrypt_failed / model_not_found，切换未遂的原因已在
      // runtime-fallback 记录）：引导路径回规则路由，编程路径报可读错误。
      console.error(`[runAgent] 渠道不可用（reason=${resolution.unusableReason}，channel_id=${input.channel_id ?? 'auto'}），本次模型不参与：引导走规则路由、草图走模板`)
    }
    const maxTokens = channel?.max_tokens ?? 640000
    // 多轮历史（T4-L2 窗口改造）：近 N 轮原文（显式常量，默认 10——不再静默写死 20；
    // 窗口只管「最近在聊什么」）+ 全量约束扫描回灌（约束是长期不变量，来自全量 JSONL，
    // 第 1 轮说的约束在 30 轮后依然注入）。漏网的约束在此回填 project.constraints。
    const recentHistory = loadConversationHistory(input.session_id, HISTORY_WINDOW_TURNS)
    const sessionConstraints = scanSessionConstraints(input.session_id)
    if (sessionConstraints.length > 0) {
      captureConstraints({
        project_id: input.project_id,
        session_id: input.session_id,
        constraints: sessionConstraints,
        source: 'session_scan',
      })
    }
    const constraintTurn: ConversationTurn[] = sessionConstraints.length
      ? [
          {
            role: 'system',
            content:
              '【用户已声明的约束（历轮全量扫描，长期有效）】\n' +
              sessionConstraints.map((constraint) => `- ${constraint}`).join('\n') +
              '\n理解需求、澄清提问与功能设计都不得违反以上约束；与约束冲突的功能一律不做。',
          },
        ]
      : []
    const history = [...recentHistory, ...constraintTurn]

    appendAgentMessage(input.session_id, {
      role: 'user',
      // clipboard-paste P1（2026-08-29）：带图消息落 [text, ...image 短引用] 块数组（JSONL 无 base64）
      content: input.images?.length
        ? [
            { type: 'text', text: input.content },
            ...input.images.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
          ]
        : [{ type: 'text', text: input.content }],
      timestamp: Date.now(),
    })
    // 维护会话索引并回填 Project.last_session_id，支撑历史对话回访恢复
    recordSessionActivity(input.session_id, input.project_id)

    // 权威项目阶段已在函数顶部解析（categoryForStage 类别路由依赖它）；渲染端
    // workflowStageAtom 由 stage_changed 事件驱动，MVP/测试/ready 阶段的事件若丢失
    // 或乱序会导致渲染端阶段滞后（如项目已 ready 仍上报 sketch_ready），护栏/引导
    // 路径/编程路径注入必须统一读 findProject 的真实阶段，避免据此错报进度。

    // 助手回复落盘（模型路径与规则路径共用，保证回访恢复时对话完整）
    const persistAssistant = (text: string) =>
      appendAgentMessage(input.session_id, {
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      })

    // 内部标记落盘（system role，回访恢复不展示）：决策卡片选项原文等追溯信息
    const persistSystem = (text: string) =>
      appendAgentMessage(input.session_id, {
        role: 'system',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      })

    // 引导路径的模型选项：渠道可用则切真实模型（不可用/解析失败回退规则），无渠道直接走规则，不阻塞澄清
    const guideOptions: GuideModelOptions | undefined = env
      ? {
          query: sdkQuery,
          env,
          signal: abortController.signal,
          sessionId: input.session_id,
          history,
          maxTokens,
          temperature: categoryTemperature('guide'),
          persistAssistant,
        }
      : undefined

    // 阻塞态决策回传（A2/A3）：blocked_action 存在时优先恢复被阻塞的编程操作
    const blockedDecision = resolveBlockedDecision(input)
    if (blockedDecision !== undefined) {
      // F-A 修复（2026-09-11 审计）：用户转点阻塞卡说明已离开「局部优化/整版重做」
      // 补充流，残留标记会让下一句普通诉求被误当局部修改，先清
      clearPendingReviewAction(input.project_id)
      if (blockedDecision === 'explain') {
        // 补充说明：清阻塞 + 回澄清，内容交给引导路径重新理解
        await resumeBlockedFlow(
          { request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, mode: input.mode, decision: 'explain', content: input.content, query: sdkQuery, channel_id: input.channel_id },
          streamPublisher,
        )
        await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant, persistSystem)
      } else {
        await resumeBlockedFlow(
          { request_id: input.request_id, session_id: input.session_id, project_id: input.project_id, mode: input.mode, decision: blockedDecision, content: input.content, query: sdkQuery, channel_id: input.channel_id },
          streamPublisher,
        )
      }
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 修改确认卡回传（keep/refine/regenerate，2026-09-11 三按钮改版）：必须在引导路径
    // 之前拦截——此刻权威阶段是 blocked_for_user_decision，若落入 handleGuideMessage
    // 会被 resolveCardAnswer 当成澄清卡答案误入草图生成。
    if (input.metadata?.source === 'card_option' && isIterationDecisionId(input.metadata.selected_option_id)) {
      await resolveIterationDecisionFlow(input, streamPublisher, sdkQuery, abortController.signal)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // P7-9b 后续批（2026-09-11）：decision_selected 其余卡接线③——就绪引导卡
    //（next_backend 进迭代通道；export_handoff 走特调导出 IPC 不进本链零记录）。
    // 窄判定零误记：只认 ready_next_steps 的专属选项 id，不碰澄清卡答案空间。
    if (input.metadata?.source === 'card_option' && input.metadata.selected_option_id === 'next_backend') {
      // F-A 修复：同上——用户转点引导卡，清残留补充态
      clearPendingReviewAction(input.project_id)
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'decision_selected',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { stage: 'ready_next_steps', action: 'next_backend' },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不影响迭代链（后续正常消息链路继续）
      }
    }

    // U12：失败重试卡回传（selected_option_id === 'retry'）——取出上次失败诉求原样重跑，
    // 在引导路径/ready 护栏之前拦截（与修改确认卡同理），实现「一键重试」而非重新打字。
    if (input.metadata?.source === 'card_option' && input.metadata.selected_option_id === 'retry') {
      const failedPrompt = takeFailedIteration(input.project_id)
      // P7-9b 后续批（2026-09-11）：decision_selected 其余卡接线②——失败重试卡
      //（埋点在消费性 take 之后，用局部变量——先埋会拿走 failedPrompt）
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'decision_selected',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { stage: 'iteration_retry', action: 'retry', has_failed_prompt: failedPrompt !== undefined },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不影响重试链
      }
      if (failedPrompt) {
        setProgrammingEventPublisher(streamPublisher)
        await runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: failedPrompt,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
        })
      } else {
        // 重试诉求已失效（如重启后点旧卡）：如实说明，收敛回 ready
        const copy = '这次重试的诉求已经失效，想调整的话请再描述一次。'
        updateProject(input.project_id, { current_stage: 'ready' })
        streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
        appendAgentMessage(input.session_id, {
          role: 'assistant',
          content: [{ type: 'text', text: copy }],
          timestamp: Date.now(),
        })
        streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      }
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // F-B 修复（2026-09-11 审计）：二次确认态（blocked）下用户打字 = 补充/修改重做方向，
    // 更新方向并重发确认卡——绝不落入引导路径（否则确认卡悬挂、用户被引去澄清对话、
    // 补充的话被当无关输入）。取消词清态回 ready；进度/寒暄放回标记交回常规。
    if (authoritativeStage === 'blocked_for_user_decision' && input.metadata?.source !== 'card_option') {
      const pendingReview = takePendingReviewAction(input.project_id)
      if (pendingReview?.kind === 'rebuild_confirm') {
        const trimmed = input.content.trim()
        if (REFINE_CANCEL_RE.test(trimmed)) {
          const copy = '好，先保持现在的版本。想改的时候再说。'
          persistAssistant(copy)
          streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        if (!PROGRESS_QUERY_RE.test(trimmed) && !TRIVIAL_ACK_RE.test(trimmed)) {
          const direction = refineModificationDescription(trimmed) || trimmed
          setPendingReviewAction(input.project_id, { kind: 'rebuild_confirm', direction })
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'modification_decision',
              title: '整版重做方向已更新，重新确认',
              why: `二次确认态下用户补充方向：「${direction}」；更新方向并重发确认卡（不打断确认流）`,
            },
          })
          publishRebuildConfirmCard(input, streamPublisher, direction, persistAssistant, persistSystem)
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        // 进度/寒暄：放回标记，交回常规（后续走 blocked 引导应答）
        setPendingReviewAction(input.project_id, pendingReview)
      } else if (pendingReview) {
        setPendingReviewAction(input.project_id, pendingReview)
      }
    }

    if (shouldUseGuideAgent(authoritativeStage)) {
      await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant, persistSystem)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 转移阶段护栏（问题 A / P1）：sketch_ready 阶段的消息不得落入无工具的编程路径。
    // 后端已产出草图，模型拿不到工具上下文只会「假装交付」/把 HTML 贴进聊天。
    // 意图分流（2026-08-16 用户反馈「无法对草图提修改意见」）：此前该阶段所有输入
    // 一律回固定文案，文案却承诺「直接告诉我哪里要改」——修改意见实际无处理路径，
    // 用户唯一出路是点「生成完整功能」直接进 MVP。现在与 ready 护栏同理做意图
    // 分流：识别到修改诉求 → 清洗后并入需求清单，重新生成草图（落回 sketch_ready）。
    // 草图重生成是低成本方向确认，与 ready 阶段的修改确认门不同——不过门直接改，
    // 改错了也能低成本再改。其余输入（确认/进度/闲聊）维持固定引导走按钮。
    // 判断用权威阶段：项目已推进到 ready 时（渲染端阶段可能滞后）不得误入此护栏，
    // 否则会把「项目已好」错报成「还在草图阶段」。
    if (authoritativeStage === 'sketch_ready') {
      const intent = await resolveModificationIntent({
        content: input.content,
        project_id: input.project_id,
        session_id: input.session_id,
        query: sdkQuery,
        env,
        signal: abortController.signal,
        maxTokens,
        providerType: channel?.provider_type,
      })
      if (intent === 'modify') {
        const description = refineModificationDescription(input.content)
        // 约束走门（T4-L1 修改门）：修改意见里的约束语句入库（「不含登录」类），
        // 归一化判定 out_of_scope 是语义层的；这里是关键词层的确定性兜底
        captureConstraints({
          project_id: input.project_id,
          session_id: input.session_id,
          constraints: extractConstraints(description),
          source: 'sketch_ready_modification',
        })
        const existing = readLastSketchRequirements(input.project_id)
        // 修改诉求归一化后并入需求清单：口语碎片原样入库会污染 PRD 背板（线上案例
        // 「重新生成」被 acceptance 解释成功能、产品里长出重置按钮；「车的运行方向不对」
        // 只能生成最小满足版）。归一化失败/无渠道回退改动前现状（原样追加），不阻断草图重生成。
        const normalization = await normalizeRequirementUpdate({
          session_id: input.session_id,
          existing,
          modification: description,
          constraints: readProjectConstraints(input.project_id),
          query: sdkQuery,
          env,
          signal: abortController.signal,
          // omit 推广（reasoning-profile 2026-08-27）：Token Plan 类渠道即使 off 档也
          // 发 disabled 会 400——透传 providerType 激活 omit，免 400+重试往返
          providerType: channel?.provider_type,
        })
        const requirements = applyNormalization(existing, normalization, nextRequirementId(existing), 'correction')
        if (normalization.action === 'out_of_scope' && normalization.outOfScope) {
          addScopeExclusion(input.project_id, normalization.outOfScope)
        }
        if (normalization.via === 'llm') {
          recordRequirementNormalization(input, 'sketch_ready', description, normalization)
        }
        recordSketchGenerated(input.project_id, requirements)
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'modification_gate',
            title: '草图阶段修改意见',
            why: `用户对草图提出「${input.content}」，清洗为「${description}」并入需求清单（${normalization.action}${normalization.reviseId ? ` ${normalization.reviseId}` : ''}），重新生成草图`,
            detail: {
              stage: 'sketch_ready',
              normalization: { action: normalization.action, revise_id: normalization.reviseId, description: normalization.description },
              requirements,
            },
          },
        })
        // ack 如实（2026-08-29 线上案例：点选纠错圈选标题说「换个名字」，归一化判 skip
        // 但旧 ack 仍说「按…调整草图」，用户体感「我说改名它说改了结果没改」）。
        // skip 意味着诉求未入需求，必须告知而非假装采纳（与 runIterationTask 口径一致）。
        const ack =
          normalization.action === 'skip'
            ? `收到「${truncateForCopy(input.content, 40)}」——这句我没当作需求改动（判为操作指令），按原样重新生成了一版。想改哪里请直接说，比如「标题改成计算助手」。`
            : `好的，按「${truncateForCopy(description, 40)}」调整草图，重新生成一版。`
        persistAssistant(ack)
        streamPublisher(makeEvent(input, 'message_delta', { text: ack }))
        setProgrammingEventPublisher(streamPublisher)
        await runSketchTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: description,
          requirements,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
        })
        persistTerminalMessage(input.session_id, 'completed')
        streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      const guidance =
        '草图已经生成好了。你可以点预览区上方的「生成完整功能」确认并继续；' +
        '想调整的话，点预览区「纠错」按钮标记不满意的位置，或直接告诉我哪里要改。'
      persistAssistant(guidance)
      streamPublisher(makeEvent(input, 'message_delta', { text: guidance }))
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 完成阶段护栏（P0）：ready/completed 阶段跳过 LLM、走规则直答。
    // 此前依赖「注入权威阶段 + 硬 prompt」让模型如实汇报，但实测模型仍会延续历史里
    // 的「还没好/后台还在跑」惯性持续幻觉。这里与 sketch_ready 护栏同理：直接规则
    // 回答「已经生成好了」，彻底不依赖模型服从，杜绝「还没好」编造。
    // 但必须做意图分流：识别到修改/调整/纠错类输入时，进入迭代重新生成流程，
    // 而不是一律返回固定文案——否则「已生成后继续改」会被挡成「修改黑洞」。
    if (authoritativeStage === 'ready' || authoritativeStage === 'completed') {
      // 「局部优化 / 整版重做」补充态（2026-09-11 卡位改版）：用户在就绪三按钮卡上点了
      // 局部优化/整版重做后，这一句就是他要说的话——
      //  - optimize          → 直接走局部修改（localOnly，不弹卡）；
      //  - rebuild_direction → 收集方向后转二次确认卡（不直接重做）；
      //  - rebuild_confirm   → 等用户点二次确认卡，文不消费；
      //  - 取消词            → 清标记回 ready。
      const pendingReview = takePendingReviewAction(input.project_id)
      if (pendingReview && pendingReview.kind === 'rebuild_confirm') {
        // rebuild_confirm 态的主处理在 blocked 阶段拦截（见 guide 路由前）——
        // publishRebuildConfirmCard 会把阶段置为 blocked_for_user_decision，用户打字
        // 到不了这里；此处仅兼容异常残留（阶段被外部改回 ready），放回交回常规处理
        setPendingReviewAction(input.project_id, pendingReview)
      } else if (pendingReview) {
        const trimmed = input.content.trim()
        if (REFINE_CANCEL_RE.test(trimmed)) {
          const copy = '好，先保持现在的版本。想改的时候再说。'
          persistAssistant(copy)
          streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
        // 纯进度追问/寒暄不是具体诉求：不误起迭代，交回下方常规处理
        if (!PROGRESS_QUERY_RE.test(trimmed) && !TRIVIAL_ACK_RE.test(trimmed)) {
          if (pendingReview.kind === 'optimize') {
            const localPrompt = refineModificationDescription(trimmed) || trimmed
            recordDecision({
              project_id: input.project_id,
              session_id: input.session_id,
              entry: {
                type: 'modification_decision',
                title: '局部优化（用户补充诉求）',
                why: `就绪卡「局部优化」后补充的诉求：「${localPrompt}」；按局部修改处理（其余功能项保持现状）`,
              },
            })
            setProgrammingEventPublisher(streamPublisher)
            await runIterationTask({
              request_id: input.request_id,
              session_id: input.session_id,
              project_id: input.project_id,
              mode: input.mode,
              prompt: localPrompt,
              channel_id: input.channel_id,
              query: sdkQuery,
              signal: abortController.signal,
              localOnly: true,
            })
            persistTerminalMessage(input.session_id, 'completed')
            streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
            return { accepted: true, session_id: input.session_id, stream_started: true }
          }
          // rebuild_direction：收集重做方向 → 二次确认卡（防误触），先不重做
          const direction = refineModificationDescription(trimmed) || trimmed
          setPendingReviewAction(input.project_id, { kind: 'rebuild_confirm', direction })
          recordDecision({
            project_id: input.project_id,
            session_id: input.session_id,
            entry: {
              type: 'modification_decision',
              title: '整版重做方向已收集，等待二次确认',
              why: `就绪卡「整版重做」后补充的方向：「${direction}」；已转二次确认卡，确认后才重做`,
            },
          })
          publishRebuildConfirmCard(input, streamPublisher, direction, persistAssistant, persistSystem)
          persistTerminalMessage(input.session_id, 'completed')
          streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
          return { accepted: true, session_id: input.session_id, stream_started: true }
        }
      }

      const intent = await resolveModificationIntent({
        content: input.content,
        project_id: input.project_id,
        session_id: input.session_id,
        query: sdkQuery,
        env,
        signal: abortController.signal,
        maxTokens,
        providerType: channel?.provider_type,
      })
      if (intent === 'modify') {
        // 用户直接打字提修改（未走就绪卡）：一律按「局部优化」处理（轻量局部修改），
        // 不再弹确认卡——是轻量还是整版重做只由用户在就绪卡上的选项决定
        //（2026-09-11 定案：分流只看用户选项，不看用户在输入框里说的话）。
        const localPrompt = refineModificationDescription(input.content) || input.content.trim()
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'modification_decision',
            title: '用户提修改（默认局部优化）',
            why: `ready 阶段直接打字提修改「${input.content}」；按局部优化处理（其余功能项保持现状）`,
          },
        })
        setProgrammingEventPublisher(streamPublisher)
        await runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: localPrompt,
          channel_id: input.channel_id,
          query: sdkQuery,
          signal: abortController.signal,
          localOnly: true,
        })
        persistTerminalMessage(input.session_id, 'completed')
        streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      // other（进度追问/闲聊）：模型直答 + 事实校验，模板兜底（P1 自由度归还，2026-09-06）。
      // 渠道不可用/校验不过（重试一次后仍败）回退 READY_COMPLETION_COPY + 修改出口引导
      //（=原规则直答，反幻觉底线不降级）；直答成功则用户得到针对这句话的自然回答。
      const fallbackCopy = `${READY_COMPLETION_COPY}\n\n想调整哪里直接告诉我，比如“加一个历史记录”。`
      let guidance = fallbackCopy
      if (env && readyChatEnabled()) {
        const chat = await runReadyStageChat({
          query: sdkQuery,
          env,
          signal: abortController.signal,
          sessionId: input.session_id,
          history,
          maxTokens,
          ...(channel?.provider_type !== undefined ? { providerType: channel.provider_type } : {}),
          system: buildReadyChatSystem(
            buildReadyChatFacts(
              input.project_id,
              authoritativeStage,
              Boolean(env?.ANTHROPIC_BASE_URL && env?.ANTHROPIC_AUTH_TOKEN && env?.ANTHROPIC_MODEL),
            ),
          ),
          userContent: input.content,
        })
        if (chat.ok) guidance = chat.text
      }
      persistAssistant(guidance)
      streamPublisher(makeEvent(input, 'message_delta', { text: guidance }))
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 编程路径：必须真实模型，无渠道 / 密钥不可解密 / 无启用模型（且无备用渠道可切）
    // 直接抛明确错误（不留测试占位 key）
    if (!channel || !env) {
      throw new Error(
        resolution.unusableReason === 'decrypt_failed'
          ? 'API_KEY_DECRYPT_FAILED: 已配置渠道但 api_key 无法解密，请在设置中重新保存该渠道'
          : resolution.unusableReason === 'model_not_found'
            ? 'CHANNEL_MODEL_NOT_FOUND: 渠道没有启用的模型，请在设置中启用至少一个模型'
            : 'CHANNEL_NOT_FOUND: configure a model channel before using the SDK',
      )
    }

    // 编程路径模型上下文（问题 A / P1 纵深防御）：模型没有写文件/跑沙箱的工具，
    // 若只给聊天历史，它既不知道项目当前阶段，也误以为可以把 HTML 贴进聊天当交付物——
    // 于是「好了吗」会被编成「还没好」，追问多了就整段贴代码。注入真实项目阶段 +
    // 「无工具」约束，把模型从「假装交付」引导回「如实汇报 + 引导确认」。
    // authoritativeStage 已在函数顶部以 findProject 为准解析（渲染端上报仅作回退）。
    const programmingHistory: ConversationTurn[] = [buildProgrammingSystemTurn(authoritativeStage), ...history]

    await runWithRetry(input, async () => {
      // clipboard-paste P1（2026-08-29）：澄清对话带图——模型在草图澄清期即可看见用户贴的截图
      const stream = sdkQuery(input.content, { env, signal: abortController.signal, sessionId: input.session_id, history: programmingHistory, images: input.images, maxTokens })
      run.iterator = stream[Symbol.asyncIterator]()

      for (;;) {
        const next = await run.iterator.next()
        if (next.done) break

        const sdkMessage = next.value
        received.push(sdkMessage)
        const event = convertSDKMessage(input, sdkMessage)
        if (event) streamPublisher(event)

        if (sdkMessage.type === 'result') {
          break
        }
      }

      await run.iterator.return?.()
      run.iterator = undefined
    })

    persistAssistantMessages(input.session_id, received)

    // 编程路径无工具：若模型输出里出现完整 HTML / 代码块（贴代码式「交付」），
    // 追加一条显式提示。注意：无工具路径下模型贴出的代码从未落盘到项目文件，
    // 绝不能声称「代码已生成到项目文件里」——那会误导用户去预览找不存在的代码
    // （实测「右侧没有啊」正是被这条假提示带偏）。如实说明并引导到确认/预览。
    const assistantText = extractAssistantText(received)
    if (detectCodeDelivery(assistantText)) {
      const hint =
        '（你在对话里贴出的代码不会自动保存进项目文件。要生成真正可运行、可保存的版本，' +
        '请点预览区上方的「生成完整功能」确认生成；已生成的版本请直接看右侧预览。）'
      persistAssistant(hint)
      streamPublisher(makeEvent(input, 'message_delta', { text: hint }))
    }

    persistTerminalMessage(input.session_id, 'completed')
    streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))

    return { accepted: true, session_id: input.session_id, stream_started: true }
  } catch (error) {
    // 如果 cancelAgent 已按 runId 发过终态，旧任务只负责收尾，不能再覆盖 UI/日志。
    const stillOwnsRun = activeSessions.get(input.session_id)?.runId === runId
    if (!stillOwnsRun && isUserCancelled(error)) {
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    // 熔断回滚已完成收尾（T5）：阶段收敛、如实消息、completed 事件都在回滚内发过，
    // 这里不得再当普通失败处理（不覆盖阶段、不发 error 事件）。
    if (isCircuitBreakSettled(error)) {
      persistTerminalMessage(input.session_id, 'completed')
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    persistAssistantMessages(input.session_id, received)
    // 用户主动停止（T3）：终止流并落盘终态，但不作为错误向上抛——
    // 会话仍可用（activeSessions 已在 cancelAgent 清除，可继续发消息）。
    if (isUserCancelled(error)) {
      stoppedByUser = true
      publishRunEvent(input, run, 'error', { code: 'AGENT_CANCELLED' })
      persistTerminalMessage(input.session_id, 'error', { code: 'AGENT_CANCELLED', message: '用户停止了本次生成' })
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }
    const code = String(error).includes('AGENT_SESSION_BUSY') ? 'AGENT_SESSION_BUSY' : 'AGENT_SDK_ERROR'
    streamPublisher(makeEvent(input, 'error', { code }))
    persistTerminalMessage(input.session_id, 'error', {
      code,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await run.iterator?.return?.()
    const current = activeSessions.get(input.session_id)
    if (current?.runId === runId) {
      activeSessions.delete(input.session_id)
      releaseProjectRun(input.project_id, runId)
      // message-queue：run 收口——自然完成自动派发排队消息；用户停止不派发（违背停止意图）
      sessionMessageQueue.onRunComplete(input.session_id, input.request_id, stoppedByUser)
    }
  }
}

async function runWithRetry(input: AgentSendMessageInput, sdkCall: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + MAX_RETRY_DURATION_MS
  let attempt = 0

  for (;;) {
    try {
      await sdkCall()
      return
    } catch (error) {
      if (!shouldRetry(error)) throw error
      attempt += 1
      const remaining = deadline - Date.now()
      if (remaining <= 0 || attempt >= MAX_RETRIES) throw error

      if (attempt > SILENT_RETRY_THRESHOLD) {
        streamPublisher(makeEvent(input, 'retrying', { attempt, max_retries: MAX_RETRIES }))
      }

      await retrySleep(Math.min(backoffMs(attempt), remaining))
    }
  }
}

export function shouldRetry(error: unknown): boolean {
  const statusCode = getStatusCode(error)
  if (statusCode === 429 || statusCode === 529) return true
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) return true
  const message = error instanceof Error ? error.message : String(error)
  return /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(message)
}

function getStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'statusCode' in error) {
    const value = (error as { statusCode?: unknown }).statusCode
    if (typeof value === 'number') return value
  }
  const message = error instanceof Error ? error.message : String(error)
  const match = message.match(/\b(429|529|5\d\d)\b/)
  return match ? Number(match[1]) : undefined
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(0, attempt - 1), 15_000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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

/** 用户主动取消的判定：中止信号抛出的 AbortError 或查询入口的 AGENT_CANCELLED。 */
function isUserCancelled(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return String(error).includes('AGENT_CANCELLED')
}

function appendAgentMessage(sessionId: string, message: AgentMessage): void {
  appendSessionMessage(sessionId, message)
}

function persistAssistantMessages(sessionId: string, sdkMessages: SDKMessage[]): void {
  // 流式模式下每个 assistant 消息只携带一段 delta 文本，这里合并成一条完整助手消息
  const texts: string[] = []
  for (const sdk of sdkMessages) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  if (texts.length === 0) return
  appendAgentMessage(sessionId, {
    role: 'assistant',
    content: [{ type: 'text', text: texts.join('') }],
    timestamp: Date.now(),
  })
}

/**
 * 将终态（成功/失败）以 system 消息追加到会话 JSONL，
 * 使本地日志可独立还原会话结束原因，不依赖内存流事件。
 */
function persistTerminalMessage(
  sessionId: string,
  status: 'completed' | 'error',
  detail?: { code?: string; message?: string },
): void {
  const text =
    status === 'completed'
      ? '[terminal] status=completed'
      : `[terminal] status=error code=${detail?.code ?? 'AGENT_SDK_ERROR'} message=${truncate(detail?.message ?? '')}`
  appendAgentMessage(sessionId, {
    role: 'system',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}

function truncate(value: string, max = 200): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function convertSDKMessage(input: AgentSendMessageInput, sdkMessage: SDKMessage): AgentEvent | undefined {
  if (sdkMessage.type === 'assistant') {
    return makeEvent(input, 'message_delta', {
      text: extractText(sdkMessage.message?.content ?? []),
      content: sdkMessage.message?.content ?? [],
    })
  }
  if (sdkMessage.type === 'result') {
    return makeEvent(input, 'message_completed', { subtype: sdkMessage.subtype ?? 'success' })
  }
  return undefined
}

function makeEvent(input: AgentSendMessageInput, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

function publishRunEvent(input: AgentSendMessageInput, run: ActiveRun, type: AgentEvent['type'], payload: Record<string, unknown>): void {
  run.publisher(makeEvent(input, type, payload))
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

/** 合并一次运行中所有 assistant 消息的纯文本（用于交付物检测）。 */
function extractAssistantText(sdkMessages: SDKMessage[]): string {
  const texts: string[] = []
  for (const sdk of sdkMessages) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }
  return texts.join('')
}

/** 检测模型是否把完整 HTML / 代码块当成交付物贴进对话（无工具路径的典型表象）。 */
function detectCodeDelivery(text: string): boolean {
  return /<!doctype\s+html|<html[\s>]|```(?:html|jsx?|tsx?|css|json)?/i.test(text)
}

/**
 * 编程路径模型系统提示（问题 A / P1 纵深防御）。
 *
 * 模型在本路径没有任何写文件 / 跑沙箱的工具：给它的上下文必须是「如实汇报 + 引导确认」，
 * 而不是让它自由发挥——否则它既不知道项目真实阶段（编出「还没好」），
 * 又会把整段 HTML 贴进聊天冒充交付（用户看了却落不了盘）。
 */
function buildProgrammingSystemTurn(stage: WorkflowStage): ConversationTurn {
  return {
    role: 'system',
    content:
      '你在「Bloma 项目生成平台」的编程阶段协助用户。' +
      '本次对话里你没有写文件、运行代码或启动沙箱的工具——项目的生成、测试与预览都' +
      '由平台在后台自动完成，你无法改变或加速它们。' +
      `当前项目阶段：${stage}。` +
      '规则：用户询问进度时，如实基于阶段回答；不知道就说不知道，绝不假装在后台干活。' +
      `阶段为 ${stage} 时按阶段如实说明：若阶段已是 ready 或 completed，应直接告知用户「项目已经生成好了，请看右侧预览区」，不要用「还没好」「还在生成」之类措辞。` +
      '不要在回复里贴出完整 HTML/JS/CSS 代码块冒充交付物（无工具路径下这些代码不会保存' +
      '到项目文件）。要交付/生成，引导用户点预览区上方的「生成完整功能」确认；要看效果，' +
      '引导用户看右侧预览区。',
  }
}

/**
 * 真实模型查询（SSE 流式 + 多轮历史）。
 *
 * - 对齐 Anthropic Messages API / MiniMax Anthropic 兼容端点（`x-api-key` 认证头）。
 * - 保持 `AsyncGenerator<SDKMessage>` 契约：逐个 `assistant` delta → `result`，
 *   调用方（runAgent/convertSDKMessage/UI）无需改动。
 * - 每个 assistant 消息只携带一段增量文本（非累积），renderer 按 delta 拼接。
 * - 历史经 options.history 传入，消息数组 = [...history, {role:'user', content: prompt}]。
 * - PR1：options.tools 携带工具定义时请求体加 tools，并解析 tool_use 流事件
 *   （input_json_delta 累积 → content_block_stop 产出完整 tool_use block 随当轮
 *   assistant 消息 yield）；message_delta 的 stop_reason / usage 记入 result 消息。
 *   不传 tools 时行为与改造前逐字节一致。导出供 SSE 解析单测直接驱动。
 */
export async function* anthropicMessagesQuery(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  if (!options.env.PATH && !options.env.Path) throw new Error('SDK env missing PATH')
  if (options.signal.aborted) throw new Error('AGENT_CANCELLED')
  const apiKey = options.env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey || apiKey === 'test-key-main-only') {
    throw new Error('CHANNEL_NOT_FOUND: configure a model channel before using the SDK')
  }
  const baseUrl = (options.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')

  // Anthropic Messages API 的 messages 数组只允许 user/assistant 角色，
  // system 必须放顶层 system 字段。把 history 里的 system 消息提取到顶层，
  // 否则 messages 含 role:'system' 会触发 400（MVP 生成的 history 首条就是 system）。
  // PR1 扩展：options.messages 提供时数组原样作为请求 messages（Agent Loop 的
  // tool_result 回填需要把块数组 user 轮完整透传，不能走 prompt 追加拼装）；
  // content 为块数组的轮次直接透传（陷阱 11 扩展：混合 content 一律数组形态）。
  const history = options.messages ?? options.history ?? []
  const systemText = history
    .filter((turn) => turn.role === 'system')
    .map((turn) => (typeof turn.content === 'string' ? turn.content : extractText(turn.content)))
    .filter(Boolean)
    .join('\n')
  const nonSystemTurns = history.filter((turn) => turn.role !== 'system')
  // clipboard-paste P1（2026-08-29）：带图 prompt 组装 [text,...image 短引用] 块数组（畸形引用过滤防注入）
  const pastedRefs = (options.images ?? []).filter(
    (r) => r && typeof r.imageId === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/.test(r.imageId),
  )
  const promptTurn: ConversationTurn = pastedRefs.length
    ? {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          ...pastedRefs.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
        ],
      }
    : { role: 'user' as const, content: prompt }
  // 水合统一入口：无论 options.messages（loop tool_result 回填）还是 history+prompt 拼装路径，
  // 请求体里的 image 块都在此统一转 base64（最近 4 图全量，更早降级；JSONL/内存全程短引用）
  const messages = hydrateMessagesImageBlocks(
    options.messages ? nonSystemTurns : [...nonSystemTurns, promptTurn],
  )

  // 开发插件：BLOMA_SHOW_THINKING=1 时启用 extended thinking 并把思考打印到终端。
  // Anthropic 要求 max_tokens > budget_tokens；预算取一半（封顶 1024，下限 256）。
  const showThinking = isThinkingLogEnabled()
  // 模型只经 env 传入（类别路由已删硬编码默认）：缺失即配置错误，明确抛错不静默猜模型
  const model = options.env.ANTHROPIC_MODEL
  if (!model) {
    throw new Error('SDK_MODEL_NOT_CONFIGURED: SDK env 缺少 ANTHROPIC_MODEL（模型路由未解析到模型）')
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? 640000,
    stream: true,
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (systemText) body.system = systemText
  if (options.tools?.length) body.tools = options.tools
  if (showThinking) {
    // omit 渠道互斥（2026-08-28 边界收口）：Token Plan 类渠道连 thinking:disabled 都 400，
    // 开发插件 showThinking 若照发 enabled 必 400——omit 时跳过 thinking 字段并留日志。
    const devFragment = buildThinkingFragment(model, options.providerType, 'off')
    if (devFragment.omit) {
      console.warn('[anthropicMessagesQuery] omit 渠道忽略 BLOMA_SHOW_THINKING（thinking 字段会 400）')
    } else {
      const maxTokens = options.maxTokens ?? 640000
      const budget = Math.min(1024, Math.floor(maxTokens / 2))
      body.thinking = { type: 'enabled', budget_tokens: Math.max(256, budget) }
    }
  } else {
    // 推理档位（reasoning-profile 2026-08-27）：判定/校验类任务（judge 等）可经
    // options.thinkingLevel 启用 DeepSeek v4 / GLM 系思考（output_config.effort 独立
    // 深度控制，不吞 max_tokens）；缺省 off = 显式禁思考（2026-08-16 线上案例：
    // MiniMax-M3 等思考型渠道把 max_tokens 全耗在思考上，草图首试 56.5s 零字符）。
    // omit 渠道（Token Plan 类连 disabled 都 400）→ 完全不发字段，消灭 400+重试往返。
    const fragment = buildThinkingFragment(
      model,
      options.providerType,
      options.thinkingLevel ?? 'off',
    )
    if (!fragment.omit) {
      if (fragment.thinking) body.thinking = fragment.thinking
      if (fragment.output_config) body.output_config = fragment.output_config
    }
  }

  const requestInit = (): RequestInit => ({
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
  let response = await fetch(`${baseUrl}/v1/messages`, requestInit())
  if (!response.ok) {
    // 诊断增强：读取有界响应体并把可读原因打进主进程日志（仅日志，不进 SDKMessage/UI）。
    // Error message 保持原样，避免 renderer error 事件暴露技术细节。
    let detail = ''
    try {
      const text = (await response.text()).slice(0, 2000)
      detail = extractErrorMessage(text)
    } catch {
      detail = ''
    }
    // 兼容性降级：个别渠道/模型不支持显式 thinking 参数（400 且错误提到 thinking/reasoning/
    // effort/output_config）——移除 thinking 与 output_config 重试一次。覆盖 disabled 档
    // （2026-08-16 前现状）与 enabled+output_config 档（reasoning-profile 试点，审查 P2-⑥：
    // glm-5.3 anthropic 端点对 output_config.effort 的接受度未实测）。思考开关是尽力而为
    // 的优化，绝不因它阻塞生成。
    const thinkingRejected = response.status === 400
      && (body.thinking as { type?: string } | undefined) !== undefined
      && /thinking|reasoning|effort|output_config/i.test(detail)
    // vision 降级（clipboard-paste P2 兑现，r74）：带图请求遇 400 且错误提 image——
    // 模型能力缺失非瞬时故障（重试无意义），包装为用户可读引导而非裸 SDK 400。
    // 三条件缺一不可：400 + 请求确实携带 image 块 + 错误提 image（避免无关 400 误伤）。
    const imageRejected = response.status === 400
      && JSON.stringify(body.messages ?? []).includes('"type":"image"')
      && /image|multimodal|vision|多模态/i.test(detail)
    if (thinkingRejected) {
      console.warn(`[anthropicMessagesQuery] 渠道拒绝 thinking 参数（${detail}），移除该参数后重试一次`)
      delete body.thinking
      delete body.output_config
      response = await fetch(`${baseUrl}/v1/messages`, requestInit())
    } else if (imageRejected) {
      throw Object.assign(
        new Error('当前模型不支持图片输入——请用文字描述内容，或在设置中更换支持视觉的模型后重试。'),
        { statusCode: response.status },
      )
    } else {
      console.error(
        `[anthropicMessagesQuery] model request failed: HTTP ${response.status}`
        + (detail ? ` — ${detail}` : ''),
      )
      throw Object.assign(new Error(`SDK request failed with ${response.status}`), { statusCode: response.status })
    }
  }
  if (!response.ok) {
    // 降级重试后仍失败：按原语义抛错
    let detail = ''
    try {
      detail = extractErrorMessage((await response.text()).slice(0, 2000))
    } catch {
      detail = ''
    }
    console.error(
      `[anthropicMessagesQuery] model request failed: HTTP ${response.status}`
      + (detail ? ` — ${detail}` : ''),
    )
    // 降级重试后仍失败：vision 判定同样生效（thinking 降级重试不移除 image 块；重算因作用域独立）
    const imageRejectedRetry = response.status === 400
      && JSON.stringify(body.messages ?? []).includes('"type":"image"')
      && /image|multimodal|vision|多模态/i.test(detail)
    if (imageRejectedRetry) {
      throw Object.assign(
        new Error('当前模型不支持图片输入——请用文字描述内容，或在设置中更换支持视觉的模型后重试。'),
        { statusCode: response.status },
      )
    }
    throw Object.assign(new Error(`SDK request failed with ${response.status}`), { statusCode: response.status })
  }
  if (!response.body) throw new Error('SDK request body unavailable')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  // 事件类型计数（可观测性）：零正文 + 有思考 = 思考型模型把 max_tokens 预算耗在思考上
  // （2026-08-16 线上案例：草图首试 56s 零字符，重试才出正文——上层只能看到 chars=0 无法定位）
  let textDeltaCount = 0
  let thinkingDeltaCount = 0
  let otherDeltaCount = 0
  let toolUseCount = 0
  // PR1 tool use 流解析状态：input_json_delta 分片累积，content_block_stop 产出完整 tool_use
  let activeToolUse: { id: string; name: string; json: string } | null = null
  let stopReason: string | undefined
  let usageInfo: { input_tokens?: number; output_tokens?: number } | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 事件以空行分隔；按 data: 行解析（兼容 \r\n 与 [DONE] 结束标记）
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const rawEvent = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const dataLine = rawEvent
          .split('\n')
          .find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        const data = dataLine.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let parsed: {
          type?: string
          delta?: { type?: string; text?: string; thinking?: string; stop_reason?: string; partial_json?: string }
          content_block?: { type?: string; id?: string; name?: string }
          message?: { usage?: { input_tokens?: number; output_tokens?: number } }
          usage?: { input_tokens?: number; output_tokens?: number }
        }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
          continue
        }
        if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') textDeltaCount += 1
          else if (parsed.delta?.type === 'thinking_delta') thinkingDeltaCount += 1
          else otherDeltaCount += 1
        }
        // 思考过程增量：仅打印到主进程终端（BLOMA_SHOW_THINKING 时），不进 SDKMessage / 事件 / UI / JSONL
        if (
          showThinking &&
          parsed.type === 'content_block_delta' &&
          parsed.delta?.type === 'thinking_delta' &&
          typeof parsed.delta.thinking === 'string'
        ) {
          logThinking(options.sessionId, parsed.delta.thinking)
          continue
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && typeof parsed.delta.text === 'string') {
          yield {
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'text', text: parsed.delta.text }] },
          }
          continue
        }
        // ---- PR1 tool use 解析（无 tools 的请求不会出现这些事件，零行为变化）----
        if (parsed.type === 'message_start') {
          const inputTokens = parsed.message?.usage?.input_tokens
          if (typeof inputTokens === 'number') usageInfo = { ...usageInfo, input_tokens: inputTokens }
          continue
        }
        if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
          activeToolUse = {
            id: typeof parsed.content_block.id === 'string' ? parsed.content_block.id : '',
            name: typeof parsed.content_block.name === 'string' ? parsed.content_block.name : '',
            json: '',
          }
          continue
        }
        if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
          // partial_json 分片累积（陷阱：绝不能逐片 JSON.parse，必须到 content_block_stop 一次性解析）
          if (activeToolUse && typeof parsed.delta.partial_json === 'string') {
            activeToolUse.json += parsed.delta.partial_json
          }
          continue
        }
        if (parsed.type === 'content_block_stop') {
          if (activeToolUse) {
            let input: Record<string, unknown>
            try {
              input = activeToolUse.json ? (JSON.parse(activeToolUse.json) as Record<string, unknown>) : {}
            } catch {
              // 累积 JSON 损坏（流中断/渠道脏数据）：不给模型残缺输入，置空对象由调用方按
              // 参数校验错误处理——正则修补违反「代码型 JSON 不做修补」约定（陷阱 7）
              input = {}
            }
            yield {
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [{ type: 'tool_use', id: activeToolUse.id, name: activeToolUse.name, input }],
              },
            }
            toolUseCount += 1
            activeToolUse = null
          }
          continue
        }
        if (parsed.type === 'message_delta') {
          if (typeof parsed.delta?.stop_reason === 'string') stopReason = parsed.delta.stop_reason
          const outputTokens = parsed.usage?.output_tokens
          if (typeof outputTokens === 'number') usageInfo = { ...usageInfo, output_tokens: outputTokens }
          continue
        }
      }
    }
  } finally {
    // tool-only 轮次（模型只调工具不说话）是 Agent Loop 的正常形态，不算零正文
    if (textDeltaCount === 0 && toolUseCount === 0 && (thinkingDeltaCount > 0 || otherDeltaCount > 0)) {
      console.error(
        `[anthropicMessagesQuery] 零正文输出：model=${String(body.model)} max_tokens=${String(body.max_tokens)} `
        + `text_delta=${textDeltaCount} thinking_delta=${thinkingDeltaCount} other_delta=${otherDeltaCount}`
        + (thinkingDeltaCount > 0 ? '——思考型模型疑似把 max_tokens 预算耗在思考上，正文为零' : ''),
      )
    }
    try {
      reader.releaseLock()
    } catch {
      // 已取消/已释放时忽略
    }
  }

  yield {
    type: 'result',
    subtype: 'success',
    // stop_reason / usage 只在有值时携带（不传 tools 的响应也有 stop_reason——
    // end_turn 等，多带一个字段对既有消费者零影响，Agent Loop 据此判定续轮与埋点）
    ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    ...(usageInfo !== undefined ? { usage: usageInfo } : {}),
  }
}

/**
 * 请求期被动渠道回退（T9）：包住 anthropicMessagesQuery 作为模块默认 query。
 *
 * 首调命中基础设施故障（429/5xx/网络错误，见 isInfrastructureFailure）且**尚未流出
 * 任何正文**时，按 env 携带的回退上下文切备用渠道重试一次；内容型失败（截断/解析
 * 错发生在引擎层，到不了这里）、用户取消、已流出正文（重试会导致 delta 重复拼接）
 * 一律原样上抛，走调用方既有重试链。切换本身经 recordChannelSwitch 落决策日志
 * 与 [channel-switch] 系统行，绝不静默。
 */
async function* queryWithRuntimeFallback(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  const context = readFallbackContext(options.env)
  let emitted = false
  const iterator = anthropicMessagesQuery(prompt, options)[Symbol.asyncIterator]()
  try {
    for (;;) {
      const next = await iterator.next()
      if (next.done) return
      if (next.value.type === 'assistant') emitted = true
      yield next.value
    }
  } catch (error) {
    if (!context || emitted || isUserCancelledQuery(error) || !isInfrastructureFailure(error)) throw error
    const backup = pickBackupChannelEnv(context)
    if (!backup) throw error
    const statusCode = extractErrorStatusCode(error)
    recordChannelSwitch({
      context,
      reason: statusCode ? `http_${statusCode}` : 'network_error',
      to: backup,
      statusCode,
    })
    yield* anthropicMessagesQuery(prompt, {
      ...options,
      env: backup.env,
      // 备用渠道有自己的 max_tokens 上限（16384 主渠道对备用渠道可能 400）
      maxTokens: backup.channel.max_tokens ?? options.maxTokens,
      // omit 推广（审查 P2-②）：回退切换备用渠道时重派生 providerType，避免陈旧主渠道
      // omit 判定（主非 omit→备 Token Plan 仍发 disabled 再 400；主 omit→备非 omit 丢禁思考）
      providerType: backup.channel.provider_type,
    })
  } finally {
    try {
      await iterator.return?.(undefined)
    } catch {
      // 已完成/已抛错时是 no-op，忽略
    }
  }
}

/**
 * 多轮历史窗口（T4-L2）：近 N 轮原文。显式配置常量（默认 10，不静默写死）——
 * 窗口内原文承载「最近在聊什么」；长期不变量（用户约束）不靠窗口，由
 * scanSessionConstraints 全量扫描 + project.constraints 背板注入承载。
 */
export const HISTORY_WINDOW_TURNS = 10

/**
 * 读取会话 JSONL 中最近 N 轮 user/assistant 对话文本，作为 SDK 多轮历史。
 * 排除内部终态标记（[terminal]）与 system 消息——唯一例外是 [decision-card]
 * 选项行（D2 修复）：转成模型可读措辞回灌，否则模型看不到自己上轮给过什么
 * 选项，会原样重问甚至把具体选项退化成抽象类目。其余 system 行
 * （[decision]/[reconcile]/[channel-switch]）维持过滤，防止历史污染模型上下文。
 */
function loadConversationHistory(sessionId: string, limit = HISTORY_WINDOW_TURNS): ConversationTurn[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  // 本函数产出的轮次 content 一律是提取后的纯文本（loop 的块数组轮次不经此路径）
  const turns: Array<{ role: ConversationTurn['role']; content: string }> = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
      continue
    }
    if (message.role === 'system') {
      const text = extractText(message.content)
      if (text.startsWith('[decision-card]')) {
        turns.push({
          role: 'system',
          content: `【上轮已向用户出示的选项】${text.slice('[decision-card]'.length).trim()}`,
        })
      }
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = extractText(message.content)
    if (!text || text.startsWith('[terminal]')) continue
    turns.push({ role: message.role, content: text })
  }

  // 过滤「还没好/还在生成」类冗余助手轮次 + 去重连续相同助手回复（P1）：
  // 这些历史被回灌后会让模型延续「还没好/后台还在跑」的错误阶段认知（自我强化）。
  const filtered: ConversationTurn[] = []
  for (const turn of turns) {
    if (turn.role === 'assistant' && isStallReply(turn.content)) continue
    const previous = filtered[filtered.length - 1]
    if (previous && previous.role === 'assistant' && previous.content === turn.content) continue
    filtered.push(turn)
  }
  // 窗口只按 user/assistant 轮计数：decision-card 回灌行不占窗口名额，跟随相邻轮
  // 进出窗口——所附着的对话被挤出窗口时一并丢弃，防止孤立的选项行悬空无上下文
  let start = 0
  let keptTurns = 0
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].role === 'system') continue
    keptTurns++
    if (keptTurns > limit) {
      start = i + 1
      break
    }
  }
  return filtered.slice(start)
}

/** 检测「还没好/还在生成」类冗余助手回复（P1：自我强化源，需从历史中过滤）。 */
function isStallReply(text: string): boolean {
  if (text.length > 50) return false
  return /(还没好|还没呢|还没完成|还没生成完|还在生成|还在跑|还在做|还在处理|后台还在|看不到进度|看不到后台|请稍等|稍等一下|马上就好)/.test(text)
}

function shouldUseGuideAgent(stage: AgentSendMessageInput['current_stage']): boolean {
  return stage === 'clarifying' || stage === 'blocked_for_user_decision'
}

/** 用户可见文案截断（超长加省略号）。 */
function truncateForCopy(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * 发「确认整版重做」二次确认卡（防误触，2026-09-11 卡位改版）。
 * rebuild_direction 收集到方向后与 rebuild_confirm 态更新方向后共用，保证两处
 * 卡文案/选项/阶段流转一致；阶段随卡进入 blocked_for_user_decision。
 */
function publishRebuildConfirmCard(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  direction: string,
  persistAssistant: (text: string) => void,
  persistSystem: (text: string) => void,
): void {
  updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
  streamPublisher(makeEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
  const confirmCopy = `你要按「${truncateForCopy(direction, 40)}」整版重做——确认吗？重做会保留已确认的需求与草图，当前版本也会存为快照。`
  persistAssistant(confirmCopy)
  persistSystem('[decision-card] 确定整版重做｜再想想')
  streamPublisher(makeEvent(input, 'message_delta', { text: confirmCopy }))
  streamPublisher(makeEvent(input, 'user_decision_required', {
    kind: 'rebuild_confirm',
    title: '确认整版重做',
    questions: [
      { id: 'rebuild_confirm', label: '确定整版重做', description: '换一种方式重做（保留需求与草图）' },
      { id: 'rebuild_cancel', label: '再想想', description: '先不重做，保持当前版本' },
    ],
  }))
}

/**
 * MVP 就绪卡 / 二次确认卡的决策分发（2026-09-11 卡位改版）：
 * - keep            保持现状：回 ready，随后发「走向完整产物」引导卡（ready_next_steps）；
 * - optimize        局部优化：置 optimize 补充态 + 回 ready，等用户输入框说改哪里 → 局部修改；
 * - rebuild         整版重做：置 rebuild_direction 补充态 + 回 ready，等用户说重做方向 → 二次确认；
 * - rebuild_confirm 二次确认卡「确定整版重做」：取出已收集方向 → 整版重做（rebuild: true）；
 * - rebuild_cancel  二次确认卡「再想想」：清态回 ready，保持当前版本。
 * 任一决策都会把阶段收敛回 ready / iterating，绝不悬在 blocked_for_user_decision。
 */
async function resolveIterationDecisionFlow(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  sdkQuery: SDKQuery | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const decision = input.metadata?.selected_option_id
  const pendingAction = takePendingReviewAction(input.project_id)

  // P7-9b 后续批：decision_selected 埋点（就绪卡与二次确认卡同通道）
  try {
    trackAnalytics({
      request_id: input.request_id,
      event: {
        event_type: 'decision_selected',
        project_id: input.project_id,
        session_id: input.session_id,
        payload: { stage: 'mvp_review', action: decision ?? null, has_pending_action: pendingAction !== undefined },
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 埋点失败不影响决策链
  }

  // 整版重做二次确认：确定 → 按已收集方向重做（方向并入需求清单，保留草图）
  if (decision === 'rebuild_confirm' && pendingAction?.direction) {
    const direction = pendingAction.direction
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户确认整版重做',
        why: `二次确认通过，按方向「${direction}」整版重做（并入需求清单；保留草图；当前版本存快照）`,
        detail: { direction },
      },
    })
    setProgrammingEventPublisher(streamPublisher)
    // Phase 10 W4：整版重做=行为信号（J7 三通道之「同主题重做」可观测化）
    appendExperienceEvent({
      projectId: input.project_id,
      runId: input.session_id ?? input.project_id,
      eventType: 'behavior_signal',
      stage: 'ready',
      observations: [`full_redo：用户确认按方向「${direction.slice(0, 60)}」整版重做`],
    })
    updateProject(input.project_id, { current_stage: 'iterating' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'iterating' }))
    await runIterationTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      prompt: direction,
      channel_id: input.channel_id,
      query: sdkQuery,
      signal,
      rebuild: true,
    })
    return
  }

  // Phase 10 W4：一键反馈卡回传（fb_*；F 系列 4.1/4.2）——负面项=issue_hypothesis
  // 事件 + issue_reported 埋点（行为信号源=本卡）；处理完按选项语义收口（引导/输入框）。
  if (typeof decision === 'string' && decision.startsWith('fb_')) {
    setProgrammingEventPublisher(streamPublisher)
    const category =
      decision === 'fb_broken' ? 'cannot_run'
        : decision === 'fb_feature_broken' ? 'key_feature_broken'
          : decision === 'fb_unsatisfied' ? 'unsatisfied'
            : decision === 'fb_change_needs' ? 'requirement_change'
              : 'later'
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'feedback_reported',
        title: `用户反馈：${category}`,
        why: '一键反馈卡回传（行为信号，非意图识别）——负面项进 issue_hypothesis 事件与 issue_reported 埋点，供复盘成卡',
        detail: { category, source: 'delivery_feedback_card' },
      },
    })
    if (decision === 'fb_change_needs') {
      appendExperienceEvent({
        projectId: input.project_id,
        runId: input.session_id ?? input.project_id,
        eventType: 'behavior_signal',
        stage: 'ready',
        observations: ['requirement_change_requested：用户经反馈卡选择「改变需求」（去输入框表达）'],
      })
      const copy = '好，去输入框说说你想怎么改——加功能、改交互都行，我会先跟你确认再动。'
      appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
      streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      return
    }
    if (decision !== 'fb_later') {
      appendExperienceEvent({
        projectId: input.project_id,
        runId: input.session_id ?? input.project_id,
        eventType: 'issue_hypothesis',
        stage: 'ready',
        observations: [`${category}：用户经反馈卡报告（假设待证据坐实——终验/对账证据升 confirmed_failure）`],
        evidenceRefs: ['documents/test-report.json'],
      })
      try {
        trackAnalytics({
          request_id: input.request_id,
          event: {
            event_type: 'issue_reported',
            project_id: input.project_id,
            session_id: input.session_id,
            payload: { source: 'feedback_card', category },
            privacy_level: 'research_safe',
          },
        })
      } catch {
        // 埋点失败不阻断
      }
      const copy =
        category === 'cannot_run'
          ? '收到，无法运行这个问题我记下了。方便的话把看到的报错或现象发我，我来修。'
          : category === 'key_feature_broken'
            ? '收到，关键功能无效我记下了。告诉我是哪个功能、怎么操作的，我来修。'
            : '收到，效果不满意我记下了。说说哪里不符合预期，我来调。'
      appendAgentMessage(input.session_id, { role: 'assistant', content: [{ type: 'text', text: copy }], timestamp: Date.now() })
      streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
      return
    }
    // fb_later：顺势发引导卡（keep 语义收尾）
    publishReadyNextStepsCard({ request_id: input.request_id, session_id: input.session_id, project_id: input.project_id })
    return
  }

  // 局部优化 / 整版重做：置补充态 + 回 ready，等用户在输入框补充（下一句消费）
  // W5（2026-09-18 本月流水账案）：熔断→ready 的 mvp_review 卡第四选项——定向修复已知
  // 未通过项（复用入口 B 修复轮 + 终验门禁收口，与「生成完整程序」skip 分支同链；
  // 判据读 test_completed 事件兑底，回滚清掉的 test-report.json 不再断粮）。
  if (decision === 'fix_now') {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户选择先修已知未通过项',
        why: '熔断回滚后的 mvp_review 卡 fix_now：定向修复轮（不改需求清单）+ 终验门禁收口',
        detail: { via: 'circuit_mvp_review' },
      },
    })
    setProgrammingEventPublisher(streamPublisher)
    updateProject(input.project_id, { current_stage: 'repairing' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'repairing' }))
    const previewUrl = await ensureResumePreview(input)
    await runBlockedTestRepair({ ...input, preview_url: previewUrl })
    await runAgentLoopPostTesting({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      preview_url: previewUrl,
      ...(findProject(input.project_id).via_agent_loop
        ? { loop: { status: findProject(input.project_id).agent_loop_status ?? 'completed', turns: 0, finalText: '', toolCalls: [] } satisfies AgentLoopJudgeMetadata }
        : {}),
    })
    return
  }

  if (decision === 'optimize' || decision === 'rebuild') {
    const kind = decision === 'optimize' ? 'optimize' : 'rebuild_direction'
    setPendingReviewAction(input.project_id, { kind })
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: decision === 'optimize' ? '用户选择局部优化' : '用户选择整版重做（待问方向）',
        why:
          decision === 'optimize'
            ? '就绪卡点「局部优化」；聚焦输入框，等用户说改哪里后走局部修改'
            : '就绪卡点「整版重做」；聚焦输入框，等用户说重做方向后转二次确认',
      },
    })
    const copy =
      decision === 'optimize'
        ? '好，说说你想改哪里——越具体越好，比如「标题改成计算助手」「把这个按钮换成蓝色」。'
        : '好，说说你想往哪个方向重做——比如「改用卡片式布局」「把记账改成记时间」；说完我再跟你确认一次。'
    updateProject(input.project_id, { current_stage: 'ready' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
    appendAgentMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
    return
  }

  // keep：保持现状 → 回 ready + 顺势发「走向完整产物」引导卡
  if (decision === 'keep') {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户保持现状',
        why: '就绪卡点「保持现状」；不改动，进入「走向完整产物」引导',
      },
    })
    const copy = '好，那就保持这个版本。'
    updateProject(input.project_id, { current_stage: 'ready' })
    streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
    appendAgentMessage(input.session_id, {
      role: 'assistant',
      content: [{ type: 'text', text: copy }],
      timestamp: Date.now(),
    })
    streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
    // 引导卡走 programming-orchestrator 的 publish，需先接线事件发布器
    setProgrammingEventPublisher(streamPublisher)
    // Phase 10 W4：反馈卡开时先问反馈（fb_* 回传后顺势发引导卡）；off=直接引导卡（字节级现状）
    if (feedbackCardEnabled()) {
      publishDeliveryFeedbackCard({
        request_id: input.request_id,
        session_id: input.session_id,
        project_id: input.project_id,
      })
      return
    }
    publishReadyNextStepsCard({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
    })
    return
  }

  // rebuild_cancel（再想想）/ 待定状态丢失（如重启后点旧卡）
  const expired = decision === 'rebuild_confirm'
  const copy = expired
    ? '刚才的重做确认已过期，想重做的话请再说一次方向。'
    : '好，先保持现在的版本。'
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'modification_decision',
      title: expired ? '重做确认卡已过期' : '用户放弃/保持当前版本',
      why: expired
        ? '用户点了「确定整版重做」但已收集方向丢失（如重启后点旧卡），回 ready 请用户重说'
        : `决策 id=${decision ?? '空'}（如「再想想」），保持当前版本`,
    },
  })
  updateProject(input.project_id, { current_stage: 'ready' })
  streamPublisher(makeEvent(input, 'stage_changed', { stage: 'ready' }))
  appendAgentMessage(input.session_id, {
    role: 'assistant',
    content: [{ type: 'text', text: copy }],
    timestamp: Date.now(),
  })
  streamPublisher(makeEvent(input, 'message_delta', { text: copy }))
}

/**
 * L1 规则快速门——识别「修改/调整/纠错」类意图（毫秒级纯函数）。
 *
 * 用户在项目已生成后继续提的修改诉求（改、换、加、删、调整、重新等）应进入迭代
 * 重新生成流程，而非被 ready 护栏固定文案挡回。纯进度追问（好了吗 / 怎么样了）不命中。
 * 命中则直接 `modify`，不再走 L3（避免每条消息都付一次 LLM 往返的延迟）。
 */
function isModificationIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // 显式修改动词 + 否定/货不对板/重述主题类表达（"啥意思，我要音乐合成器"、"这不是我想要的"）
  // + 缩小范围类平静陈述（"我只需要理财房贷的计算器"——无动词、无语气词，
  //   线上案例：曾连漏 L1/L2 两层被固定文案挡回）。注意「不需要」不含连续子串「不要」，须单列。
  // + 「完整」类诉求（"生成完整程序""做出完整程序""要完整版"）：2026-09-05「地牢遗物」
  //   实锤——completed 阶段用户说「生成完整程序」被 L1 漏、L3 判 other，固定文案挡回。
  return /(修改|改一改|改下|改一下|调整|纠错|重做|重来|重新|完整|补全|优化|修正|不要|不需要|只需要|只要|不用|就够了|去掉|删除|删掉|加一个|加个|加上|新增|变成|换成|改成|再来|换个|不对|不是|不满意|搞错|做错|错了|偏了|货不对板|啥意思|什么意思|这不是|我要的是|我想要的是|应该是)/.test(trimmed)
}

/**
 * 「局部优化 / 整版重做」补充态的取消词（2026-09-11 卡位改版）：用户在卡上点了
 * 局部优化/整版重做后改主意，整句即取消/保持现状时清标记回 ready，不误入修改。
 * 整句锚定 + 词组可重复（覆盖「算了，不用了」类合并说法；避免「算了，改成蓝色」
 * 含取消词的真修改诉求被误拦）。
 */
const REFINE_CANCEL_RE = /^((算了|不用了|不用改了|没事|没事了|保持现状|不改了|先不改|取消|暂时不用|就这样)[吧了。.!！~～，,\s]*)+$/

/** 纯进度追问（好了吗/怎么样了）——固定「other」，绝不进修改/LLM 判定（延迟立场）。 */
const PROGRESS_QUERY_RE = /(好了吗|好了没|好没好|做完了吗|做完了没|完成了吗|完成了没|怎么样|怎么样了|进展|进度|状态)/

/** 纯应答寒暄（好的/谢谢/嗯，整句无其他信息）——不值得付一次 L3 LLM 往返。 */
const TRIVIAL_ACK_RE = /^(好的?|嗯+|哦+|噢+|行|ok|okay|不用了|谢谢|感谢|多谢|收到|了解|明白|知道了?|不错|很好|挺好的?)[。.!！~～，,\s]*$/i

/**
 * 分层意图识别——规则快门 + LLM 兜底（改造 F）。
 *
 * 纯寒暄应答 → 固定 `other`；L1（isModificationIntent）毫秒级命中 → `modify`；纯进度
 * 追问（无修改词）→ 固定 `other`；其余一律 L3 用 LLM + PRD 背板上下文判定「是否表达不满/修改诉求」。
 * L1 先于进度门是放行一致化要求：进度子串门只能拦「纯」进度句，不得吞掉含修改动词的混合句。
 * 曾经的 L2 语气标记门（疑问/否定/困惑字词）已移除：它把「平静的陈述式修改诉求」
 * （如「我只需要理财房贷的计算器」，零语气标记）永远挡在 L3 之外，形成结构性盲区；
 * ready 阶段非进度、非寒暄的陈述句本来就是修改/反馈的高发区，默认交给 LLM 判定。
 * L3 无可用渠道时保守回退 `other`（固定完成文案），不因意图判定失败而误触发需要渠道的迭代流程。
 */
async function resolveModificationIntent(opts: {
  content: string
  project_id: string
  session_id: string
  query: SDKQuery
  env: Record<string, string> | undefined
  signal: AbortSignal
  maxTokens: number
  providerType?: string
}): Promise<'modify' | 'other'> {
  if (TRIVIAL_ACK_RE.test(opts.content.trim())) return 'other'
  // 顺序修正（放行一致化）：L1 修改词表先于进度子串门——纯进度句（好了吗/怎么样了）
  // 不含修改词、行为不变；但「进度词 + 修改动词」混合句（「做完了没？把按钮换成蓝色」）
  // 此前被子串进度门整句吞掉、永远到不了 L1/L3，被固定文案挡回（放行不一致）。
  if (isModificationIntent(opts.content)) return 'modify'
  if (PROGRESS_QUERY_RE.test(opts.content)) return 'other'
  if (!opts.env) return 'other'
  const env = opts.env
  try {
    return await classifyIntentViaLlm({ ...opts, env, providerType: opts.providerType })
  } catch {
    // L3 兜底失败不阻断对话：退回固定完成文案，绝不因意图判定异常让用户卡死
    return 'other'
  }
}

/**
 * L3 LLM 兜底——判定「是否表达不满/修改诉求」。
 *
 * 单句文本无法判断用户是否不满（锚点是「当前产物 vs 用户期望」的差），所以把
 * PRD 背板的定位 + 功能项喂给模型作为上下文锚点。输出只解析一个布尔：是否表达
 * 修改/不满诉求。这是唯一会产生 LLM 往返的意图判定路径，且仅在 L2 疑似时触发。
 */
async function classifyIntentViaLlm(opts: {
  content: string
  project_id: string
  session_id: string
  query: SDKQuery
  env: Record<string, string>
  signal: AbortSignal
  maxTokens: number
  /** omit 推广（2026-08-27）：Token Plan 类渠道 off 档发 disabled 也 400——透传激活 omit（审查 P2-①） */
  providerType?: string
}): Promise<'modify' | 'other'> {
  const backplane = readPrdBackplane(opts.project_id)
  const prompt = buildIntentPrompt(backplane, opts.content)

  const texts: string[] = []
  for await (const sdk of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal,
    sessionId: opts.session_id,
    maxTokens: opts.maxTokens,
    providerType: opts.providerType,
  })) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    for (const block of sdk.message.content) {
      if (block.type === 'text' && block.text) texts.push(block.text)
    }
  }

  // 应答解析（修复死正则）：JS 的 \b 基于 \w（仅 ASCII），中文字符间永远无边界，
  // 原式 /\b(...|修改|改|...)\b/ 的中文分支全部永不命中——模型答「修改」曾被误判
  // `other`，只因恰好答 ASCII「modify」而侥幸工作。归一化（trim/小写/去尾标点）后
  // 整 token 匹配，再保留 ASCII \b 兜底吸收「modify。附带解释」类应答。
  const raw = texts.join('').trim().toLowerCase()
  const verdict = raw.replace(/[。.!！~～,，?？\s]+$/g, '')
  if (verdict === 'modify' || ['修改', '调整', '改', '重做', '重新生成', '重新做', '换'].includes(verdict)) return 'modify'
  if (/\bmodify\b/.test(raw)) return 'modify'
  return 'other'
}

/** 组装 L3 意图判定的上下文 prompt：PRD 背板定位 + 功能项 + 用户最新消息。 */
function buildIntentPrompt(backplane: { positioning: string; requirements: Array<{ id: string; description: string }> }, content: string): string {
  const items = backplane.requirements.length
    ? backplane.requirements.map((r) => `- ${r.id}: ${r.description}`).join('\n')
    : '- （无已确认功能项）'
  return [
    '你在判断用户对已生成项目的最新消息是否表达「不满或修改诉求」。',
    '',
    '【项目原本要什么（PRD 背板）】',
    `产品定位：${backplane.positioning}`,
    '功能项：',
    items,
    '',
    '【用户刚刚说】',
    content,
    '',
    '若用户在表达「货不对板 / 要改 / 要重做 / 要换 / 要更完整（如“生成完整程序”“要完整版”）/ 补充需求」请只回答「modify」；',
    '若只是「问进度 / 闲聊 / 确认状态」请只回答「other」。不要解释。',
  ].join('\n')
}

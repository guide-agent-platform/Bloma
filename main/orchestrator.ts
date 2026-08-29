import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import type {
  AgentCancelInput,
  AgentCancelResult,
  AgentEvent,
  AgentMessage,
  AgentSendMessageInput,
  AgentSendMessageResult,
  MessageContentBlock,
  SDKMessage,
  WorkflowStage,
} from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
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
  isIterationDecisionId,
  nextRequirementId,
  refineModificationDescription,
  resolveBlockedDecision,
  resumeBlockedFlow,
  runIterationTask,
  runSketchTask,
  setPendingIteration,
  setProgrammingEventPublisher,
  takeFailedIteration,
  takePendingIteration,
} from './programming-orchestrator'
import { applyNormalization, normalizeRequirementUpdate, recordRequirementNormalization } from './requirement-normalizer'
import { readPrdBackplane } from './document-engine'
import { recordDecision } from './decision-log'
import { captureConstraints, extractConstraints, readProjectConstraints, scanSessionConstraints } from './constraint-extractor'
import { isCircuitBreakSettled } from './recovery-service'
import { addScopeExclusion, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from './project-service'
import { recordSessionActivity } from './session-service'
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

let streamPublisher: StreamPublisher = () => undefined
let sdkQuery: SDKQuery = queryWithRuntimeFallback
let retrySleep: (ms: number) => Promise<void> = sleep

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  streamPublisher = publisher
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
}

function registerForegroundRun(input: AgentSendMessageInput, run: ActiveRun): void {
  if (activeSessions.has(input.session_id)) throw new Error('AGENT_SESSION_BUSY')
  acquireProjectRun(input.project_id, run.runId)
  activeSessions.set(input.session_id, run)
}

export async function runAgent(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
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
    const maxTokens = channel?.max_tokens ?? 1200
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
      content: [{ type: 'text', text: input.content }],
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

    // 修改确认卡回传（confirm/rephrase/cancel）：必须在引导路径之前拦截——
    // 此刻权威阶段是 blocked_for_user_decision，若落入 handleGuideMessage 会被
    // resolveCardAnswer 当成澄清卡答案误入草图生成。
    if (input.metadata?.source === 'card_option' && isIterationDecisionId(input.metadata.selected_option_id)) {
      await resolveIterationDecisionFlow(input, streamPublisher, sdkQuery, abortController.signal)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // U12：失败重试卡回传（selected_option_id === 'retry'）——取出上次失败诉求原样重跑，
    // 在引导路径/ready 护栏之前拦截（与修改确认卡同理），实现「一键重试」而非重新打字。
    if (input.metadata?.source === 'card_option' && input.metadata.selected_option_id === 'retry') {
      const failedPrompt = takeFailedIteration(input.project_id)
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
        const ack = `好的，按「${truncateForCopy(description, 40)}」调整草图，重新生成一版。`
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
      const intent = await resolveModificationIntent({
        content: input.content,
        project_id: input.project_id,
        session_id: input.session_id,
        query: sdkQuery,
        env,
        signal: abortController.signal,
        maxTokens,
      })
      if (intent === 'modify') {
        // 修改确认门：修改是破坏性最大的操作（整版重造），必须与草图/MVP 一样先过一道
        // 确认。直接开跑曾是「修改黑洞」的反面——误触发词表（如「换个话题」）会白白
        // 重生成整版，且整句口语被逐字并入需求清单污染 PRD 背板。确认后才进入迭代。
        const description = refineModificationDescription(input.content)
        setPendingIteration(input.project_id, { raw: input.content, description })
        recordDecision({
          project_id: input.project_id,
          session_id: input.session_id,
          entry: {
            type: 'modification_gate',
            title: '触发修改确认门',
            why: `识别到修改诉求，原话「${input.content}」清洗为「${description}」；修改是整版重造，必须先过用户确认`,
          },
        })
        updateProject(input.project_id, { current_stage: 'blocked_for_user_decision' })
        streamPublisher(makeEvent(input, 'stage_changed', { stage: 'blocked_for_user_decision' }))
        const confirmCopy = `我理解你想改：「${truncateForCopy(description, 40)}」，确认按这个方向重新生成一版吗？`
        persistAssistant(confirmCopy)
        persistSystem(`[decision-card] 对，就这样改｜不对，我重新说｜不改了`)
        streamPublisher(makeEvent(input, 'message_delta', { text: confirmCopy }))
        streamPublisher(makeEvent(input, 'user_decision_required', {
          kind: 'iteration_confirm',
          title: '确认修改方向',
          questions: [
            { id: 'confirm', label: '对，就这样改', description: '按这个修改点重新生成一版' },
            { id: 'rephrase', label: '不对，我重新说', description: '再说一次你想怎么改' },
            { id: 'cancel', label: '不改了', description: '保持当前版本' },
          ],
        }))
        persistTerminalMessage(input.session_id, 'completed')
        streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      // other（进度追问/闲聊）：固定完成文案 + 修改出口引导，避免「修改黑洞」的死胡同——
      // 用户修改诉求没命中意图词时，至少要告诉他怎么说才能触发修改。
      const guidance = `${READY_COMPLETION_COPY}\n\n想调整哪里直接告诉我，比如“加一个历史记录”。`
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
      const stream = sdkQuery(input.content, { env, signal: abortController.signal, sessionId: input.session_id, history: programmingHistory, maxTokens })
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

  if (targets.length === 0) return { cancelled: false, session_id: input.session_id }

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
  return { cancelled: true, session_id: input.session_id }
}

/** 用户主动取消的判定：中止信号抛出的 AbortError 或查询入口的 AGENT_CANCELLED。 */
function isUserCancelled(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true
  return String(error).includes('AGENT_CANCELLED')
}

function appendAgentMessage(sessionId: string, message: AgentMessage): void {
  appendJsonLine(getAgentSessionPath(sessionId), message)
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
  const messages = options.messages
    ? nonSystemTurns
    : [
        ...nonSystemTurns,
        { role: 'user' as const, content: prompt },
      ]

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
    max_tokens: options.maxTokens ?? 1200,
    stream: true,
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (systemText) body.system = systemText
  if (options.tools?.length) body.tools = options.tools
  if (showThinking) {
    const maxTokens = options.maxTokens ?? 1200
    const budget = Math.min(1024, Math.floor(maxTokens / 2))
    body.thinking = { type: 'enabled', budget_tokens: Math.max(256, budget) }
  } else {
    // 显式禁思考（2026-08-16 线上案例：MiniMax-M3 等思考型渠道默认输出 thinking_delta，
    // 且可能把 max_tokens 预算全部耗在思考上导致正文为零——草图首试 56.5s 零字符纯浪费）。
    // 本查询只透传 text_delta，思考对产物零贡献，禁掉是最优解。
    body.thinking = { type: 'disabled' }
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
    // 兼容性降级：个别渠道/模型不支持显式 thinking 参数（400 且错误提到 thinking/reasoning）——
    // 移除该参数重试一次。思考开关是尽力而为的优化，绝不因它阻塞生成。
    const thinkingRejected = response.status === 400
      && (body.thinking as { type?: string } | undefined)?.type === 'disabled'
      && /thinking|reasoning/i.test(detail)
    if (thinkingRejected) {
      console.warn(`[anthropicMessagesQuery] 渠道拒绝 thinking:disabled（${detail}），移除该参数后重试一次`)
      delete body.thinking
      response = await fetch(`${baseUrl}/v1/messages`, requestInit())
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
 * 修改确认卡三决策的分发：
 * - confirm：取出 pending，以清洗后的修改描述进入迭代（不再弹任何确认）；
 * - rephrase/cancel：终结 pending，回到 ready 并如实告知；
 * - pending 已丢失（如重启后点旧卡）：如实说明过期，回 ready 请用户重说。
 * 任一决策都会把阶段收敛回 ready / iterating，绝不悬在 blocked_for_user_decision。
 */
async function resolveIterationDecisionFlow(
  input: AgentSendMessageInput,
  streamPublisher: (event: AgentEvent) => void,
  sdkQuery: SDKQuery | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const decision = input.metadata?.selected_option_id
  const pending = takePendingIteration(input.project_id)

  if (decision === 'confirm' && pending) {
    recordDecision({
      project_id: input.project_id,
      session_id: input.session_id,
      entry: {
        type: 'modification_decision',
        title: '用户确认修改',
        why: `用户在确认卡点选「对，就这样改」，按已确认的修改点「${pending.description}」进入迭代重新生成`,
        detail: { raw: pending.raw, description: pending.description },
      },
    })
    setProgrammingEventPublisher(streamPublisher)
    await runIterationTask({
      request_id: input.request_id,
      session_id: input.session_id,
      project_id: input.project_id,
      mode: input.mode,
      prompt: pending.description,
      channel_id: input.channel_id,
      query: sdkQuery,
      signal,
    })
    return
  }

  const copy =
    decision === 'confirm'
      ? '刚才的确认卡片已过期，想修改的话请再说一次。'
      : decision === 'rephrase'
        ? '好的，你想怎么改，直接说就行。'
        : '好的，先保持现在的版本。'
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'modification_decision',
      title:
        decision === 'confirm'
          ? '确认卡已过期'
          : decision === 'rephrase'
            ? '用户要求重新描述'
            : '用户放弃本次修改',
      why:
        decision === 'confirm'
          ? '用户点了「对，就这样改」但待确认修改已丢失（如重启后点旧卡），回 ready 请用户重说'
          : decision === 'rephrase'
            ? `用户点「不对，我重新说」，放弃修改点「${pending?.description ?? '（已丢失）'}」，回 ready 等待重述`
            : `用户点「不改了」，放弃修改点「${pending?.description ?? '（已丢失）'}」，保持当前版本`,
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
  return /(修改|改一改|改下|改一下|调整|纠错|重做|重来|重新|优化|修正|不要|不需要|只需要|只要|不用|就够了|去掉|删除|删掉|加一个|加个|加上|新增|变成|换成|改成|再来|换个|不对|不是|不满意|搞错|做错|错了|偏了|货不对板|啥意思|什么意思|这不是|我要的是|我想要的是|应该是)/.test(trimmed)
}

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
    return await classifyIntentViaLlm({ ...opts, env })
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
}): Promise<'modify' | 'other'> {
  const backplane = readPrdBackplane(opts.project_id)
  const prompt = buildIntentPrompt(backplane, opts.content)

  const texts: string[] = []
  for await (const sdk of opts.query(prompt, {
    env: opts.env,
    signal: opts.signal,
    sessionId: opts.session_id,
    maxTokens: opts.maxTokens,
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
    '若用户在表达「货不对板 / 要改 / 要重做 / 要换 / 补充需求」请只回答「modify」；',
    '若只是「问进度 / 闲聊 / 确认状态」请只回答「other」。不要解释。',
  ].join('\n')
}

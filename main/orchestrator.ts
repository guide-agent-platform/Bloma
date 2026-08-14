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
import { buildSdkEnv, decryptApiKey, getChannelByIdRaw, getFirstEnabledChannel } from './channel-manager'
export { buildSdkEnv } from './channel-manager'
import { handleGuideMessage } from './guide-agent-service'
import { READY_COMPLETION_COPY, resolveBlockedDecision, resumeBlockedFlow, runIterationTask, setProgrammingEventPublisher } from './programming-orchestrator'
import { findProject } from './project-service'
import { recordSessionActivity } from './session-service'
import { isThinkingLogEnabled, logThinking } from './thinking-log'
import { extractErrorMessage } from './channel-test-error'

export type StreamPublisher = (event: AgentEvent) => void

/** 传给 SDK 的历史消息轮次（role + 纯文本 content）。 */
export interface ConversationTurn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface SDKQueryOptions {
  env: Record<string, string>
  signal: AbortSignal
  sessionId: string
  /** 多轮历史（不含当前 prompt）；anthropicMessagesQuery 追加 {role:'user', content: prompt} */
  history?: ConversationTurn[]
  /** 单次响应的最大 token 数，缺省 1200（去硬编码：由渠道配置传入） */
  maxTokens?: number
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
  persistAssistant: (text: string) => void
}

interface ActiveRun {
  abortController: AbortController
  iterator?: AsyncIterator<SDKMessage>
}

const MAX_RETRIES = 25
const MAX_RETRY_DURATION_MS = 5 * 60 * 1000
const SILENT_RETRY_THRESHOLD = 5

const activeSessions = new Map<string, ActiveRun>()
let streamPublisher: StreamPublisher = () => undefined
let sdkQuery: SDKQuery = anthropicMessagesQuery
let retrySleep: (ms: number) => Promise<void> = sleep

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  streamPublisher = publisher
}

export function setSDKQueryForTests(query: SDKQuery): void {
  sdkQuery = query
}

export function resetSDKQueryForTests(): void {
  sdkQuery = anthropicMessagesQuery
}

/** 生产侧 query 访问器：读取模块级 sdkQuery（默认 anthropicMessagesQuery），供 ipc.ts 透传给 runMvpTask。 */
export function getSdkQuery(): SDKQuery {
  return sdkQuery
}

export function setRetrySleepForTests(sleepFn: (ms: number) => Promise<void>): void {
  retrySleep = sleepFn
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export async function runAgent(input: AgentSendMessageInput): Promise<AgentSendMessageResult> {
  if (activeSessions.has(input.session_id)) {
    throw new Error('AGENT_SESSION_BUSY')
  }

  const abortController = new AbortController()
  const run: ActiveRun = { abortController }
  activeSessions.set(input.session_id, run)

  const received: SDKMessage[] = []

  try {
    // 未显式指定 channel_id 时自动回退到第一个启用的本项目渠道（否则引导永远走规则路由）
    const channel = input.channel_id
      ? getChannelByIdRaw(input.channel_id)
      : getFirstEnabledChannel()
    // 模型名用 name（真实模型 ID）：id 是渠道内唯一标识（多 Agent / 识图-编程模型区分用），不能传给 API
    const model = channel?.models.find((item) => item.enabled)?.name ?? 'claude-sonnet-4-6'
    let env: Record<string, string> | undefined
    let channelKeyUnusable = false
    if (channel) {
      try {
        const apiKey = decryptApiKey(channel.api_key)
        env = buildSdkEnv(apiKey, channel.base_url, model, channel.provider_type)
      } catch {
        // 渠道密钥不可解密（safeStorage 密钥变更 / 跨平台迁移的 ciphertext）：
        // 该渠道视为不可用，引导路径回退规则路由，编程路径报可读错误。
        channelKeyUnusable = true
        console.error(`[runAgent] channel ${channel.id} (${channel.name}) api_key 无法解密，该渠道不可用`)
      }
    }
    const maxTokens = channel?.max_tokens ?? 1200
    // 多轮历史：读取已有对话轮次（不含本次 user 消息，稍后追加），支撑 SDK 多轮上下文
    const history = loadConversationHistory(input.session_id)

    appendAgentMessage(input.session_id, {
      role: 'user',
      content: [{ type: 'text', text: input.content }],
      timestamp: Date.now(),
    })
    // 维护会话索引并回填 Project.last_session_id，支撑历史对话回访恢复
    recordSessionActivity(input.session_id, input.project_id)

    // 权威项目阶段（工作项 1）：以项目存储为准，渲染端上报阶段仅为回退。
    // 渲染端 workflowStageAtom 由 stage_changed 事件驱动，MVP/测试/ready 阶段的事件
    // 若丢失或乱序会导致渲染端阶段滞后（如项目已 ready 仍上报 sketch_ready），
    // 护栏/引导路径/编程路径注入必须统一读 findProject 的真实阶段，避免据此错报进度。
    let authoritativeStage: WorkflowStage = input.current_stage
    try {
      authoritativeStage = findProject(input.project_id).current_stage
    } catch {
      // 项目索引缺失（如测试环境）时退回渲染端上报的阶段
    }

    // 助手回复落盘（模型路径与规则路径共用，保证回访恢复时对话完整）
    const persistAssistant = (text: string) =>
      appendAgentMessage(input.session_id, {
        role: 'assistant',
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
        await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant)
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

    if (shouldUseGuideAgent(authoritativeStage)) {
      await handleGuideMessage(input, streamPublisher, guideOptions, persistAssistant)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 转移阶段护栏（问题 A / P1）：sketch_ready 阶段的消息不得落入无工具的编程路径。
    // 后端已产出草图，模型拿不到工具上下文只会「假装交付」/把 HTML 贴进聊天。
    // 这里直接引导用户走「确认草图」按钮进 MVP 流程（调整走点选纠错或继续对话）。
    // 判断用权威阶段：项目已推进到 ready 时（渲染端阶段可能滞后）不得误入此护栏，
    // 否则会把「项目已好」错报成「还在草图阶段」。
    if (authoritativeStage === 'sketch_ready') {
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
      if (isModificationIntent(input.content)) {
        // 让编程管线沿用与 runAgent 相同的流式发布通道，确保迭代事件上屏
        setProgrammingEventPublisher(streamPublisher)
        await runIterationTask({
          request_id: input.request_id,
          session_id: input.session_id,
          project_id: input.project_id,
          mode: input.mode,
          prompt: input.content,
          channel_id: input.channel_id,
          query: sdkQuery,
        })
        return { accepted: true, session_id: input.session_id, stream_started: true }
      }
      const guidance = READY_COMPLETION_COPY
      persistAssistant(guidance)
      streamPublisher(makeEvent(input, 'message_delta', { text: guidance }))
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 编程路径：必须真实模型，无渠道 / 密钥不可解密直接抛明确错误（不留测试占位 key）
    if (!channel || !env) {
      throw new Error(
        channelKeyUnusable
          ? 'API_KEY_DECRYPT_FAILED: 已配置渠道但 api_key 无法解密，请在设置中重新保存该渠道'
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
    persistAssistantMessages(input.session_id, received)
    const code = String(error).includes('AGENT_SESSION_BUSY') ? 'AGENT_SESSION_BUSY' : 'AGENT_SDK_ERROR'
    streamPublisher(makeEvent(input, 'error', { code }))
    persistTerminalMessage(input.session_id, 'error', {
      code,
      message: error instanceof Error ? error.message : String(error),
    })
    throw error
  } finally {
    await run.iterator?.return?.()
    activeSessions.delete(input.session_id)
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
  const run = activeSessions.get(input.session_id)
  if (!run) return { cancelled: false, session_id: input.session_id }

  run.abortController.abort(input.reason)
  await run.iterator?.return?.()
  activeSessions.delete(input.session_id)
  return { cancelled: true, session_id: input.session_id }
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
 */
async function* anthropicMessagesQuery(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
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
  const history = options.history ?? []
  const systemText = history
    .filter((turn) => turn.role === 'system')
    .map((turn) => turn.content)
    .filter(Boolean)
    .join('\n')
  const messages = [
    ...history.filter((turn) => turn.role !== 'system'),
    { role: 'user' as const, content: prompt },
  ]

  // 开发插件：BLOMA_SHOW_THINKING=1 时启用 extended thinking 并把思考打印到终端。
  // Anthropic 要求 max_tokens > budget_tokens；预算取一半（封顶 1024，下限 256）。
  const showThinking = isThinkingLogEnabled()
  const body: Record<string, unknown> = {
    model: options.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    max_tokens: options.maxTokens ?? 1200,
    stream: true,
    messages,
  }
  if (systemText) body.system = systemText
  if (showThinking) {
    const maxTokens = options.maxTokens ?? 1200
    const budget = Math.min(1024, Math.floor(maxTokens / 2))
    body.thinking = { type: 'enabled', budget_tokens: Math.max(256, budget) }
  }

  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
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
          delta?: { type?: string; text?: string; thinking?: string }
          content_block?: { type?: string }
        }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
          continue
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
        }
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // 已取消/已释放时忽略
    }
  }

  yield { type: 'result', subtype: 'success' }
}

/**
 * 读取会话 JSONL 中最近 N 轮 user/assistant 对话文本，作为 SDK 多轮历史。
 * 排除内部终态标记（[terminal]）与 system 消息，防止历史污染模型上下文。
 */
function loadConversationHistory(sessionId: string, limit = 20): ConversationTurn[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  const turns: ConversationTurn[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let message: AgentMessage
    try {
      message = JSON.parse(line) as AgentMessage
    } catch {
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
  return filtered.slice(Math.max(0, filtered.length - limit))
}

/** 检测「还没好/还在生成」类冗余助手回复（P1：自我强化源，需从历史中过滤）。 */
function isStallReply(text: string): boolean {
  if (text.length > 50) return false
  return /(还没好|还没呢|还没完成|还没生成完|还在生成|还在跑|还在做|还在处理|后台还在|看不到进度|看不到后台|请稍等|稍等一下|马上就好)/.test(text)
}

function shouldUseGuideAgent(stage: AgentSendMessageInput['current_stage']): boolean {
  return stage === 'clarifying' || stage === 'blocked_for_user_decision'
}

/**
 * 识别「修改/调整/纠错」类意图（ready/completed 阶段护栏的意图分流）。
 *
 * 用户在项目已生成后继续提的修改诉求（改、换、加、删、调整、重新等）应进入迭代
 * 重新生成流程，而非被 ready 护栏固定文案挡回。纯进度追问（好了吗 / 怎么样了）不命中。
 */
function isModificationIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  // 显式修改动词 + 否定/货不对板/重述主题类表达（"啥意思，我要音乐合成器"、"这不是我想要的"）。
  // 纯进度追问（好了吗/怎么样了）不含这些词，不会被误判为修改意图。
  return /(修改|改一改|改下|改一下|调整|纠错|重做|重来|重新|优化|修正|不要|去掉|删除|删掉|加一个|加个|加上|新增|变成|换成|改成|再来|换个|不对|不是|不满意|搞错|做错|错了|偏了|货不对板|啥意思|什么意思|这不是|我要的是|我想要的是|应该是)/.test(trimmed)
}

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
} from '../shared/types'
import { getAgentSessionPath } from '../storage/config-paths'
import { appendJsonLine } from '../storage/json-store'
import { decryptApiKey, getChannelByIdRaw } from './channel-manager'
import { handleGuideMessage } from './guide-agent-service'
import { recordSessionActivity } from './session-service'

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

export function setRetrySleepForTests(sleepFn: (ms: number) => Promise<void>): void {
  retrySleep = sleepFn
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

/** SDK 子进程环境白名单：仅透传运行 SDK 所需的基础环境，避免宿主机 ANTHROPIC_/CLAUDE_ 历史配置污染 Agent 渠道。 */
const SDK_ENV_ALLOWLIST = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SystemRoot',
  'WINDIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
] as const

export function buildSdkEnv(apiKey: string, baseUrl: string, model: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of SDK_ENV_ALLOWLIST) {
    const value = (process.env as Record<string, string>)[key]
    if (value !== undefined) env[key] = value
  }
  env.ANTHROPIC_AUTH_TOKEN = apiKey
  env.ANTHROPIC_BASE_URL = baseUrl
  env.ANTHROPIC_MODEL = model
  return env
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
    const channel = input.channel_id ? getChannelByIdRaw(input.channel_id) : undefined
    const model = channel?.models.find((item) => item.enabled)?.id ?? 'claude-sonnet-4-6'
    let env: Record<string, string> | undefined
    if (channel) {
      const apiKey = decryptApiKey(channel.api_key)
      env = buildSdkEnv(apiKey, channel.base_url, model)
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

    if (shouldUseGuideAgent(input.current_stage)) {
      // 引导路径：渠道可用则切真实模型（模型不可用/解析失败回退规则），无渠道直接走规则，不阻塞澄清
      const guideOptions: GuideModelOptions | undefined = env
        ? {
            query: sdkQuery,
            env,
            signal: abortController.signal,
            sessionId: input.session_id,
            history,
            maxTokens,
            persistAssistant: (text: string) =>
              appendAgentMessage(input.session_id, {
                role: 'assistant',
                content: [{ type: 'text', text }],
                timestamp: Date.now(),
              }),
          }
        : undefined
      await handleGuideMessage(input, streamPublisher, guideOptions)
      persistTerminalMessage(input.session_id, 'completed')
      streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))
      return { accepted: true, session_id: input.session_id, stream_started: true }
    }

    // 编程路径：必须真实模型，无渠道直接抛明确错误（不留测试占位 key）
    if (!channel || !env) {
      throw new Error('CHANNEL_NOT_FOUND: configure a model channel before using the SDK')
    }

    await runWithRetry(input, async () => {
      const stream = sdkQuery(input.content, { env, signal: abortController.signal, sessionId: input.session_id, history, maxTokens })
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
  const messages = [...(options.history ?? []), { role: 'user', content: prompt }]
  const response = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: options.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: options.maxTokens ?? 1200,
      stream: true,
      messages,
    }),
    signal: options.signal,
  })
  if (!response.ok) {
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
        let parsed: { type?: string; delta?: { type?: string; text?: string } }
        try {
          parsed = JSON.parse(data) as typeof parsed
        } catch {
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
  return turns.slice(Math.max(0, turns.length - limit))
}

function shouldUseGuideAgent(stage: AgentSendMessageInput['current_stage']): boolean {
  return stage === 'clarifying' || stage === 'blocked_for_user_decision'
}

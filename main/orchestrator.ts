import { randomUUID } from 'node:crypto'
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

type StreamPublisher = (event: AgentEvent) => void
type SDKQuery = (prompt: string, options: SDKQueryOptions) => AsyncIterable<SDKMessage>

interface SDKQueryOptions {
  env: Record<string, string>
  signal: AbortSignal
  sessionId: string
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
let sdkQuery: SDKQuery = mockSDKQuery
let retrySleep: (ms: number) => Promise<void> = sleep

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  streamPublisher = publisher
}

export function setSDKQueryForTests(query: SDKQuery): void {
  sdkQuery = query
}

export function setRetrySleepForTests(sleepFn: (ms: number) => Promise<void>): void {
  retrySleep = sleepFn
}

export function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId)
}

export function buildSdkEnv(apiKey: string, baseUrl: string, model: string): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  env.ANTHROPIC_AUTH_TOKEN = apiKey
  env.ANTHROPIC_BASE_URL = baseUrl
  env.ANTHROPIC_MODEL = model
  delete env.ANTHROPIC_CUSTOM_HEADERS
  delete env.CLAUDE_CODE_DISABLE_AUTO_UPDATE
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
    let env: Record<string, string>
    if (channel) {
      const apiKey = decryptApiKey(channel.api_key)
      env = buildSdkEnv(apiKey, channel.base_url, model)
    } else {
      env = buildSdkEnv('test-key-main-only', 'https://api.anthropic.com', model)
    }

    appendAgentMessage(input.session_id, {
      role: 'user',
      content: [{ type: 'text', text: input.content }],
      timestamp: Date.now(),
    })

    await runWithRetry(input, async () => {
      const stream = sdkQuery(input.content, { env, signal: abortController.signal, sessionId: input.session_id })
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
    streamPublisher(makeEvent(input, 'completed', { subtype: 'success' }))

    return { accepted: true, session_id: input.session_id, stream_started: true }
  } catch (error) {
    persistAssistantMessages(input.session_id, received)
    streamPublisher(makeEvent(input, 'error', {
      code: String(error).includes('AGENT_SESSION_BUSY') ? 'AGENT_SESSION_BUSY' : 'AGENT_SDK_ERROR',
    }))
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
  for (const sdk of sdkMessages) {
    if (sdk.type !== 'assistant' || !sdk.message) continue
    appendAgentMessage(sessionId, {
      role: 'assistant',
      content: sdk.message.content,
      timestamp: Date.now(),
    })
  }
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

async function* mockSDKQuery(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  if (!options.env.PATH && !options.env.Path) throw new Error('SDK env missing PATH')
  if (options.signal.aborted) throw new Error('AGENT_CANCELLED')
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `收到需求：${prompt.slice(0, 80)}` }],
    },
  }
  if (options.signal.aborted) throw new Error('AGENT_CANCELLED')
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '。Sprint 0 已建立工程底座，后续可接入真实 SDK。' }],
    },
  }
  yield { type: 'result', subtype: 'success' }
}

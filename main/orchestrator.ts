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
import { decryptApiKey, getChannelById } from './channel-manager'

type StreamPublisher = (event: AgentEvent) => void

interface ActiveRun {
  abortController: AbortController
  iterator?: AsyncIterator<SDKMessage>
}

const activeSessions = new Map<string, ActiveRun>()
let streamPublisher: StreamPublisher = () => undefined

export function setAgentStreamPublisher(publisher: StreamPublisher): void {
  streamPublisher = publisher
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
    const channel = input.channel_id ? getChannelById(input.channel_id) : undefined
    const model = channel?.models.find((item) => item.enabled)?.id ?? 'claude-sonnet-4-6'
    if (channel) {
      const apiKey = decryptApiKey(channel.api_key)
      buildSdkEnv(apiKey, channel.base_url, model)
    } else {
      buildSdkEnv('test-key-main-only', 'https://api.anthropic.com', model)
    }

    appendAgentMessage(input.session_id, {
      role: 'user',
      content: [{ type: 'text', text: input.content }],
      timestamp: Date.now(),
    })

    const stream = mockSDKQuery(input.content, abortController.signal)
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

async function* mockSDKQuery(prompt: string, signal: AbortSignal): AsyncGenerator<SDKMessage> {
  if (signal.aborted) throw new Error('AGENT_CANCELLED')
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `收到需求：${prompt.slice(0, 80)}` }],
    },
  }
  if (signal.aborted) throw new Error('AGENT_CANCELLED')
  yield {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: '。Sprint 0 已建立工程底座，后续可接入真实 SDK。' }],
    },
  }
  yield { type: 'result', subtype: 'success' }
}

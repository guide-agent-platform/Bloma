import type { StreamFn } from '@earendil-works/pi-agent-core'
import { withAbort, type AgentLoopInput } from './agent-loop'
import type { SDKMessage } from '../../../shared/types'
import { emptyAssistant, toTransportTurns, piToolArguments } from './pi-messages'

async function* abortable(source: AsyncIterable<SDKMessage>, signal: AbortSignal) {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const next = await withAbort(iterator.next(), signal)
      if (next.done) return
      yield next.value
    }
  } finally { void iterator.return?.().catch(() => undefined) }
}

/** Keep routing, real-request admission, usage ledger and image hydration in the
 * existing transport. Neither Pi auth storage nor its provider HTTP layer is used.
 * No prompts or completed tools are replayed by this bridge on failure. */
export function createPiTransport(input: AgentLoopInput, lifecycle: {
  beforeRequest(auxiliary: boolean): void
  isCompacting(): boolean
  onUsage(inputTokens: number, outputTokens: number, auxiliary: boolean): void
  onFailure(error: unknown): void
}): StreamFn {
  return async (model, context, options) => {
    const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools } = await import('@earendil-works/pi-ai')
    const stream = createAssistantMessageEventStream()
    const message = emptyAssistant(model)
    void (async () => {
      try {
        const auxiliary = lifecycle.isCompacting()
        lifecycle.beforeRequest(auxiliary)
        const signal = options?.signal ? AbortSignal.any([input.signal, options.signal]) : input.signal
        signal.throwIfAborted()
        stream.push({ type: 'start', partial: message })
        let finished = false
        for await (const sdk of abortable(input.query('', {
          env: input.env, signal, sessionId: input.sessionId,
          messages: toTransportTurns({ messages: context.messages, systemPrompt: getCurrentSystemPrompt(context.messages) }),
          tools: getCurrentTools(context.messages).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters as unknown as Record<string, unknown> })),
          maxTokens: Math.min(input.maxTokens, options?.maxTokens ?? input.maxTokens),
          temperature: input.temperature, providerType: input.providerType,
          thinkingLevel: input.thinkingLevel ?? (input.env.BLOMA_LOOP_THINKING === 'off' ? 'off' : 'low'),
          accounting: { projectId: input.projectId, runId: input.requestId, parentSessionId: input.parentSessionId,
            role: input.accountingRole ?? 'orchestrator', scope: auxiliary ? 'handoff' : 'loop' },
        }), signal)) {
          signal.throwIfAborted()
          if (sdk.type === 'assistant') {
            for (const block of sdk.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                const last = message.content.at(-1)
                if (last?.type === 'text') last.text += block.text
                else message.content.push({ type: 'text', text: block.text })
                const index = message.content.length - 1
                stream.push({ type: 'text_delta', contentIndex: index, delta: block.text, partial: message })
              } else if (block.type === 'tool_use' && block.id && block.name) {
                const index = message.content.length
                const toolCall = { type: 'toolCall' as const, id: block.id, name: block.name, arguments: piToolArguments(block.input ?? {}) }
                message.content.push(toolCall)
                stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: message })
              }
            }
          } else if (sdk.type === 'thinking' && sdk.thinking) {
            if (!auxiliary) input.publish('thinking_delta', { text: sdk.thinking })
          } else if (sdk.type === 'result') {
            finished = true
            message.stopReason = sdk.stop_reason === 'max_tokens' ? 'length'
              : message.content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop'
            message.usage.input = sdk.usage?.input_tokens ?? 0
            message.usage.output = sdk.usage?.output_tokens ?? 0
            message.usage.cacheRead = sdk.usage?.cache_read_input_tokens ?? 0
            message.usage.cacheWrite = sdk.usage?.cache_creation_input_tokens ?? 0
            message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite
            if (sdk.usage) lifecycle.onUsage(message.usage.totalTokens - message.usage.output, message.usage.output, auxiliary)
          }
        }
        if (!finished) throw new Error('PI_TRANSPORT_INCOMPLETE: response ended without a result')
        if (!message.content.length && message.stopReason !== 'length') throw new Error('EMPTY_MODEL_STREAM')
        stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message })
      } catch (error) {
        lifecycle.onFailure(error)
        message.stopReason = input.signal.aborted || options?.signal?.aborted ? 'aborted' : 'error'
        message.errorMessage = error instanceof Error ? error.message : String(error)
        stream.push({ type: 'error', reason: message.stopReason, error: message })
      } finally { stream.end(message) }
    })()
    return stream
  }
}

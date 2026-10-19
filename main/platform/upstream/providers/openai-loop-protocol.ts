import type { StreamAdapter, StreamEvent } from './types'
import { normalizeHttpUsage } from '../../llm/request-ledger'

/** Adapted from Proma bf3e98c openai-adapter.ts. Preserve tool indexes for interleaved
 * deltas, final usage/cache accounting, and Bloma's full tool-result history. */
export const OPENAI_LOOP_ADAPTER: StreamAdapter = {
  parseSSELine(line) {
    const chunk = JSON.parse(line)
    const events: StreamEvent[] = []
    if (chunk.error) return [{ type: 'error', error: String(chunk.error.message ?? 'OPENAI_STREAM_ERROR') }]
    const delta = chunk.choices?.[0]?.delta
    if (delta?.content) events.push({ type: 'chunk', delta: delta.content })
    if (delta?.reasoning_content) events.push({ type: 'reasoning', delta: delta.reasoning_content })
    for (const call of delta?.tool_calls ?? []) {
      const metadata = { outputIndex: `oa:${call.index ?? 0}` }
      if (call.function?.name) events.push({ type: 'tool_call_start', toolCallId: call.id ?? `tc_${call.index ?? 0}`, toolName: call.function.name, metadata })
      if (call.function?.arguments) events.push({ type: 'tool_call_delta', toolCallId: call.id ?? '', argumentsDelta: call.function.arguments, metadata })
    }
    const reason = chunk.choices?.[0]?.finish_reason
    if (reason) events.push({ type: 'done', stopReason: reason === 'tool_calls' ? 'tool_use' : reason === 'stop' ? 'end_turn' : reason === 'length' ? 'max_tokens' : reason })
    const usage = normalizeHttpUsage(chunk.usage, true)
    if (usage) events.push({ type: 'usage', inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      cacheReadInputTokens: usage.cache_read_input_tokens })
    return events
  },
}

interface Block { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; source?: { media_type?: string; data?: string } }
const textOf = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value)
  ? value.map(block => block.text ?? '').join('') : JSON.stringify(value ?? '')

/** Input is the fully hydrated Anthropic-shaped body used by the native agent loop. */
export function openAiLoopBody(body: Record<string, unknown>): Record<string, unknown> {
  const model = String(body.model).toLowerCase()
  if ((model === 'glm-5.3' || model === 'glm-5.3-flash') && (body.thinking as { type?: string } | undefined)?.type === 'disabled') {
    // Regular API returned HTTP 400/1210: this model always thinks. Fail locally
    // rather than paying for a retry or silently changing the requested setting.
    throw new Error(`MODEL_THINKING_OFF_UNSUPPORTED: ${model} 不支持关闭思考，请选择 low、high 或 max。`)
  }
  const messages: Record<string, unknown>[] = []
  if (body.system) messages.push({ role: 'system', content: body.system })
  for (const turn of body.messages as Array<{ role: string; content: string | Block[] }>) {
    if (typeof turn.content === 'string') { messages.push(turn); continue }
    const blocks = turn.content
    const calls = blocks.filter(block => block.type === 'tool_use')
    const results = blocks.filter(block => block.type === 'tool_result')
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const thinking = blocks.filter(block => block.type === 'thinking').map(block => block.thinking ?? '').join('')
    const images = blocks.filter(block => block.type === 'image').map(block => ({ type: 'image_url', image_url: {
      url: `data:${block.source?.media_type};base64,${block.source?.data}` } }))
    if (turn.role === 'assistant') {
      messages.push({ role: 'assistant', content: text || null, ...(thinking ? { reasoning_content: thinking } : {}),
        ...(calls.length ? { tool_calls: calls.map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } })) } : {}) })
    } else {
      // Tool results must precede any following user text.
      for (const result of results) messages.push({ role: 'tool', tool_call_id: result.tool_use_id, content: textOf(result.content) })
      if (text || images.length) messages.push({ role: turn.role, content: images.length ? [{ type: 'text', text }, ...images] : text })
    }
  }
  const thinking = body.thinking as { type?: string } | undefined
  const effort = (body.output_config as { effort?: string } | undefined)?.effort
  return { model: body.model, max_tokens: body.max_tokens, stream: true, stream_options: { include_usage: true }, messages,
    ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
    ...(thinking ? { thinking: { type: thinking.type === 'disabled' ? 'disabled' : 'enabled' } } : {}),
    ...(thinking?.type !== 'disabled' && effort ? { reasoning_effort: effort } : {}),
    ...(Array.isArray(body.tools) && body.tools.length ? { tools: body.tools.map(tool => ({ type: 'function', function: {
      name: tool.name, description: tool.description, parameters: tool.input_schema } })) } : {}) }
}

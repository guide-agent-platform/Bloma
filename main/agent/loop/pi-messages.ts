import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { AssistantMessage, Context, ImageContent, Message, Model, JsonObject } from '@earendil-works/pi-ai'
import { parseToolCallArguments } from '@earendil-works/pi-ai'
import type { ConversationTurn } from '../../orchestration/stages/orchestration-contracts'
import type { MessageContentBlock, PastedImageRef } from '../../../shared/types'

/** The bridge carries opaque image references, never actual image bytes.
 * Only the existing transport's authenticated attachment hydration reads pixels. */
const IMAGE_REF = 'bloma-image-ref:'
/** SDK 1.x requires actual JSON, not an unchecked Record<string, unknown>. */
export function piToolArguments(input: Record<string, unknown>): JsonObject {
  try {
    const parsed = parseToolCallArguments(JSON.stringify(input))
    if (parsed.argumentsError) throw new Error('invalid tool object')
    return parsed.arguments
  } catch { throw new Error('PI_TOOL_ARGUMENTS_NOT_JSON') }
}
export function piImage(ref: PastedImageRef): ImageContent {
  // Pi 1.x normalizes image blocks as base64 even with resize disabled. Encode
  // the opaque reference, never the image bytes. Only Bloma hydrates real images.
  return { type: 'image', data: Buffer.from(IMAGE_REF + ref.imageId, 'utf8').toString('base64'), mimeType: ref.media_type }
}

export function emptyAssistant(model: Model<string>): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: 'stop', timestamp: Date.now(), usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } }
}

function userBlocks(content: Message['content']): MessageContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return content.flatMap((block): MessageContentBlock[] => {
    if (block.type === 'text') return [{ type: 'text', text: block.text }]
    if (block.type === 'image') {
      // Existing 0.85.1 sessions keep their original plain references.
      const reference = block.data.startsWith(IMAGE_REF) ? block.data : Buffer.from(block.data, 'base64').toString('utf8')
      if (!reference.startsWith(IMAGE_REF)) throw new Error('PI_IMAGE_REFERENCE_REQUIRED')
      return [{ type: 'image', imageId: reference.slice(IMAGE_REF.length), media_type: block.mimeType }]
    }
    return []
  })
}

/** Pi owns the transcript. Anthropic-style SDK transport is only a wire adapter. */
export function toTransportTurns(context: Pick<Context, 'messages' | 'systemPrompt'>): ConversationTurn[] {
  const turns: ConversationTurn[] = context.systemPrompt ? [{ role: 'system', content: context.systemPrompt }] : []
  // Recovery/compaction can omit an assistant while retaining its tool results.
  // Only project complete pairs from the same assistant round to the provider.
  // Native history and host receipts remain untouched; never replay a tool or
  // fabricate a successful result to repair a wire-protocol inconsistency.
  const pairs = new Map<number, Set<string>>(), results = new Set<number>()
  let round = -1, pending = new Map<string, string>()
  for (const [index, message] of context.messages.entries()) {
    if (message.role === 'assistant') {
      round = index; pending = new Map()
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue
      for (const block of message.content) if (block.type === 'toolCall') pending.set(block.id, block.name)
    } else if (message.role === 'toolResult' && pending.get(message.toolCallId) === message.toolName) {
      pending.delete(message.toolCallId); results.add(index)
      const ids = pairs.get(round) ?? new Set<string>(); ids.add(message.toolCallId); pairs.set(round, ids)
    }
  }
  for (const [index, message] of context.messages.entries()) {
    if (message.role === 'assistant') {
      if (message.stopReason === 'error' || message.stopReason === 'aborted') continue
      const remaining = new Set(pairs.get(index))
      const content: MessageContentBlock[] = message.content.flatMap((block): MessageContentBlock[] =>
        block.type === 'text' ? [{ type: 'text', text: block.text }]
          : block.type === 'toolCall' && remaining.delete(block.id) ? [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }]
            : [])
      if (content.length) turns.push({ role: 'assistant', content })
    } else if (message.role === 'user') {
      turns.push({ role: 'user', content: userBlocks(message.content) })
    } else if (message.role === 'toolResult') {
      if (!results.has(index)) continue
      const block: MessageContentBlock = { type: 'tool_result', tool_use_id: message.toolCallId,
        content: message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), is_error: message.isError }
      const last = turns.at(-1)
      const images = userBlocks(message.content).filter(b => b.type === 'image')
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.some(b => b.type === 'tool_result')) last.content.push(block, ...images)
      else turns.push({ role: 'user', content: [block, ...images] })
    }
  }
  return turns
}

/** One-time import of pre-Pi audit history. Drop dangling tool calls rather than
 * creating invalid replay requests or executing a historical side effect. */
export function importLegacyTurns(turns: ConversationTurn[], model: Model<string>): Message[] {
  const paired = new Set(turns.flatMap(turn => Array.isArray(turn.content)
    ? turn.content.filter(b => b.type === 'tool_result' && b.tool_use_id).map(b => b.tool_use_id!) : []))
  const result: Message[] = []
  const names = new Map<string, string>()
  for (const turn of turns) {
    if (turn.role === 'system') continue
    const blocks = typeof turn.content === 'string' ? [{ type: 'text' as const, text: turn.content }] : turn.content
    if (turn.role === 'assistant') {
      const message = emptyAssistant(model)
      for (const block of blocks) {
        if (block.type === 'text' && block.text) message.content.push({ type: 'text', text: block.text })
        if (block.type === 'tool_use' && block.id && block.name && paired.has(block.id)) {
          names.set(block.id, block.name)
          message.content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: piToolArguments(block.input ?? {}) })
        }
      }
      message.stopReason = message.content.some(b => b.type === 'toolCall') ? 'toolUse' : 'stop'
      if (message.content.length) result.push(message)
    } else {
      const content: Array<{ type: 'text'; text: string } | ImageContent> = []
      for (const block of blocks) {
        if (block.type === 'tool_result' && block.tool_use_id && names.has(block.tool_use_id)) {
          result.push({ role: 'toolResult', toolCallId: block.tool_use_id, toolName: names.get(block.tool_use_id)!,
            content: [{ type: 'text', text: block.content ?? '' }], isError: block.is_error === true, timestamp: Date.now() })
          names.delete(block.tool_use_id)
        } else if (block.type === 'text' && block.text) content.push({ type: 'text', text: block.text })
        else if (block.type === 'image' && block.imageId && block.media_type) content.push(piImage({ imageId: block.imageId, media_type: block.media_type }))
      }
      if (content.length) result.push({ role: 'user', content, timestamp: Date.now() })
    }
  }
  return result
}

export function auditBlocks(message: AgentMessage): MessageContentBlock[] {
  if (message.role === 'assistant') return message.content.flatMap((block): MessageContentBlock[] =>
    block.type === 'text' ? [{ type: 'text', text: block.text }]
      : block.type === 'toolCall' ? [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }] : [])
  if (message.role === 'user') return userBlocks(message.content)
  if (message.role === 'toolResult') return [{ type: 'tool_result', tool_use_id: message.toolCallId,
    content: message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'), is_error: message.isError }, ...userBlocks(message.content).filter(b => b.type === 'image')]
  return []
}

import type { AgentMessage } from './types'

/** Narrow legacy compatibility; explicit human origin and receipt identity win. */
export function isHostControlText(text: string): boolean {
  return /^(?:【收口指令（宿主注入）】|\[system[·・]拒收续接\]|<session-recall>|\[系统(?:续接|反馈)\])/.test(text.trimStart())
}

export function isInternalMessage(message: AgentMessage): boolean {
  if (message.origin === 'system') return true
  if (message.origin === 'user' || message.client_message_id) return false
  const content = message.content
  const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') : ''
  return message.role === 'user' && isHostControlText(text)
}

/** Keep original records intact, removing only standalone protocol lines from assistant prose. */
export function assistantDisplayText(text: string): string {
  return text.replace(/^(?:\s*<!--\s*)?PHASE_ADVANCE:\s*[^\n]*(?:-->)?\s*$/gm, '').trim()
}

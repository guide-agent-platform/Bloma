import {existsSync,readFileSync} from 'node:fs'
import {getAgentSessionPath} from '../../storage/config-paths'
import type {AgentMessage,MessageContentBlock} from '../../shared/types'
export function readConversation(sessionId: string): string {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return ''
  const lines: string[] = []
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
    lines.push(`${message.role === 'user' ? '用户' : '助手'}：${text}`)
  }
  return lines.join('\n')
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

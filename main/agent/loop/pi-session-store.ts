import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { getPromaHome } from '../../../storage/config-paths'
import { writeTextFileAtomic } from '../../../storage/json-store'

const active = new Set<string>()
export function piSessionPath(projectId: string, sessionId: string, scope: string, cwd: string): string {
  const key = createHash('sha256').update(JSON.stringify([projectId, sessionId, scope, resolve(cwd)])).digest('hex')
  return join(getPromaHome(), 'bloma-pi-sessions', key, 'session.jsonl')
}

/** Never select the latest session globally. Corrupt files are an explicit error,
 * not permission to silently start over and repeat side effects. */
export async function openPiSession(projectId: string, sessionId: string, scope: string, cwd: string) {
  const path = piSessionPath(projectId, sessionId, scope, cwd)
  if (active.has(path)) throw new Error('PI_SESSION_ALREADY_RUNNING')
  active.add(path)
  try {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent')
    mkdirSync(dirname(path), { recursive: true })
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf8')
      const lines = raw.split('\n').filter(line => line.trim())
      const entries: unknown[] = []
      for (let index = 0; index < lines.length; index++) {
        try { entries.push(JSON.parse(lines[index])) } catch (error) {
          // A torn final append is recoverable; preserve the original bytes.
          // An invalid header or corruption in the middle remains fail-closed.
          if (index === 0 || index < lines.length - 1 || raw.endsWith('\n')) throw error
          copyFileSync(path, `${path}.interrupted-${randomUUID()}`)
          writeTextFileAtomic(path, lines.slice(0, index).join('\n') + '\n')
        }
      }
      const header = entries[0] as { type?: string; cwd?: string } | undefined
      if (header?.type !== 'session' || resolve(header.cwd ?? '') !== resolve(cwd)) throw new Error('PI_SESSION_BINDING_INVALID')
    }
    const manager = SessionManager.open(path, dirname(path), cwd)
    return { manager, path, release: () => { active.delete(path) } }
  } catch (error) { active.delete(path); throw error }
}

/** A process can die between a tool side effect and the SDK's message_end write.
 * A host receipt restores the real result. Without one, preserve uncertainty and
 * require inspection; never replay a potentially completed write automatically. */
export function recoverInterruptedTools(manager: SessionManager): void {
  const pending = new Map<string, { name: string; assistantEntryId: string }>()
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'message') continue
    const message = entry.message
    if (message.role === 'assistant' && message.stopReason !== 'error' && message.stopReason !== 'aborted') {
      for (const block of message.content) if (block.type === 'toolCall') pending.set(block.id, { name: block.name, assistantEntryId: entry.id })
    } else if (message.role === 'toolResult') pending.delete(message.toolCallId)
  }
  const receipts = manager.getEntries().filter(entry => entry.type === 'custom' && entry.customType === 'bloma-tool-receipt')
  for (const [id, { name, assistantEntryId }] of pending) {
    const receipt = [...receipts].reverse().find(entry => entry.type === 'custom'
      && (entry.data as { id?: string })?.id === id && (entry.data as { assistantEntryId?: string })?.assistantEntryId === assistantEntryId)
    const data = receipt?.type === 'custom' ? receipt.data as { content?: string; isError?: boolean; name?: string } : undefined
    manager.appendMessage({ role: 'toolResult', toolCallId: id, toolName: name, timestamp: Date.now(),
      content: [{ type: 'text', text: data?.name === name && typeof data.content === 'string' ? data.content
        : '上次运行在此工具调用期间中断，执行结果未知。请先检查文件与实际状态；宿主没有重放该调用。' }],
      isError: data?.name === name && typeof data.content === 'string' ? data.isError === true : true })
  }
}

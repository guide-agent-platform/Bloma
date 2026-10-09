import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'
import { composerPath, readStored } from './composer-storage'
import type { AttachmentInfo } from '../../../shared/attachment-types'
import { resolvePastedImagePath } from '../shell/pasted-images'
import { trackComposerEvent } from './composer-events'

/** Conservative mark/sweep. Any unreadable reference record aborts before deletion. */
export function collectUnusedAttachments(validProjects: Set<string>, now = Date.now()): { removed: number; kept: number } {
  const live = new Set<string>()
  const root = dirname(composerPath('attachments', 'index'))
  const historyRoot = join(getPromaHome(), 'agent-sessions')
  const mark = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const item of value) mark(item); return }
    const record = value as Record<string, unknown>
    if (typeof record.attachment_id === 'string') live.add(record.attachment_id)
    if (record.type === 'image' && typeof record.imageId === 'string') {
      const match = record.imageId.match(/^material-([a-f0-9-]+)\//)
      if (match) live.add(match[1])
    }
    for (const item of Object.values(record)) mark(item)
  }
  if (existsSync(historyRoot)) for (const name of readdirSync(historyRoot).filter(name => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(historyRoot, name), 'utf8').split('\n').filter(Boolean)) {
      mark(JSON.parse(line))
      // Serialized tool results may hold an ID in a string rather than a structured block.
      for (const id of line.match(/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g) ?? []) live.add(id)
    }
  }
  for (const group of ['drafts', 'inbox']) {
    const dir = dirname(composerPath(group, 'index'))
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).filter(name => name.endsWith('.json'))) {
      const entry = readStored<Record<string, unknown>>(join(dir, name))!
      const owner = (entry.input ?? entry) as { project_id?: string; session_id?: string }
      // Retained receipts/drafts remain references even if the session index is temporarily missing.
      if (owner.project_id && validProjects.has(owner.project_id)) mark(entry)
    }
  }
  const plan: Array<{ id: string; meta: string; data: string }> = []
  let kept = 0
  if (!existsSync(root)) return { removed: 0, kept: 0 }
  for (const name of readdirSync(root).filter(name => name.endsWith('.json'))) {
    const meta = join(root, name)
    const info = readStored<AttachmentInfo & { imageId?: string }>(meta)!
    if (live.has(info.attachment_id) || now - statSync(meta).mtimeMs < 24 * 60 * 60 * 1000) { kept++; continue }
    if (!/^[a-f0-9-]{36}$/.test(info.attachment_id)) throw new Error('ATTACHMENT_GC_BAD_ID')
    let data: string
    if (info.kind === 'text') data = composerPath('texts', info.attachment_id)
    else {
      if (!info.imageId?.startsWith(`material-${info.attachment_id}/`)) throw new Error('ATTACHMENT_GC_BAD_IMAGE')
      data = resolvePastedImagePath(info.imageId)
    }
    plan.push({ id: info.attachment_id, meta, data })
  }
  for (const item of plan) { rmSync(item.data, { force: true }); rmSync(item.meta) }
  trackComposerEvent('attachment_gc', 'platform', 'startup', { removed: plan.length, kept })
  return { removed: plan.length, kept }
}

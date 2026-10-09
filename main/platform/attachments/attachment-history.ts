import { existsSync, readFileSync } from 'node:fs'
import type { AttachmentInfo, AttachmentReuseInput, ComposerDraft, DraftScope } from '../../../shared/attachment-types'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { assertScope, composerPath, importImage, loadDraft, readStored, resolveAttachments, saveDraft } from './composer-store'
import { resolvePastedImagePath } from '../shell/pasted-images'
import { grantAttachments } from './attachment-access'
import { listReceipts } from './send-inbox'

export function sessionHistoryAttachments(projectId: string, sessionId: string): AttachmentInfo[] {
  const scope = { project_id: projectId, session_id: sessionId, draft_id: `draft-${sessionId}` }
  assertScope(scope)
  const refs = new Map<string, DraftScope>()
  const path = getAgentSessionPath(sessionId)
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n').filter(Boolean)) {
      const message = JSON.parse(line) as { role?: string; attachments?: AttachmentInfo[] }
      if (message.role !== 'user') continue
      for (const info of message.attachments ?? []) refs.set(info.attachment_id, { project_id: projectId, session_id: sessionId, draft_id: info.draft_id })
    }
  }
  for (const { input } of listReceipts(sessionId)) {
    if (input.project_id === projectId) for (const ref of input.attachment_refs) refs.set(ref.attachment_id, input)
  }
  return [...refs].map(([attachment_id, source]) => {
    const [item] = resolveAttachments(source, [{ attachment_id }])
    const { imageId: _image, ...info } = item.info
    return info
  })
}
export function reuseHistoryAttachment(input: AttachmentReuseInput): ComposerDraft {
  assertScope(input)
  const info = sessionHistoryAttachments(input.project_id, input.source_session_id).find(info => info.attachment_id === input.attachment_id)
  if (!info) throw new Error('ATTACHMENT_SCOPE: 找不到来源会话中的材料')
  const draft = loadDraft(input)
  if (draft.revision !== input.expected_revision) throw new Error('DRAFT_CHANGED: 输入已变化，请重新选择材料')
  if (draft.attachment_refs.some(ref => ref.attachment_id === info.attachment_id)) return draft
  grantAttachments(input, [info], 'reuse')
  return saveDraft({ ...draft, attachment_refs: [...draft.attachment_refs, { attachment_id: info.attachment_id }], revision: draft.revision + 1 })
}
/** Proma bf3e98c branchBindings only keeps entries before the fork anchor; same boundary here. */
export function bindForkAttachments(projectId: string, sourceSessionId: string, targetSessionId: string, prefix: Record<string, unknown>[]): Record<string, unknown>[] {
  const target = { project_id: projectId, session_id: targetSessionId, draft_id: `draft-${targetSessionId}` }
  const infos = new Map<string, AttachmentInfo>()
  // Legacy images were owned by the source session directory. Snapshot only the referenced
  // images at fork time; leave the source history and original bytes untouched.
  const normalized = prefix.map(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return message
    const added: AttachmentInfo[] = []
    const content = (message.content as Array<Record<string, unknown>>).map(block => {
      if (block.type !== 'image' || typeof block.imageId !== 'string' || block.imageId.startsWith('material-')) return block
      const bytes = readFileSync(resolvePastedImagePath(block.imageId))
      const mediaType = String(block.media_type ?? 'image/png')
      const info = importImage({ request_id: 'fork-legacy-image', project_id: projectId, session_id: sourceSessionId, draft_id: `draft-${sourceSessionId}`, name: `历史图片.${mediaType.split('/')[1]}`, media_type: mediaType, base64: bytes.toString('base64') })
      added.push(info)
      return { ...block, imageId: resolveAttachments(info, [info])[0].image!.imageId }
    })
    return added.length ? { ...message, content, attachments: [...(Array.isArray(message.attachments) ? message.attachments : []), ...added] } : message
  })
  for (const message of normalized) {
    if (message.role !== 'user' || !Array.isArray(message.attachments)) continue
    for (const attachment of message.attachments as AttachmentInfo[]) {
      const source = { project_id: projectId, session_id: sourceSessionId, draft_id: attachment.draft_id }
      const [item] = resolveAttachments(source, [attachment])
      const canonical = readStored<AttachmentInfo>(composerPath('attachments', item.info.attachment_id))!
      infos.set(canonical.attachment_id, canonical)
    }
  }
  if (infos.size) grantAttachments(target, [...infos.values()], 'fork')
  return normalized.map(message => Array.isArray(message.attachments)
    ? { ...message, attachments: (message.attachments as AttachmentInfo[]).map(info => ({ ...info, ...target })) }
    : message)
}

import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ATTACHMENT_LIMITS } from '../../../shared/attachment-types'
import type { AttachmentImportInput, AttachmentInfo, AttachmentRef, ComposerDraft, DraftScope } from '../../../shared/attachment-types'
import { resolvePastedImagePath } from '../shell/pasted-images'
import { isTextAttachmentName } from '../../../shared/attachment-formats'
import type { AttachmentPage } from '../../../shared/attachment-types'
import { assertScope, composerPath, readStored, writeStored } from './composer-storage'
import { canAccessAttachment } from './attachment-access'
import { trackComposerEvent } from './composer-events'
export { assertScope, composerPath, readStored, writeStored } from './composer-storage'

const mimeExt: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' }

export function importImage(input: AttachmentImportInput): AttachmentInfo {
  assertScope(input)
  const ext = mimeExt[input.media_type]
  if (!ext) throw new Error('ATTACHMENT_TYPE: 首版支持 PNG/JPEG/GIF/WebP 图片')
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64)) throw new Error('ATTACHMENT_DATA: 图片数据无效或超过 5 MiB')
  const bytes = Buffer.from(input.base64, 'base64')
  const valid = ext === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : ext === 'jpeg' ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : ext === 'gif' ? /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP'
  if (!valid || bytes.length === 0 || bytes.length > ATTACHMENT_LIMITS.imageBytes) throw new Error('ATTACHMENT_DATA: 图片格式不匹配或超过 5 MiB')
  const id = randomUUID()
  // Existing provider hydration accepts this opaque legacy image reference; material storage owns its lifetime.
  const imageId = `material-${id}/${id}.${ext}`
  const imagePath = resolvePastedImagePath(imageId)
  mkdirSync(dirname(imagePath), { recursive: true })
  writeFileSync(imagePath, bytes, { flag: 'wx' })
  const info: AttachmentInfo = {
    attachment_id: id, project_id: input.project_id, session_id: input.session_id, draft_id: input.draft_id,
    name: String(input.name || '图片').slice(0, 160), media_type: input.media_type,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'ready',
    kind: 'image',
  }
  writeStored(composerPath('attachments', id), { ...info, imageId })
  trackComposerEvent('attachment_imported', input.project_id, input.session_id, { attachment_id: id, sha256: info.sha256, bytes: info.bytes, kind: 'image' })
  return info
}
export function resolveAttachments(scope: DraftScope, refs: AttachmentRef[]) {
  assertScope(scope)
  if (!Array.isArray(refs) || refs.length > ATTACHMENT_LIMITS.files) throw new Error('ATTACHMENT_LIMIT: 每条消息最多 8 个附件')
  if (new Set(refs.map(ref => ref?.attachment_id)).size !== refs.length) throw new Error('ATTACHMENT_DUPLICATE')
  const resolved = refs.map(ref => {
    const stored = readStored<AttachmentInfo & { imageId: string }>(composerPath('attachments', ref.attachment_id))
    if (!stored || !canAccessAttachment(scope, stored)) {
      throw new Error('ATTACHMENT_SCOPE: 材料不存在或不属于当前草稿')
    }
    let bytes: Buffer
    try { bytes = readFileSync(stored.kind === 'text' ? composerPath('texts', stored.attachment_id) : resolvePastedImagePath(stored.imageId)) }
    catch { throw new Error('ATTACHMENT_MISSING: 材料快照缺失或不可读，请重新导入') }
    if (createHash('sha256').update(bytes).digest('hex') !== stored.sha256) throw new Error('ATTACHMENT_CHANGED: 材料快照已失效')
    return { info: { ...stored, project_id: scope.project_id, session_id: scope.session_id, draft_id: scope.draft_id }, image: stored.kind === 'text' ? undefined : { imageId: stored.imageId, media_type: stored.media_type }, dataUrl: stored.kind === 'text' ? undefined : `data:${stored.media_type};base64,${bytes.toString('base64')}`, text: stored.kind === 'text' ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : undefined }
  })
  if (resolved.filter(item => item.image).length > ATTACHMENT_LIMITS.images) throw new Error('ATTACHMENT_LIMIT: 每条消息最多 4 张图片')
  return resolved
}
export function importAttachment(input: AttachmentImportInput): AttachmentInfo {
  try { return importAttachmentImpl(input) }
  catch (error) { trackComposerEvent('parse_failed', input.project_id, input.session_id, { name: input.name, code: String(error).split(':')[0] }); throw error }
}
function importAttachmentImpl(input: AttachmentImportInput): AttachmentInfo {
  if (input.media_type?.startsWith('image/')) return importImage(input)
  assertScope(input)
  if (!isTextAttachmentName(input.name)) throw new Error('ATTACHMENT_TYPE: 支持 UTF-8 文本、代码、CSV、JSON；PDF/Word/压缩包暂不支持')
  if (typeof input.base64 !== 'string' || input.base64.length > Math.ceil(ATTACHMENT_LIMITS.textBytes / 3) * 4 || (input.base64 !== '' && !/^[A-Za-z0-9+/]+={0,2}$/.test(input.base64))) throw new Error('ATTACHMENT_DATA: 文本超过 1 MiB 或数据无效')
  const bytes = Buffer.from(input.base64, 'base64')
  if (bytes.length > ATTACHMENT_LIMITS.textBytes) throw new Error('ATTACHMENT_DATA: 文本超过 1 MiB')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error('ATTACHMENT_ENCODING: 请将文件保存为 UTF-8 后重试') }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('ATTACHMENT_BINARY: 不能把二进制文件作为文本材料导入')
  const id = randomUUID()
  const info: AttachmentInfo = { attachment_id: id, project_id: input.project_id, session_id: input.session_id, draft_id: input.draft_id, name: input.name.slice(0, 160), media_type: 'text/plain', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), status: 'ready', kind: 'text', encoding: 'utf-8', line_count: text.split(/\r?\n/).length }
  const filePath = composerPath('texts', id)
  mkdirSync(dirname(filePath), { recursive: true }); writeFileSync(filePath, bytes, { flag: 'wx' })
  writeStored(composerPath('attachments', id), info)
  trackComposerEvent('attachment_imported', input.project_id, input.session_id, { attachment_id: id, sha256: info.sha256, bytes: info.bytes, kind: 'text' })
  return info
}
export function readAttachmentPage(info: AttachmentInfo, startLine = 1, limit = 200, budget: number = ATTACHMENT_LIMITS.readChars): AttachmentPage {
  if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('ATTACHMENT_RANGE: start_line 从 1 起，limit 为 1–1000')
  const [item] = resolveAttachments(info, [info])
  if (item.text === undefined) throw new Error('ATTACHMENT_IMAGE: 图片沿视觉协议提供，不提供 OCR 文本')
  const lines = item.text.split(/\r?\n/)
  if (startLine > lines.length + 1) throw new Error('ATTACHMENT_RANGE: 起始行超出文件')
  let text = ''; let endLine = startLine - 1; let truncated = false
  for (let index = startLine - 1; index < Math.min(lines.length, startLine - 1 + limit); index++) {
    const line = lines[index]
    if (text.length + line.length + 1 > budget) {
      if (!text) throw new Error('ATTACHMENT_LINE_TOO_LONG: 单行超过读取预算，请拆分长行后重新导入')
      truncated = true; break
    }
    text += (text ? '\n' : '') + line; endLine = index + 1
  }
  const next = endLine < lines.length ? endLine + 1 : undefined
  return { attachment_id: info.attachment_id, sha256: info.sha256, start_line: startLine, end_line: endLine, text, total_lines: lines.length, ...(next ? { next_line: next } : {}), truncated: truncated || Boolean(next) }
}
export function loadDraft(scope: DraftScope): ComposerDraft {
  assertScope(scope)
  const stored = readStored<ComposerDraft>(composerPath('drafts', scope.draft_id))
  if (stored && (stored.project_id !== scope.project_id || stored.session_id !== scope.session_id)) throw new Error('DRAFT_SCOPE')
  return stored ?? { ...scope, text: '', attachment_refs: [], revision: 0 }
}
export function saveDraft(draft: ComposerDraft): ComposerDraft {
  assertScope(draft)
  if (typeof draft.text !== 'string' || draft.text.length > 200_000 || !Number.isSafeInteger(draft.revision) || draft.revision < 0) throw new Error('DRAFT_INVALID')
  resolveAttachments(draft, draft.attachment_refs)
  if (draft.pending_send) {
    if (typeof draft.pending_send.text !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(draft.pending_send.client_message_id)) throw new Error('DRAFT_INVALID')
    resolveAttachments(draft, draft.pending_send.attachment_refs)
  }
  const previous = loadDraft(draft)
  if (previous.revision > draft.revision) return previous
  writeStored(composerPath('drafts', draft.draft_id), draft)
  return draft
}

import type { AttachmentInfo, DraftScope } from '../../../shared/attachment-types'
import { assertScope, composerPath, readStored, writeStored } from './composer-storage'
import { trackComposerEvent } from './composer-events'

interface Bindings extends DraftScope { attachment_ids: string[] }
export function canAccessAttachment(scope: DraftScope, info: AttachmentInfo): boolean {
  assertScope(scope)
  if (info.project_id !== scope.project_id) return false
  if (info.session_id === scope.session_id && info.draft_id === scope.draft_id) return true
  const bindings = readStored<Bindings>(composerPath('bindings', scope.draft_id))
  return Boolean(bindings && bindings.project_id === scope.project_id && bindings.session_id === scope.session_id && bindings.attachment_ids.includes(info.attachment_id))
}
/** Callers must first establish source history ownership. Never called with a renderer-supplied info. */
export function grantAttachments(scope: DraftScope, infos: AttachmentInfo[], reason: 'fork' | 'reuse'): void {
  assertScope(scope)
  if (infos.some(info => info.project_id !== scope.project_id)) throw new Error('ATTACHMENT_SCOPE: 暂不支持跨项目共享材料')
  const path = composerPath('bindings', scope.draft_id)
  const existing = readStored<Bindings>(path)
  if (existing && (existing.project_id !== scope.project_id || existing.session_id !== scope.session_id)) throw new Error('ATTACHMENT_SCOPE')
  writeStored(path, { project_id: scope.project_id, session_id: scope.session_id, draft_id: scope.draft_id, attachment_ids: [...new Set([...(existing?.attachment_ids ?? []), ...infos.map(info => info.attachment_id)])] })
  trackComposerEvent(`attachment_${reason}`, scope.project_id, scope.session_id, { attachment_ids: infos.map(info => info.attachment_id) })
}

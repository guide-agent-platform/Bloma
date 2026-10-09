import { useAtomValue, useStore } from 'jotai'
import type { AttachmentInfo } from '../../shared/attachment-types'
import { composerScopeAtom, composerDraftFamily, draftKey } from '../composer-state'

/** Like Proma draftScopeKey: asynchronous completion belongs to the scope captured at initiation. */
export function useAttachmentReuse() {
  const scope = useAtomValue(composerScopeAtom)
  const store = useStore()
  return async (info: AttachmentInfo) => {
    const api = window.electronAPI?.composer
    if (!api?.reuse) throw new Error('历史材料引用接口不可用')
    if (info.project_id !== scope.project_id) throw new Error('暂不支持跨项目引用材料')
    const target = composerDraftFamily(draftKey(scope))
    const before = store.get(target)
    const saved = await api.save({ request_id: crypto.randomUUID(), draft: before })
    if (!saved.ok) throw new Error(saved.error.message)
    const result = await api.reuse({ request_id: crypto.randomUUID(), ...scope, source_session_id: info.session_id, attachment_id: info.attachment_id, expected_revision: before.revision })
    if (!result.ok) throw new Error(result.error.message)
    const current = store.get(target)
    const refs = [...new Map([...current.attachment_refs, ...result.data.attachment_refs].map(ref => [ref.attachment_id, ref])).values()]
    const next = { ...current, attachment_refs: refs, revision: Math.max(current.revision, result.data.revision) + 1 }
    store.set(target, next)
    const persisted = await api.save({ request_id: crypto.randomUUID(), draft: next })
    if (!persisted.ok) throw new Error(persisted.error.message)
  }
}

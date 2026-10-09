import { atom } from 'jotai'
import { atomFamily } from 'jotai/utils'
import type { ComposerDraft, DraftScope } from '../shared/attachment-types'
import { activeAgentSessionIdAtom, currentProjectAtom } from './agent-atoms'

const temporaryId = crypto.randomUUID()
export const composerScopeAtom = atom<DraftScope>(get => {
  const session_id = get(activeAgentSessionIdAtom) ?? temporaryId
  return { project_id: get(currentProjectAtom)?.project_id ?? `temp-${temporaryId}`, session_id, draft_id: `draft-${session_id}` }
})
export const draftKey = (scope: DraftScope) => `${scope.project_id}|${scope.session_id}`
export const composerDraftFamily = atomFamily((key: string) => {
  const [project_id, session_id] = key.split('|')
  return atom<ComposerDraft>({ project_id, session_id, draft_id: `draft-${session_id}`, text: '', attachment_refs: [], revision: 0 })
})
export const composerLoadedFamily = atomFamily((_key: string) => atom(false))
export const chatInputDraftAtom = atom(
  get => get(composerDraftFamily(draftKey(get(composerScopeAtom)))).text,
  (get, set, update: string | ((previous: string) => string)) => {
    const draftAtom = composerDraftFamily(draftKey(get(composerScopeAtom)))
    const previous = get(draftAtom)
    const text = typeof update === 'function' ? update(previous.text) : update
    set(draftAtom, { ...previous, text, revision: previous.revision + 1 })
  },
)

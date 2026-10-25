import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { readGuideConfirmation } from './confirmation-journal'
import { leanScopeDecision } from './lean-scope'
import { uxDecisionPayload, type PendingUxConfirm } from './ux-confirm'

/** Read-only rehydration. Showing a card never consumes confirmation or starts
 * model work; normal scope/hash/ownership checks still run on the user's click. */
export function readPendingDecision(projectId: string, sessionId: string) {
  const project = findProject(projectId)
  if (project.desktop_phase || project.status === 'completed') return
  const brief = readPrdBackplane(projectId), scope = prdScopeFingerprint(brief)
  const prd = readGuideConfirmation('prd', projectId)
  if (!brief.user_confirmed_at && prd?.state === 'pending' && prd.data.lean === true && prd.session_id === sessionId) {
    if (prd.scope_hash !== scope) throw Error('LEAN_CONFIRMATION_STALE')
    return { project_id: projectId, payload: leanScopeDecision(brief) }
  }
  const ux = readGuideConfirmation('ux', projectId)
  if (brief.user_confirmed_at && ux?.state === 'pending' && ux.session_id === sessionId) {
    if (ux.scope_hash !== scope) throw Error('UX_CONFIRMATION_SCOPE_CHANGED')
    const pending = ux.data as unknown as PendingUxConfirm
    if (pending.project_id !== projectId || pending.session_id !== sessionId || pending.prdFingerprint !== scope) throw Error('UX_CONFIRMATION_INVALID')
    if (pending.sketchHash) {
      const actual = createHash('sha256').update(readFileSync(join(project.root_path, '00_UX/ux-sketch.html'))).digest('hex')
      if (actual !== pending.sketchHash) throw Error('UX_CONFIRMATION_SKETCH_CHANGED')
    }
    return { project_id: projectId, payload: uxDecisionPayload(pending),
      ...(pending.sketchHash && !pending.generationFailed ? { preview_url: `bloma-file://${projectId}/00_UX/ux-sketch.html` } : {}) }
  }
}

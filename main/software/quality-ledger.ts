import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { runtimeInventory } from './release-store'
import { runtimeBindingVersion } from './runtime-bindings'
import { capabilityBindingVersion } from './capability-bindings'
import type { VisualMaterial } from './visual-review-material'
import type { PastedImageRef } from '../../shared/types'

export type Identity = { source: string; target: string; environment: string }
export type ReviewKind = 'code' | 'visual'
export interface Review { id: string; kind?: ReviewKind; identity: Identity; status: 'pending' | 'submitted' | 'complete' | 'interrupted'; child?: string; delegation?: string; at: string
  visual?: VisualMaterial; image?: PastedImageRef; visual_delivery?: { at: string; image_hash: string; request_hash: string }; visual_observations?: unknown[]
  visual_error?: 'MODEL_IMAGE_INPUT_UNSUPPORTED'; visual_route?: string }
export interface QualityFinding {
  id: string; review: string; identity: Identity; requirement: string; expected_source: string; category: string
  review_kind?: ReviewKind; visual_material_hash?: string
  independent?: { design_version: string; design_digest: string; case_id: string }
  challenge?: { at: string; reason: string; evidence: string; source: 'implementer_claim' }
  severity: 'critical' | 'high' | 'medium' | 'low'; location: string; trigger: string; evidence: string; reproduction: string; unknowns: string
  disposition: 'suspected' | 'disputed' | 'suggestion' | 'not_reproduced' | 'confirmed' | 'closed' | 'superseded'
  checks: Array<{ at: string; identity: Identity; case_name: string; rules: string; outcome: 'failed' | 'passed' | 'unverified'; report?: string; candidate?: string; observation: string }>
}
export interface Ledger { version: 1; reviews: Review[]; findings: QualityFinding[] }
export const qualityHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const sameIdentity = (a: Identity, b: Identity) => qualityHash(a) === qualityHash(b)
export function qualityLedgerPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('QUALITY_PROJECT_INVALID')
  return join(getPromaHome(), 'software-quality', `${projectId}.json`)
}
export function readQualityLedger(projectId: string): Ledger {
  const path = qualityLedgerPath(projectId)
  if (!existsSync(path)) return { version: 1, reviews: [], findings: [] }
  const value = JSON.parse(readFileSync(path, 'utf8')) as Ledger
  if (value.version !== 1 || !Array.isArray(value.reviews) || !Array.isArray(value.findings)) throw Error('QUALITY_LEDGER_INVALID')
  return value // Corrupt evidence must fail closed, never silently reset history.
}
export async function qualityIdentity(projectId: string, signal?: AbortSignal): Promise<Identity> {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  if (!brief.user_confirmed_at) throw Error('QUALITY_TARGET_NOT_CONFIRMED')
  readConfirmedUxBinding(projectId, brief)
  return { source: (await runtimeInventory(project.root_path, signal)).digest,
    target: qualityHash([prdScopeFingerprint(brief), brief.user_confirmed_at, project.ux_confirmation]),
    environment: qualityHash([runtimeBindingVersion(projectId), capabilityBindingVersion(projectId), process.platform, process.arch, process.versions.node]) }
}
export const saveQualityLedger = (projectId: string, ledger: Ledger) => writeTextFileAtomic(qualityLedgerPath(projectId), JSON.stringify(ledger, null, 2))

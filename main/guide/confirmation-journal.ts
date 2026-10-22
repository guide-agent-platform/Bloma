import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { renameWithRetry } from '../../storage/fs-retry'

type Kind = 'prd' | 'ux'
export type ConfirmationState = 'pending' | 'adjust' | 'working' | 'dismissed' | 'consumed'
export interface GuideConfirmationRecord {
  version: 1; kind: Kind; id: string; project_id: string; session_id: string; scope_hash: string
  state: ConfirmationState; data: Record<string, unknown>
  data_hash?: string
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const written = new Map<string, Kind>()
export function guideConfirmationPath(kind: Kind, projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('GUIDE_CONFIRMATION_PROJECT_INVALID')
  return join(getPromaHome(), 'pending-confirmations', `${projectId}-${kind}.json`)
}
export function readGuideConfirmation(kind: Kind, projectId: string): GuideConfirmationRecord | undefined {
  const path = guideConfirmationPath(kind, projectId)
  if (!existsSync(path)) return
  if (statSync(path).size > 4 * 1024 * 1024) throw new Error('GUIDE_CONFIRMATION_TOO_LARGE')
  const raw = JSON.parse(readFileSync(path, 'utf8')) as GuideConfirmationRecord
  if (raw.version !== 1 || raw.kind !== kind || raw.project_id !== projectId || typeof raw.session_id !== 'string' || !raw.session_id
    || typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(raw.id) || !/^[a-f0-9]{64}$/.test(raw.scope_hash)
    || !['pending', 'adjust', 'working', 'dismissed', 'consumed'].includes(raw.state)
    || !raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data) || raw.data_hash !== digest(raw.data)) throw new Error('GUIDE_CONFIRMATION_INVALID')
  return raw.state === 'consumed' ? undefined : raw
}
export function saveGuideConfirmation(record: GuideConfirmationRecord): void {
  const text = JSON.stringify({ ...record, data_hash: digest(record.data) })
  if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('GUIDE_CONFIRMATION_TOO_LARGE')
  writeTextFileAtomic(guideConfirmationPath(record.kind, record.project_id), text)
  written.set(guideConfirmationPath(record.kind, record.project_id), record.kind)
}
export function archiveGuideConfirmation(kind: Kind, projectId: string): void {
  const path = guideConfirmationPath(kind, projectId)
  if (!existsSync(path)) return
  const directory = join(getPromaHome(), 'pending-confirmations', 'archive')
  mkdirSync(directory, { recursive: true })
  renameWithRetry(path, join(directory, `${projectId}-${kind}-${randomUUID()}.json`))
}
export function loadGuideConfirmationForResume(kind: Kind, projectId: string): GuideConfirmationRecord | undefined {
  try { return readGuideConfirmation(kind, projectId) }
  catch {
    archiveGuideConfirmation(kind, projectId)
    throw new Error('GUIDE_CONFIRMATION_CORRUPT_ARCHIVED')
  }
}
export interface PendingIdentity { project_id: string; session_id: string; confirmationId?: string }
/** In-memory callbacks are rebound per request; only explicit DTO fields persist. */
export class ConfirmationMap<T extends PendingIdentity> extends Map<string, T> {
  constructor(private kind: Kind, private state: 'pending' | 'adjust', private scope: (value: T) => string | undefined,
    private serialize: (value: T) => Record<string, unknown>) { super() }
  save(value: T, state: ConfirmationState): void {
    const scope = this.scope(value)
    if (!scope) return // legacy test seeds do not attest a confirmed candidate
    if (value.confirmationId) {
      const current = readGuideConfirmation(this.kind, value.project_id)
      if (current && current.id !== value.confirmationId) throw new Error('GUIDE_CONFIRMATION_SUPERSEDED')
    } else value.confirmationId = randomUUID()
    saveGuideConfirmation({ version: 1, kind: this.kind, id: value.confirmationId, project_id: value.project_id,
      session_id: value.session_id, scope_hash: scope, state, data: this.serialize(value) })
  }
  override set(key: string, value: T): this { this.save(value, this.state); return super.set(key, value) }
  override delete(key: string): boolean {
    const value = this.get(key)
    if (value) this.save(value, 'working')
    return super.delete(key)
  }
  /** Runtime rebinding must not replace persisted candidates or reset their state. */
  bind(key: string, value: T): void { super.set(key, value) }
  forget(key: string): void { super.delete(key) }
}
export function clearGuideConfirmationFilesForTests(kind: Kind): void {
  for (const [path, savedKind] of written) if (savedKind === kind) { rmSync(path, { force: true }); written.delete(path) }
}

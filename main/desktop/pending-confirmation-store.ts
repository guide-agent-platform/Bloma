import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'

export function pendingConfirmationPath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('CONFIRMATION_PROJECT_INVALID')
  return join(getPromaHome(), 'pending-confirmations', `${projectId}-mvp.json`)
}
export interface StoredMvpConfirmation {
  version: 1; project_id: string; state: 'pending' | 'consuming' | 'consumed'
  session_id: string; from_phase: string; fingerprint?: string
  notice: import('./notice-cards').DeliveredNoticeInput
}
export function readMvpConfirmation(projectId: string): StoredMvpConfirmation | undefined {
  const path = pendingConfirmationPath(projectId)
  if (!existsSync(path)) return
  if (statSync(path).size > 256 * 1024) throw new Error('CONFIRMATION_RECORD_INVALID')
  const value = JSON.parse(readFileSync(path, 'utf8')) as StoredMvpConfirmation
  if (value.version !== 1 || value.project_id !== projectId || !['pending', 'consuming', 'consumed'].includes(value.state)
    || typeof value.session_id !== 'string' || !value.session_id || typeof value.from_phase !== 'string'
    || !value.notice || typeof value.notice.projectName !== 'string' || typeof value.notice.fromPhaseTitle !== 'string'
    || value.fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(value.fingerprint)) throw new Error('CONFIRMATION_RECORD_INVALID')
  return value.state === 'consumed' ? undefined : value
}
export function writeMvpConfirmation(record: StoredMvpConfirmation): void {
  writeTextFileAtomic(pendingConfirmationPath(record.project_id), JSON.stringify(record))
}

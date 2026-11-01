import { createHash, randomUUID } from 'node:crypto'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'

interface CorrectionSubmission { version: 1; id: string; projectId: string; content: string; pickCount: number;observedVersion?:string }
function file(projectId: string): string {
  return join(getPromaHome(), 'correction-outbox', `${createHash('sha256').update(projectId).digest('hex')}.json`)
}
export function readCorrectionSubmission(projectId: string): CorrectionSubmission | undefined {
  const value = readJsonFile<CorrectionSubmission | undefined>(file(projectId), undefined)
  if (!value) return undefined
  if(value.observedVersion!==undefined&&(typeof value.observedVersion!=='string'||!/^[a-f0-9]{64}$/.test(value.observedVersion)))throw Error('CORRECTION_OUTBOX_INVALID')
  if (value.version !== 1 || value.projectId !== projectId || typeof value.id !== 'string' || typeof value.content !== 'string'
    || !Number.isSafeInteger(value.pickCount) || value.pickCount < 1) throw new Error('CORRECTION_OUTBOX_INVALID')
  return value
}
export function saveCorrectionSubmission(projectId: string, content: string, pickCount: number,observedVersion?:string): CorrectionSubmission {
  // An unacknowledged submission is never overwritten by another finish/retry.
  const pending = readCorrectionSubmission(projectId)
  if (pending) return pending
  if(observedVersion!==undefined&&!/^[a-f0-9]{64}$/.test(observedVersion))throw Error('CORRECTION_VERSION_INVALID')
  const submission: CorrectionSubmission = { version: 1, id: randomUUID(), projectId, content, pickCount,...(observedVersion?{observedVersion}:{}) }
  writeJsonFile(file(projectId), submission)
  return submission
}
export function clearCorrectionSubmission(projectId: string, expectedId?: string): boolean {
  const pending = readCorrectionSubmission(projectId)
  if (expectedId && pending?.id !== expectedId) return false
  const target = file(projectId)
  if (existsSync(target)) unlinkSync(target)
  return true
}

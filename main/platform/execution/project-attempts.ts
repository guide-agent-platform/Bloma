import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'
import { writeTextFileAtomic } from '../../../storage/json-store'
export interface ProjectAttempts { schema_version: 1; active: Record<string, number>; total: Record<string, number> }
function pathFor(projectId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('Invalid attempt project id')
  return join(getPromaHome(), 'execution-attempts', `${projectId}.json`)
}
export function readProjectAttempts(projectId: string): ProjectAttempts {
  const path = pathFor(projectId)
  if (!existsSync(path)) return { schema_version: 1, active: {}, total: {} }
  const value = JSON.parse(readFileSync(path, 'utf8')) as ProjectAttempts
  if (value.schema_version !== 1 || !value.active || !value.total || [value.active, value.total].some(r => Array.isArray(r) || typeof r !== 'object' || Object.values(r).some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('Attempt ledger unreadable; refusing to reset unknown counts')
  return value
}
export function consumeProjectAttempt(projectId: string, scope: string, limit?: number): { allowed: boolean; used: number; total: number } {
  const ledger = readProjectAttempts(projectId)
  const used = ledger.active[scope] ?? 0
  if (limit !== undefined && used >= limit) return { allowed: false, used, total: ledger.total[scope] ?? 0 }
  ledger.active[scope] = used + 1
  ledger.total[scope] = (ledger.total[scope] ?? 0) + 1
  writeTextFileAtomic(pathFor(projectId), JSON.stringify(ledger))
  return { allowed: true, used: used + 1, total: ledger.total[scope] }
}
export function resetProjectAttemptScope(projectId: string, scope: string): void {
  const ledger = readProjectAttempts(projectId)
  delete ledger.active[scope]
  writeTextFileAtomic(pathFor(projectId), JSON.stringify(ledger))
}

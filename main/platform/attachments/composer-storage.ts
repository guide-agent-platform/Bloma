import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getPromaHome } from '../../../storage/config-paths'
import type { DraftScope } from '../../../shared/attachment-types'

export function assertScope(scope: DraftScope): void {
  for (const id of [scope.project_id, scope.session_id, scope.draft_id]) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('COMPOSER_BAD_SCOPE: 草稿归属无效')
  }
}
export function composerPath(group: string, id: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('COMPOSER_BAD_ID')
  return join(getPromaHome(), 'bloma-composer', group, `${id}.json`)
}
export function readStored<T>(path: string): T | undefined {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : undefined
}
/** Fail closed: a receipt is never acknowledged after an unsuccessful atomic write. */
export function writeStored(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value), 'utf8')
  renameSync(temporary, path)
}

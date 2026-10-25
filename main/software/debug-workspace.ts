import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { findProject } from '../project/project-service'

/** Durable development state, separate from formal acceptance and user data.
 * Operation changes select a new workspace; stopping a process never erases it. */
export function debugWorkspace(projectId: string, sessionId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('DEBUG_PROJECT_INVALID')
  const key = createHash('sha256').update(`${sessionId}\n${findProject(projectId).lean_operation_id ?? 'initial'}`).digest('hex').slice(0, 32)
  let directory = getPromaHome()
  for (const part of ['software-debug-data', projectId, key]) {
    directory = join(directory, part)
    if (existsSync(directory) && (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory())) throw Error('DEBUG_WORKSPACE_PATH_INVALID')
    mkdirSync(directory, { recursive: true })
  }
  for (const part of ['data', 'profile', 'checkpoint.json', 'browser-state.json']) {
    const target = join(directory, part)
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) throw Error('DEBUG_WORKSPACE_LINK_UNSUPPORTED')
  }
  return directory
}

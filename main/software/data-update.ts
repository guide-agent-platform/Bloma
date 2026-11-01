import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { executeSoftwareCommand, validateSoftwareCommand } from './command-runtime'
import { fileDigest } from './release-store'

interface DataState { release: string; schema: string; generation?: string; software_release?: string; previous_software_release?: string }
interface Snapshot { id: string; at: string; state: DataState; files: Array<{ path: string; sha256: string }>; reason: 'update' | 'restore' }
interface DataPolicy { schema_version: 1; schema: string; verify?: string[]; migrations?: Record<string, string[]> }
function base(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('DATA_PROJECT_INVALID')
  return join(getPromaHome(), 'software-app-data', projectId)
}
function readState(projectId: string): DataState {
  const file = join(base(projectId), 'data-state.json')
  if (!existsSync(file)) return { release: '', schema: 'unversioned' }
  const state = JSON.parse(readFileSync(file, 'utf8')) as DataState
  if (typeof state.release !== 'string' || typeof state.schema !== 'string' || state.generation && !/^[a-f0-9-]{36}$/.test(state.generation)) throw Error('DATA_STATE_INVALID')
  return state
}
export function softwareDataDirectory(projectId: string): string {
  const state = readState(projectId), directory = state.generation ? join(base(projectId), 'generations', state.generation, 'data') : join(base(projectId), 'data')
  // Product-created symlinks must not redirect host backup/restore operations.
  let parent = directory
  while (!existsSync(parent)) { const next = resolve(parent, '..'); if (next === parent) throw Error('DATA_ROOT_INVALID'); parent = next }
  if (relative(resolve(base(projectId)), resolve(realpathSync(parent), relative(parent, directory))).startsWith('..')) throw Error('DATA_PATH_OUTSIDE_PROJECT_STORE')
  return directory
}
export function readDataPolicy(root: string): DataPolicy {
  const file = join(root, 'DATA_UPDATE.json')
  if (!existsSync(file)) return { schema_version: 1, schema: 'unversioned' }
  const bytes = readFileSync(file); if (bytes.length > 65536) throw Error('DATA_UPDATE_POLICY_TOO_LARGE')
  const value = JSON.parse(bytes.toString('utf8')) as DataPolicy
  if (value.schema_version !== 1 || typeof value.schema !== 'string' || !/^[A-Za-z0-9_.-]{1,80}$/.test(value.schema)) throw Error('DATA_UPDATE_POLICY_INVALID')
  if (value.migrations && (typeof value.migrations !== 'object' || Array.isArray(value.migrations) || !value.verify)) throw Error('DATA_MIGRATION_REQUIRES_READBACK')
  if (value.verify) validateSoftwareCommand(value.verify)
  for (const command of Object.values(value.migrations ?? {})) validateSoftwareCommand(command)
  return value
}
async function dataFiles(root: string) {
  const files: Snapshot['files'] = []; let bytes = 0
  const visit = async (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = prefix + entry.name, full = join(directory, entry.name), info = lstatSync(full)
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw Error('DATA_SNAPSHOT_LINK_UNSUPPORTED')
      if (info.isDirectory()) await visit(full, `${path}/`)
      else {
        if (files.length >= 100000 || (bytes += info.size) > 8 * 1024 ** 3) throw Error('DATA_SNAPSHOT_SIZE_LIMIT')
        files.push({ path, sha256: await fileDigest(full) })
      }
    }
  }
  if (existsSync(root)) await visit(root)
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/** A writable preview copy must not retain links back into the user's data. */
export async function copyDataForPreview(source:string,target:string):Promise<void>{
  if(lstatSync(source).isSymbolicLink())throw Error('DATA_SNAPSHOT_LINK_UNSUPPORTED')
  await consistentCopy(source,target)
}
async function consistentCopy(source: string, destination: string) {
  const before = await dataFiles(source)
  mkdirSync(destination, { recursive: true })
  if (existsSync(source)) cpSync(source, destination, { recursive: true, force: false, errorOnExist: true })
  if (JSON.stringify(await dataFiles(source)) !== JSON.stringify(before) || JSON.stringify(await dataFiles(destination)) !== JSON.stringify(before)) throw Error('DATA_CHANGED_DURING_SNAPSHOT')
  return before
}
/** Caller must have stopped the live owned product after the user saved. Data
 * from a possibly running, unowned old process is never treated as consistent. */
async function snapshotData(projectId: string, reason: Snapshot['reason']) {
  const id = randomUUID(), directory = join(base(projectId), 'backups', id), state = readState(projectId)
  const files = await consistentCopy(softwareDataDirectory(projectId), join(directory, 'data'))
  const environment = join(softwareDataDirectory(projectId), '..', 'environment-home')
  if (existsSync(environment)) await consistentCopy(environment, join(directory, 'environment-home'))
  const snapshot: Snapshot = { id, at: new Date().toISOString(), state, files, reason }
  writeTextFileAtomic(join(directory, 'snapshot.json'), JSON.stringify(snapshot))
  return snapshot
}
export function listSoftwareDataSnapshots(projectId: string): Array<{ id: string; at: string; schema: string }> {
  const directory = join(base(projectId), 'backups'); if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap(id => {
    if (!/^[a-f0-9-]{36}$/.test(id)) return []
    try { const snapshot = JSON.parse(readFileSync(join(directory, id, 'snapshot.json'), 'utf8')) as Snapshot
      return [{ id, at: snapshot.at, schema: snapshot.state.schema }] } catch { return [] }
  }).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40)
}
export function softwareFallbackReleaseId(projectId: string, latestId: string) {
  const state = readState(projectId)
  const id = state.software_release !== latestId ? state.software_release : state.previous_software_release
  if (id && !/^[a-f0-9]{64}$/.test(id)) throw Error('DATA_RELEASE_REFERENCE_INVALID')
  return id
}
async function checkData(projectId: string, root: string, policy: DataPolicy, dataDir: string) {
  if (policy.verify) {
    const result = await executeSoftwareCommand({ projectId, root, command: policy.verify, dataDir, timeoutMs: 120000 })
    if (result.code !== 0) throw Error(`DATA_READBACK_FAILED: ${result.stderr.slice(-1000) || result.code}`)
  }
}
export async function prepareDataUpdate(projectId: string, root: string, release: string, restoreId?: string, softwareRelease?: string) {
  const current = readState(projectId), policy = readDataPolicy(root), dataDir = softwareDataDirectory(projectId)
  if (!restoreId && current.release === release) return { dataDir, commit: () => {} }
  const generation = randomUUID(), stage = join(base(projectId), 'generations', generation), target = join(stage, 'data')
  let source = dataDir, from = current.schema
  if (restoreId) {
    if (!/^[a-f0-9-]{36}$/.test(restoreId)) throw Error('DATA_RESTORE_ID_INVALID')
    const directory = join(base(projectId), 'backups', restoreId), snapshot = JSON.parse(readFileSync(join(directory, 'snapshot.json'), 'utf8')) as Snapshot
    source = join(directory, 'data'); from = snapshot.state.schema
    if (snapshot.id !== restoreId || JSON.stringify(await dataFiles(source)) !== JSON.stringify(snapshot.files)) throw Error('DATA_RESTORE_SNAPSHOT_CHANGED')
  }
  const populated = existsSync(source) && readdirSync(source).length > 0
  if (populated && from !== policy.schema && !policy.migrations?.[from]) throw Error(`DATA_MIGRATION_MISSING: ${from} -> ${policy.schema}`)
  // Back up the current generation, even when restoring an older one.
  if (existsSync(dataDir) && readdirSync(dataDir).length) await snapshotData(projectId, restoreId ? 'restore' : 'update')
  await consistentCopy(source, target)
  const environment = join(source, '..', 'environment-home')
  if (existsSync(environment)) await consistentCopy(environment, join(stage, 'environment-home'))
  if (populated && from !== policy.schema) {
    const result = await executeSoftwareCommand({ projectId, root, command: policy.migrations![from], dataDir: target, timeoutMs: 120000 })
    if (result.code !== 0) throw Error(`DATA_MIGRATION_FAILED: ${result.stderr.slice(-1000) || result.code}`)
  }
  await checkData(projectId, root, policy, target)
  return { dataDir: target, commit: () => writeTextFileAtomic(join(base(projectId), 'data-state.json'), JSON.stringify({ release, schema: policy.schema, generation,
    software_release: softwareRelease, previous_software_release: current.software_release !== softwareRelease ? current.software_release : current.previous_software_release } satisfies DataState)) }
}
export const SOFTWARE_DATA_UPDATE_GUIDANCE = '增量修改保留已有行为和真实数据。数据schema变化时在DATA_UPDATE.json登记schema_version:1、schema、migrations:{旧schema:参数数组}及verify:参数数组；迁移和只读验证均通过APP_DATA_DIR操作副本，verify用退出码表达实际读回。无版本旧数据的schema为unversioned。无需改变数据schema的项目不必添加。更新先提示用户保存，副本迁移/正常启动通过才切换；代码更新不会自动恢复旧数据。'

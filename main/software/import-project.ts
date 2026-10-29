import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, realpath, rename, rmdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { createProject, updateProject, findProject } from '../project/project-service'
import { execFileDriverSpawn, buildDriverEnv } from '../desktop/process-driver'
import { fileDigest } from './release-store'
import type { ProjectMode } from '../../shared/types'

interface ImportedFile { path: string; sha256: string; size: number }
interface GitOrigin { head: string; branch: string; status: string; status_sha256: string }
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function inside(root: string, target: string) { const path = relative(root, target); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`) }
async function sourceFiles(root: string, signal?: AbortSignal): Promise<ImportedFile[]> {
  const files: ImportedFile[] = []; let bytes = 0
  const visit = async (directory: string, prefix = '') => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted()
      if (entry.name === '.git' || entry.name === '__pycache__' || !prefix && ['node_modules', '.venv', 'venv'].includes(entry.name)) continue
      const path = prefix + entry.name, full = join(directory, entry.name), info = await lstat(full)
      if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw Error(`IMPORT_LINK_UNSUPPORTED: ${path}；原目录保持不变`)
      if (info.isDirectory()) await visit(full, `${path}/`)
      else {
        if (files.length >= 250000 || (bytes += info.size) > 8 * 1024 ** 3) throw Error('IMPORT_SIZE_LIMIT')
        files.push({ path, size: info.size, sha256: await fileDigest(full, signal) })
      }
    }
  }
  await visit(root); return files
}
async function gitOrigin(root: string, environment: Record<string, string>, signal?: AbortSignal): Promise<GitOrigin | undefined> {
  const run = (args: string[]) => execFileDriverSpawn({ command: ['git', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', ...args], cwd: root, env: environment, signal, timeoutMs: 30000 })
  let top
  try { top = await run(['rev-parse', '--show-toplevel']) } catch { return }
  if (top.code !== 0 || await realpath(top.stdout.trim()) !== root) return
  const head = await run(['rev-parse', 'HEAD']), branch = await run(['symbolic-ref', '--short', 'HEAD']), status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (head.code !== 0 || status.code !== 0) throw Error('IMPORT_GIT_STATE_UNREADABLE')
  return { head: head.stdout.trim(), branch: branch.code === 0 ? branch.stdout.trim() : '(detached)', status: status.stdout, status_sha256: hash(status.stdout) }
}
/** Own a copy of the working tree, including the user's current dirty bytes.
 * No reset/clean/add/commit/push or index write occurs in the selected directory. */
export async function importSoftwareProject(sourceDirectory: string, mode: ProjectMode, signal?: AbortSignal) {
  if (!['quick', 'longterm'].includes(mode)) throw Error('IMPORT_MODE_INVALID')
  const source = await realpath(sourceDirectory), stagingBase = join(getPromaHome(), 'software-imports', randomUUID()), staging = join(stagingBase, 'working-copy')
  if (!(await lstat(source)).isDirectory() || inside(source, resolve(stagingBase))) throw Error('IMPORT_SOURCE_CONTAINS_DESTINATION')
  await mkdir(stagingBase, { recursive: true })
  const environment = { ...buildDriverEnv({ env_whitelist: [] } as never, process.env), HOME: stagingBase, USERPROFILE: stagingBase, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(stagingBase, 'no-global-config') }
  const origin = await gitOrigin(source, environment, signal)
  if (!origin && existsSync(join(source, '.git'))) throw Error('IMPORT_GIT_METADATA_UNAVAILABLE: 无法可靠读取原仓库分支/未提交状态，原目录保持不变')
  const before = await sourceFiles(source, signal)
  if (origin) {
    const cloned = await execFileDriverSpawn({ command: ['git', '-c', 'core.hooksPath=', 'clone', '--local', '--no-hardlinks', '--dissociate', '--no-checkout', '--quiet', source, staging], cwd: stagingBase, env: environment, signal, timeoutMs: 300000 })
    if (cloned.code !== 0) throw Error(`IMPORT_GIT_COPY_FAILED: ${cloned.stderr.slice(-1500)}`)
    const index = await execFileDriverSpawn({ command: ['git', '-c', 'core.hooksPath=', 'read-tree', 'HEAD'], cwd: staging, env: environment, signal, timeoutMs: 30000 })
    if (index.code !== 0) throw Error('IMPORT_GIT_BASELINE_FAILED')
    const copiedHead = await execFileDriverSpawn({ command: ['git', 'rev-parse', 'HEAD'], cwd: staging, env: environment, signal, timeoutMs: 10000 })
    if (copiedHead.code !== 0 || copiedHead.stdout.trim() !== origin.head) throw Error('IMPORT_GIT_HEAD_CHANGED')
  } else await mkdir(staging, { recursive: true })
  for (const file of before) {
    signal?.throwIfAborted(); const target = join(staging, file.path)
    await mkdir(dirname(target), { recursive: true }); await copyFile(join(source, file.path), target)
    if (await fileDigest(target, signal) !== file.sha256) throw Error('IMPORT_SOURCE_CHANGED_DURING_COPY')
  }
  const after = await sourceFiles(source, signal), finalOrigin = await gitOrigin(source, environment, signal)
  if (JSON.stringify(before) !== JSON.stringify(after) || JSON.stringify(origin) !== JSON.stringify(finalOrigin)) throw Error('IMPORT_SOURCE_CHANGED_DURING_COPY')
  signal?.throwIfAborted()
  const project = createProject({ request_id: randomUUID(), mode, initial_message: basename(source) }, { workflowVersion: 'software-v1' })
  const destination = resolve(project.root_path)
  if (!inside(resolve(getPromaHome()), destination) || !inside(resolve(getPromaHome(), 'software-imports'), resolve(staging))) throw Error('IMPORT_DESTINATION_INVALID')
  // The destination is the newly created empty owned project, never the source.
  if (existsSync(destination)) { if ((await readdir(destination)).length) throw Error('IMPORT_DESTINATION_NOT_EMPTY'); await rmdir(destination) }
  await rename(staging, destination)
  writeTextFileAtomic(join(getPromaHome(), 'software-imports', `${project.project_id}.json`), JSON.stringify({ version: 1, project_id: project.project_id, source, at: new Date().toISOString(), origin, files: before,
    note: '原目录只读；工作副本保留当前字节。原暂存/未暂存状态保存在origin.status，副本索引以原HEAD为基线，不自动替原用户提交。' }))
  return updateProject(project.project_id, { name: basename(source), imported_source: { path: source, head: origin?.head, branch: origin?.branch, dirty: Boolean(origin?.status), baseline_digest: hash(JSON.stringify(before)) } })
}
export function importedProjectContext(projectId: string) {
  const file = join(getPromaHome(), 'software-imports', `${projectId}.json`)
  if (!existsSync(file)) return undefined
  const metadata = JSON.parse(readFileSync(file, 'utf8')) as { origin?: GitOrigin; files: ImportedFile[] }
  return { existing_project: true, files: metadata.files.length, branch: metadata.origin?.branch, head: metadata.origin?.head, user_dirty: Boolean(metadata.origin?.status),
    guidance: '这是已有工程的工作副本，原目录保持不变。先复用现有入口/测试/锁文件，按具体修改定位，不重铺骨架；原用户改动包含在副本中，提交与移交只说明自己的增量，不自动push或写回原目录。' }
}

/** Compare only the managed copy with its immutable import-time bytes, never
 * reread or mutate the original user's directory. Original dirty bytes are baseline. */
export async function importedProjectChanges(projectId: string, root: string, signal?: AbortSignal) {
  const project = findProject(projectId)
  if (!project.imported_source) return { available: false, reason: 'not_imported', verification: 'unverified' }
  if (await realpath(root) !== await realpath(project.root_path)) throw Error('IMPORT_WORKING_COPY_MISMATCH')
  const metadata = JSON.parse(readFileSync(join(getPromaHome(), 'software-imports', `${projectId}.json`), 'utf8')) as { project_id: string; files: ImportedFile[] }
  if (metadata.project_id !== projectId || !Array.isArray(metadata.files) || hash(JSON.stringify(metadata.files)) !== project.imported_source.baseline_digest) throw Error('IMPORT_BASELINE_INVALID')
  const current = await sourceFiles(root, signal), before = new Map(metadata.files.map(file => [file.path, file])), after = new Map(current.map(file => [file.path, file]))
  const changes = []
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    signal?.throwIfAborted()
    const a = before.get(path), b = after.get(path)
    if (a?.sha256 === b?.sha256 && a?.size === b?.size) continue
    changes.push({ path, change: !a ? 'added' : !b ? 'deleted' : 'changed', before_sha256: a?.sha256, after_sha256: b?.sha256 })
  }
  return { available: true, baseline: project.imported_source.baseline_digest, original_user_dirty: project.imported_source.dirty,
    changes: changes.slice(0, 80), total_changes: changes.length, omitted: Math.max(0, changes.length - 80),
    current_files: current.length, verification: 'unverified', note: '仅比较导入时字节与当前副本；原用户脏修改属于基线。依赖环境与.git不纳入差异，测试/业务结果须实际执行；不读取或写回原目录。' }
}

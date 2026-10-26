import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readLaunchDeclaration, type LaunchDeclaration } from '../desktop/launch-smoke'
import { resolveSoftwareCommand, softwareEnvironment } from './command-runtime'

interface Entry { path: string; size: number; sha256: string }
export interface RuntimeInventory { digest: string; bytes: number; files: Entry[] }
export interface SoftwareRelease { version: 1; id: string; projectId: string; sourceRoot: string; root: string;
  source: RuntimeInventory; runtime: RuntimeInventory; launch: LaunchDeclaration; dependencies: Record<string, string>;
  external_files?: Array<{ path: string; sha256: string }>
  verified?: { version: string; scope: string; at: string } }
const IGNORED = new Set(['.git', '00_HISTORY', '.cache', '__pycache__', '.pytest_cache', 'data-backups'])
const MUTABLE = new Set(['data', '00_VERIFY', '00_UX'])
const CODE = /\.(?:py|js|mjs|cjs|ts|tsx|html|css)$/i
const DEPENDENCIES = new Set(['node_modules', '.venv'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function base(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('RELEASE_PROJECT_INVALID')
  return join(getPromaHome(), 'software-releases', projectId)
}
export async function fileDigest(file: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file, { highWaterMark: 1024 * 1024, signal })) digest.update(bytes)
  return digest.digest('hex')
}
/** Runtime evidence includes binaries/assets/dependencies, with streaming hashes.
 * Only explicitly host-created dependency links may be traversed. */
export async function runtimeInventory(root: string, signal?: AbortSignal, links: Record<string, string> = {}, hostLayout = true): Promise<RuntimeInventory> {
  const files: Entry[] = []; let bytes = 0
  const visit = async (directory: string, prefix = '', mutable = false) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted()
      if (IGNORED.has(entry.name)) continue
      const path = `${prefix}${entry.name}`, full = join(directory, entry.name), info = await lstat(full)
      if (info.isSymbolicLink()) {
        if (!links[path] || await realpath(full) !== await realpath(links[path])) throw Error(`RELEASE_LINK_UNSUPPORTED: ${path} (root: ${root})`)
        await visit(full, `${path}/`, mutable); continue
      }
      if (info.isDirectory()) { await visit(full, `${path}/`, mutable || hostLayout && !prefix && MUTABLE.has(entry.name)); continue }
      if (!info.isFile()) throw Error(`RELEASE_FILE_UNSUPPORTED: ${path}`)
      if (mutable && !CODE.test(entry.name)) continue
      if (files.length >= 250000 || (bytes += info.size) > 8 * 1024 ** 3) throw Error('RELEASE_INVENTORY_LIMIT')
      const sha256 = await fileDigest(full, signal), after = await stat(full)
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw Error('RELEASE_INPUT_CHANGED_DURING_READ')
      files.push({ path, size: info.size, sha256 })
    }
  }
  await visit(await realpath(root))
  return { digest: hash(JSON.stringify(files)), bytes, files }
}
async function copyEntries(source: string, destination: string, entries: Entry[], signal?: AbortSignal, trim = '') {
  await mkdir(destination, { recursive: true })
  for (const entry of entries) {
    signal?.throwIfAborted(); const target = join(destination, entry.path.slice(trim.length))
    await mkdir(dirname(target), { recursive: true }); await copyFile(join(source, entry.path), target, constants.COPYFILE_FICLONE)
    if (await fileDigest(target, signal) !== entry.sha256) throw Error('RELEASE_COPY_INPUT_CHANGED')
  }
}
function relocatedLaunch(launch: LaunchDeclaration, source: string, destination: string): LaunchDeclaration {
  return { ...launch, command: launch.command.map(argument => {
    if (!isAbsolute(argument)) return argument
    const rel = relative(source, argument)
    return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? join(destination, rel) : argument
  }) }
}
export async function prepareSoftwareRelease(projectId: string, sourceRoot: string, signal?: AbortSignal): Promise<SoftwareRelease> {
  const parsed = readLaunchDeclaration(sourceRoot)
  if (!parsed?.ok) throw Error(`RELEASE_LAUNCH_INVALID: ${parsed?.error ?? 'missing LAUNCH.json'}`)
  const { readDataPolicy } = await import('./data-update')
  readDataPolicy(sourceRoot)
  sourceRoot = await realpath(sourceRoot)
  const source = await runtimeInventory(sourceRoot, signal), id = hash(source.digest + randomUUID()), directory = join(base(projectId), id), root = join(directory, 'app')
  await mkdir(directory, { recursive: true })
  const dependencies: Record<string, string> = {}
  for (const dependency of DEPENDENCIES) {
    const entries = source.files.filter(entry => entry.path.startsWith(`${dependency}/`))
    if (!entries.length) continue
    const key = hash(JSON.stringify(entries)), cache = join(getPromaHome(), 'software-dependency-snapshots', key), marker = `${cache}.json`
    try {
      if (hash(await readFile(marker, 'utf8')) !== hash(JSON.stringify(entries))) throw Error('RELEASE_DEPENDENCY_CACHE_INVALID')
      const inventory = await runtimeInventory(cache, signal, {}, false)
      if (JSON.stringify(inventory.files) !== JSON.stringify(entries.map(entry => ({ ...entry, path: entry.path.slice(dependency.length + 1) })))) throw Error('RELEASE_DEPENDENCY_CACHE_CHANGED')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Unique staging, no hard links to mutable development dependencies.
      const staging = `${cache}-${randomUUID()}`
      await copyEntries(sourceRoot, staging, entries, signal, `${dependency}/`)
      await mkdir(dirname(cache), { recursive: true }); await rename(staging, cache); await writeFile(marker, JSON.stringify(entries))
    }
    dependencies[dependency] = cache
  }
  // Failed candidates remain diagnostic artifacts, never become active releases.
  await copyEntries(sourceRoot, root, source.files.filter(entry => !DEPENDENCIES.has(entry.path.split('/')[0])), signal)
  for (const [name, cache] of Object.entries(dependencies)) await symlink(cache, join(root, name), process.platform === 'win32' ? 'junction' : 'dir')
  const relocated = relocatedLaunch(parsed.launch, sourceRoot, root)
  const resolved = resolveSoftwareCommand(root, relocated.command, softwareEnvironment(projectId))
  const launch = { ...relocated, command: resolved.command }
  const external_files: NonNullable<SoftwareRelease['external_files']> = []
  for (const file of [...new Set(launch.command.filter(isAbsolute))]) {
    const rel = relative(root, file)
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) continue
    try { if (!(await stat(file)).isFile()) continue } catch { if (file === launch.command[0]) throw Error('RELEASE_EXTERNAL_RUNTIME_MISSING'); continue }
    external_files.push({ path: await realpath(file), sha256: await fileDigest(file, signal) })
  }
  await writeFile(join(root, 'LAUNCH.json'), JSON.stringify(launch, null, 2))
  if ((await runtimeInventory(sourceRoot, signal)).digest !== source.digest) throw Error('RELEASE_SOURCE_CHANGED_DURING_COPY')
  const runtime = await runtimeInventory(root, signal, dependencies)
  const release: SoftwareRelease = { version: 1, id, projectId, sourceRoot, root, source, runtime, launch, dependencies, external_files }
  writeTextFileAtomic(join(directory, 'release.json'), JSON.stringify(release))
  return release
}
export async function validateSoftwareRelease(projectId: string, release: SoftwareRelease, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(release.id) || release.projectId !== projectId || resolve(release.root) !== resolve(base(projectId), release.id, 'app')) throw Error('RELEASE_IDENTITY_INVALID')
  for (const cache of Object.values(release.dependencies)) {
    const rel = relative(resolve(getPromaHome(), 'software-dependency-snapshots'), resolve(cache))
    if (rel.includes(sep) || !/^[a-f0-9]{64}$/.test(rel)) throw Error('RELEASE_CACHE_PATH_INVALID')
  }
  if ((await runtimeInventory(release.root, signal, release.dependencies)).digest !== release.runtime.digest) throw Error('RELEASE_BYTES_CHANGED')
  for (const file of release.external_files ?? []) if (await fileDigest(file.path, signal) !== file.sha256) throw Error('RELEASE_EXTERNAL_RUNTIME_CHANGED')
}
export async function verifyReleaseSource(release: SoftwareRelease, signal?: AbortSignal) {
  await validateSoftwareRelease(release.projectId, release, signal)
  if ((await runtimeInventory(release.sourceRoot, signal)).digest !== release.source.digest) throw Error('RELEASE_WORKING_SOURCE_CHANGED')
}
/** Only the host after actual candidate checks may call this, never model tools. */
export async function promoteSoftwareRelease(release: SoftwareRelease, evidence: NonNullable<SoftwareRelease['verified']>, signal?: AbortSignal, stillCurrent?: () => boolean) {
  await verifyReleaseSource(release, signal)
  signal?.throwIfAborted()
  if (stillCurrent && !stillCurrent()) throw Error('RELEASE_VERIFICATION_SCOPE_CHANGED')
  release.verified = evidence
  writeTextFileAtomic(join(dirname(release.root), 'release.json'), JSON.stringify(release))
  writeTextFileAtomic(join(base(release.projectId), 'active.json'), JSON.stringify({ id: release.id }))
}
export async function activeSoftwareRelease(projectId: string, signal?: AbortSignal, verifyBytes = true): Promise<SoftwareRelease | undefined> {
  let id: string
  try { ({ id } = JSON.parse(await readFile(join(base(projectId), 'active.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  return loadSoftwareRelease(projectId, id, signal, verifyBytes)
}
export async function loadSoftwareRelease(projectId: string, id: string, signal?: AbortSignal, verifyBytes = true): Promise<SoftwareRelease> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('RELEASE_ACTIVE_ID_INVALID')
  const release = JSON.parse(await readFile(join(base(projectId), id, 'release.json'), 'utf8')) as SoftwareRelease
  if (!release.verified?.version || !release.verified.scope) throw Error('RELEASE_NOT_VERIFIED')
  if (verifyBytes) await validateSoftwareRelease(projectId, release, signal)
  else if (release.projectId !== projectId || release.id !== id || resolve(release.root) !== resolve(base(projectId), id, 'app')) throw Error('RELEASE_IDENTITY_INVALID')
  return release
}
/** Host-only unpublished candidate lookup; this does not grant delivery. */
export async function readSoftwareCandidate(projectId: string, id: string, signal?: AbortSignal): Promise<SoftwareRelease> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw Error('RELEASE_CANDIDATE_ID_INVALID')
  const candidate = JSON.parse(await readFile(join(base(projectId), id, 'release.json'), 'utf8')) as SoftwareRelease
  await validateSoftwareRelease(projectId, candidate, signal); return candidate
}

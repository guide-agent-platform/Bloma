import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { execFileDriverSpawn, buildDriverEnv } from '../desktop/process-driver'
import { mainRootDir } from '../platform/paths'
import { fileDigest } from './release-store'
import { bindManagedRuntime, managedRuntime, validateManagedRuntime, type ManagedRuntime, type RuntimeKind } from './runtime-bindings'

const require = createRequire(import.meta.url)
const semver = createRequire(require.resolve('npm/package.json'))('semver') as { satisfies(version: string, range: string, options?: { loose: boolean }): boolean; validRange(range: string): string | null }
const trustedHosts = new Set(['nodejs.org', 'api.github.com', 'github.com', 'raw.githubusercontent.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
function env() { return buildDriverEnv({ env_whitelist: [] } as never, process.env) }
async function response(url: string, signal?: AbortSignal) {
  if (new URL(url).protocol !== 'https:' || !trustedHosts.has(new URL(url).hostname)) throw Error('RUNTIME_DOWNLOAD_ORIGIN_INVALID')
  const result = await fetch(url, { signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]), headers: { 'User-Agent': 'Bloma-runtime-manager', Accept: 'application/json' } })
  if (!result.ok || !trustedHosts.has(new URL(result.url).hostname) || new URL(result.url).protocol !== 'https:') { await result.body?.cancel(); throw Error(`RUNTIME_DOWNLOAD_HTTP: ${result.status}`) }
  return result
}
async function metadata(url: string, signal?: AbortSignal): Promise<string> {
  const result = await response(url, signal), reader = result.body?.getReader(); if (!reader) throw Error('RUNTIME_DOWNLOAD_EMPTY')
  const chunks: Buffer[] = []; let size = 0
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 4 * 1024 * 1024) throw Error('RUNTIME_METADATA_SIZE_LIMIT'); chunks.push(Buffer.from(next.value)) } }
  finally { await reader.cancel().catch(() => {}) }
  return Buffer.concat(chunks).toString('utf8')
}
async function archive(url: string, checksum: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(checksum)) throw Error('RUNTIME_DOWNLOAD_CHECKSUM_REQUIRED')
  const directory = join(getPromaHome(), 'software-runtimes', 'downloads', randomUUID()); mkdirSync(directory, { recursive: true })
  const result = await response(url, signal), file = join(directory, 'runtime.zip'), handle = await open(file, 'wx'), reader = result.body?.getReader()
  let size = 0
  try {
    if (!reader) throw Error('RUNTIME_DOWNLOAD_EMPTY')
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 256 * 1024 * 1024) throw Error('RUNTIME_DOWNLOAD_SIZE_LIMIT'); await handle.writeFile(next.value) }
  } finally { await handle.close(); await reader?.cancel().catch(() => {}) }
  if (await fileDigest(file, signal) !== checksum) throw Error('RUNTIME_DOWNLOAD_CHECKSUM_MISMATCH')
  const destination = join(getPromaHome(), 'software-runtimes', 'installations', randomUUID()), request = join(directory, 'extract.json')
  writeFileSync(request, JSON.stringify({ archive: file, destination }))
  const extracted = await execFileDriverSpawn({ command: [join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(mainRootDir(), 'templates/tools/extract_runtime_archive.ps1'), '-RequestPath', request], cwd: directory, env: env(), signal, timeoutMs: 120000 })
  unlinkSync(request)
  if (extracted.code !== 0) throw Error(`RUNTIME_EXTRACTION_FAILED: ${extracted.stdout.slice(-1500)} ${extracted.stderr.slice(-500)}`)
  return destination
}
function findExecutable(directory: string, filename: string, depth = 4): string | undefined {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw Error('RUNTIME_ARCHIVE_LINK_UNSUPPORTED')
    const file = join(directory, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === filename) return file
    if (depth && entry.isDirectory()) { const found = findExecutable(file, filename, depth - 1); if (found) return found }
  }
}
export function projectRuntimeRequest(root: string, kind: RuntimeKind): string | undefined {
  if (kind === 'node') {
    const file = join(root, 'package.json'); if (!existsSync(file)) return
    const value = JSON.parse(readFileSync(file, 'utf8')) as { engines?: { node?: unknown } }
    if (value.engines?.node !== undefined && (typeof value.engines.node !== 'string' || !semver.validRange(value.engines.node))) throw Error('PROJECT_NODE_ENGINE_INVALID')
    return value.engines?.node as string | undefined
  }
  const pin = join(root, '.python-version')
  if (existsSync(pin)) { const value = readFileSync(pin, 'utf8').trim(); if (!/^3\.\d+(?:\.\d+)?$/.test(value)) throw Error('PROJECT_PYTHON_PIN_UNSUPPORTED'); return value }
  const project = join(root, 'pyproject.toml')
  return existsSync(project) ? readFileSync(project, 'utf8').match(/^requires-python\s*=\s*["']([^"']+)["']/m)?.[1] : undefined
}
export function satisfies(version: string, request: string, kind: RuntimeKind) {
  const range = kind === 'python' ? request.replaceAll(',', ' ').replaceAll('==', '').replaceAll('~=', '~').replaceAll('.*', '.x') : request
  return Boolean(semver.validRange(range) && semver.satisfies(version, range, { loose: true }))
}
function catalog(kind: string, version: string) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw Error('RUNTIME_VERSION_INVALID')
  return join(getPromaHome(), 'software-runtimes', 'catalog', `${kind}-${version}-${process.platform}-${process.arch}.json`)
}
async function nodeRuntime(request: string, signal?: AbortSignal): Promise<ManagedRuntime> {
  const releases = JSON.parse(await metadata('https://nodejs.org/dist/index.json', signal)) as Array<{ version: string; lts: string | false; files: string[] }>
  if (!Array.isArray(releases)) throw Error('NODE_RELEASE_METADATA_INVALID')
  const compatible = releases.filter(row => /^v\d+\.\d+\.\d+$/.test(row.version) && row.files?.includes('win-x64-zip') && satisfies(row.version, request, 'node'))
  const release = compatible.find(row => row.lts) ?? compatible[0]; if (!release) throw Error(`NODE_COMPATIBLE_RELEASE_MISSING: ${request}`)
  const version = release.version.slice(1), file = catalog('node', version)
  if (existsSync(file)) { try { return validateManagedRuntime(JSON.parse(readFileSync(file, 'utf8'))) } catch { /* a fresh verified copy repairs the binding, never trusts the changed bytes */ } }
  const name = `node-${release.version}-win-x64.zip`, source = `https://nodejs.org/dist/${release.version}/${name}`
  const sums = await metadata(`https://nodejs.org/dist/${release.version}/SHASUMS256.txt`, signal)
  const sha256 = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(parts => parts[1] === name)?.[0]
  if (!sha256) throw Error('NODE_RELEASE_CHECKSUM_MISSING')
  const directory = await archive(source, sha256, signal), executable = findExecutable(directory, 'node.exe')
  if (!executable) throw Error('NODE_ARCHIVE_EXECUTABLE_MISSING')
  const probe = await execFileDriverSpawn({ command: [executable, '-p', 'JSON.stringify({version:process.versions.node,abi:process.versions.modules,platform:process.platform,arch:process.arch,electron:process.versions.electron})'], cwd: directory, env: env(), signal, timeoutMs: 10000 })
  const actual = JSON.parse(probe.stdout.trim()) as { version: string; abi: string; platform: string; arch: string; electron?: string }
  if (probe.code !== 0 || actual.version !== version || actual.platform !== process.platform || actual.arch !== process.arch || actual.electron) throw Error('NODE_RUNTIME_PROBE_FAILED')
  const runtime: ManagedRuntime = { kind: 'node', version, executable, sha256: await fileDigest(executable, signal), platform: process.platform, arch: process.arch,
    abi: actual.abi, request, source, archive_sha256: sha256, license: 'Node.js license included beside executable: LICENSE', at: new Date().toISOString() }
  writeTextFileAtomic(file, JSON.stringify(runtime)); return runtime
}
async function uvExecutable(signal?: AbortSignal) {
  const file = join(getPromaHome(), 'software-runtimes', 'catalog', 'uv.json')
  if (existsSync(file)) {
    const previous = JSON.parse(readFileSync(file, 'utf8')) as { executable: string; sha256: string }
    const rel = relative(join(getPromaHome(), 'software-runtimes'), previous.executable)
    if (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && existsSync(previous.executable) && await fileDigest(previous.executable, signal) === previous.sha256) return previous.executable
  }
  const release = JSON.parse(await metadata('https://api.github.com/repos/astral-sh/uv/releases/latest', signal)) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string; digest?: string }> }
  const name = 'uv-x86_64-pc-windows-msvc.zip', asset = release.assets?.find(value => value.name === name)
  if (!asset || !/^\d+\.\d+\.\d+$/.test(release.tag_name)) throw Error('UV_RELEASE_METADATA_INVALID')
  let checksum = asset.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1]
  if (!checksum) checksum = (await metadata(`https://github.com/astral-sh/uv/releases/download/${release.tag_name}/${name}.sha256`, signal)).trim().split(/\s+/)[0]
  const directory = await archive(asset.browser_download_url, checksum, signal), executable = findExecutable(directory, 'uv.exe')
  if (!executable) throw Error('UV_EXECUTABLE_MISSING')
  writeTextFileAtomic(file, JSON.stringify({ executable, sha256: await fileDigest(executable, signal), archive_sha256: checksum, source: asset.browser_download_url, license: 'MIT OR Apache-2.0; https://github.com/astral-sh/uv' }))
  return executable
}
async function pythonRuntime(request: string, signal?: AbortSignal): Promise<ManagedRuntime> {
  if (!/^(?:3\.\d+(?:\.\d+)?|[<>=!~\d.*,\s]+)$/.test(request) || request.length > 100) throw Error('PYTHON_VERSION_REQUEST_UNSUPPORTED')
  const uv = await uvExecutable(signal), directory = join(getPromaHome(), 'software-runtimes', 'python'), home = join(getPromaHome(), 'software-runtimes', 'uv-home')
  mkdirSync(home, { recursive: true }); mkdirSync(directory, { recursive: true })
  const environment = { ...env(), HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'),
    UV_CACHE_DIR: join(home, 'cache'), UV_PYTHON_INSTALL_DIR: directory, UV_PYTHON_INSTALL_BIN: '0', UV_PYTHON_INSTALL_REGISTRY: '0', UV_NO_CONFIG: '1' }
  const installed = await execFileDriverSpawn({ command: [uv, 'python', 'install', request, '--no-bin', '--no-registry', '--no-config', '--no-progress'], cwd: home, env: environment, signal, timeoutMs: 300000 })
  if (installed.code !== 0) throw Error(`PYTHON_PREPARATION_FAILED: ${installed.stderr.slice(-2000)}`)
  const found = await execFileDriverSpawn({ command: [uv, 'python', 'find', request, '--managed-python', '--no-config'], cwd: home, env: environment, signal, timeoutMs: 10000 })
  if (found.code !== 0 || !found.stdout.trim()) throw Error('PYTHON_MANAGED_ENTRY_INVALID')
  // uv's minor-version alias may point at a different patch after an upgrade.
  // Bind the immutable concrete installation rather than that moving alias.
  const executable = realpathSync(found.stdout.trim()), rel = relative(realpathSync(directory), executable)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw Error('PYTHON_MANAGED_ENTRY_INVALID')
  const probe = await execFileDriverSpawn({ command: [executable, '-I', '-c', 'import sys,json,sqlite3,venv,ctypes;print(json.dumps({"version":".".join(map(str,sys.version_info[:3])),"implementation":sys.implementation.name}))'], cwd: home, env: environment, signal, timeoutMs: 15000 })
  const actual = JSON.parse(probe.stdout.trim()) as { version: string; implementation: string }
  if (probe.code !== 0 || actual.implementation !== 'cpython' || !satisfies(actual.version, request, 'python')) throw Error('PYTHON_RUNTIME_PROBE_FAILED')
  const runtime: ManagedRuntime = { kind: 'python', version: actual.version, executable, sha256: await fileDigest(executable, signal), platform: process.platform, arch: process.arch, request,
    source: 'https://github.com/astral-sh/python-build-standalone (uv verified managed distribution)', license: 'CPython and bundled third-party licenses in managed distribution', at: new Date().toISOString() }
  writeTextFileAtomic(catalog('python', runtime.version), JSON.stringify(runtime)); return runtime
}
const preparing = new Map<string, Promise<ManagedRuntime>>()
export async function prepareSoftwareRuntime(projectId: string, root: string, kind: RuntimeKind, requested?: string, signal?: AbortSignal) {
  if (!['node', 'python'].includes(kind) || process.platform !== 'win32' || process.arch !== 'x64') throw Error('MANAGED_RUNTIME_PLATFORM_UNSUPPORTED: 首期支持Windows x64；其它环境仍可使用已有真实运行时')
  const constraint = projectRuntimeRequest(root, kind), request = requested ?? constraint ?? (kind === 'node' ? '>=22' : '3.13')
  if (kind === 'node' && !semver.validRange(request)) throw Error('NODE_VERSION_REQUEST_INVALID')
  let existing: ManagedRuntime | undefined
  try { existing = managedRuntime(projectId, kind) } catch { /* explicit prepare may repair a corrupted private binding */ }
  if (existing && satisfies(existing.version, request, kind) && (!constraint || satisfies(existing.version, constraint, kind))) return { ...existing, reused: true }
  const cached = join(getPromaHome(), 'software-runtimes', 'catalog')
  if (existsSync(cached)) {
    const candidates = readdirSync(cached).filter(name => name.startsWith(`${kind}-`) && name.endsWith(`-${process.platform}-${process.arch}.json`))
      .map(name => { try { return JSON.parse(readFileSync(join(cached, name), 'utf8')) as ManagedRuntime } catch { return undefined } })
      .filter((value): value is ManagedRuntime => Boolean(value && satisfies(value.version, request, kind) && (!constraint || satisfies(value.version, constraint, kind))))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
    for (const candidate of candidates) {
      try { validateManagedRuntime(candidate); bindManagedRuntime(projectId, candidate); return { ...candidate, reused: true } }
      catch { /* a broken cached installation is never a reason to trust it */ }
    }
  }
  const key = `${kind}:${request}`
  if (preparing.has(key)) throw Error('RUNTIME_PREPARATION_BUSY: 同一运行时正在准备，请稍后复用')
  const work = kind === 'node' ? nodeRuntime(request, signal) : pythonRuntime(request, signal)
  preparing.set(key, work)
  try {
    const runtime = await work
    if (constraint && !satisfies(runtime.version, constraint, kind)) throw Error(`RUNTIME_PROJECT_ENGINE_MISMATCH: ${runtime.version} / ${constraint}`)
    bindManagedRuntime(projectId, runtime); return { ...runtime, reused: false }
  } finally { preparing.delete(key) }
}

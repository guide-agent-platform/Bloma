import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'
import { projectDirectory, resolveSoftwareCommand, softwareEnvironment, bindSoftwareProfile } from './command-runtime'
import { mainRootDir } from '../platform/paths'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'

export interface SoftwareProcessSnapshot {
  purpose?: 'trial' | 'development' | 'acceptance' | 'user'
  source?: string
  data_dir?: string
  root?: string
  internal?: boolean
  id: string; projectId: string; sessionId: string; state: 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'stopped' | 'interrupted'
  pid?: number; code?: number | null; url?: string; ready?: boolean; stdout: string; stderr: string; startedAt: string
}
interface OwnedProcess { snapshot: SoftwareProcessSnapshot; commandKey: string; file: string; child: ChildProcess; abort: () => void; signal?: AbortSignal; timer?: ReturnType<typeof setTimeout>; stopping?: Promise<void>; restart?: (signal: AbortSignal) => Promise<SoftwareProcessSnapshot> }
const processes = new Map<string, OwnedProcess>()
const TAIL = 32768
const pathFor = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('PROCESS_ID_INVALID')
  return join(getPromaHome(), 'software-processes', `${id}.json`)
}
export function redactSoftwareOutput(text: string): string {
  for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value && value.length >= 8) text = text.split(value).join('[REDACTED]')
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
  return text.replace(/((?:api[_-]?key|authorization|password|access[_-]?token|refresh[_-]?token|token|secret)\s*["']?\s*[:=]\s*["']?)[^\s"',};&]+/gi, '$1[REDACTED]')
}
function persist(entry: OwnedProcess) { writeJsonFile(entry.file, { ...entry.snapshot, stdout: redactSoftwareOutput(entry.snapshot.stdout), stderr: redactSoftwareOutput(entry.snapshot.stderr) }) }

export function loopbackUrl(value: string): string {
  const url = new URL(value)
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.hash) throw new Error('PREVIEW_LOOPBACK_URL_REQUIRED')
  return url.toString()
}

export function softwareProcess(projectId: string, id: string, sessionId?: string): SoftwareProcessSnapshot {
  const live = processes.get(id)
  const stored = live?.snapshot ?? readJsonFile<SoftwareProcessSnapshot | undefined>(pathFor(id), undefined)
  if (!stored || stored.projectId !== projectId || sessionId && stored.sessionId !== sessionId) throw new Error('PROCESS_OWNER_MISMATCH')
  // A persisted PID is not permission to inspect/kill a possibly reused PID.
  return { ...stored, ...(!live && ['starting', 'running'].includes(stored.state) ? { state: 'interrupted' as const, ready: false } : {}),
    stdout: redactSoftwareOutput(stored.stdout), stderr: redactSoftwareOutput(stored.stderr) }
}

export async function stopSoftwareProcess(projectId: string, id: string, sessionId?: string): Promise<SoftwareProcessSnapshot> {
  const snapshot = softwareProcess(projectId, id, sessionId), entry = processes.get(id)
  if (entry?.stopping) { await entry.stopping; return softwareProcess(projectId, id, sessionId) }
  if (!entry || !['starting', 'running'].includes(entry.snapshot.state)) return snapshot
  entry.stopping = (async () => {
    entry.snapshot.state = 'stopping'; entry.snapshot.ready = false
    clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort)
    await new Promise<void>(resolve => {
      if (!entry.child.pid || entry.child.exitCode !== null) { resolve(); return }
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(entry.child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { try { entry.child.kill() } catch {} resolve() })
      else { try { process.kill(-entry.child.pid, 'SIGTERM') } catch { try { entry.child.kill() } catch {} } resolve() }
    })
    if (entry.child.exitCode === null && !entry.child.signalCode) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { entry.child.removeListener('exit', done); reject(new Error('PROCESS_STOP_INCOMPLETE')) }, 2500)
      function done() { clearTimeout(timer); resolve() }
      entry.child.once('exit', done)
      if (entry.child.exitCode !== null || entry.child.signalCode) done()
    })
    entry.snapshot.state = 'stopped'; persist(entry)
  })()
  await entry.stopping
  return softwareProcess(projectId, id, sessionId)
}

export async function startSoftwareProcess(input: { root: string; projectId: string; sessionId: string; command: unknown; cwd?: string; url?: string; signal?: AbortSignal; dataDir?: string; readyMs?: number; independentUserApp?: boolean; internal?: boolean; visibleDesktop?:boolean; purpose?: SoftwareProcessSnapshot['purpose'] }): Promise<SoftwareProcessSnapshot> {
  input.signal?.throwIfAborted()
  const cwd = projectDirectory(input.root, input.cwd), url = input.url ? loopbackUrl(input.url) : undefined
  const commandKey = JSON.stringify([cwd, input.command, input.dataDir ?? null, Boolean(input.internal)])
  const source = softwareVerificationFingerprint(input.root)
  if (!input.independentUserApp && url) {
    const existing = [...processes.values()].find(entry => entry.snapshot.projectId === input.projectId && entry.snapshot.sessionId === input.sessionId
      && entry.snapshot.url === url && entry.snapshot.state === 'running' && entry.snapshot.ready && entry.commandKey === commandKey)
    if (existing) {
      if (!source || existing.snapshot.source !== source) throw Error(`PROCESS_SOURCE_CHANGED: process_id=${existing.snapshot.id}；源码已变化，先stop_process再启动，或对已有调试会话reload`)
      return softwareProcess(input.projectId, existing.snapshot.id, input.sessionId)
    }
  }
  if ([...processes.values()].filter(p => p.snapshot.projectId === input.projectId && ['starting', 'running'].includes(p.snapshot.state)).length >= 3) throw new Error('PROCESS_CONCURRENCY_LIMIT: 请先停止不再使用的预览进程')
  if (url) await new Promise<void>((resolve, reject) => {
    const address = new URL(url), probe = createServer()
    probe.once('error', () => reject(new Error('PREVIEW_PORT_ALREADY_IN_USE: 请复用已知进程或选择空闲端口，不能把其它服务当成本次启动成功')))
    probe.listen(Number(address.port || 80), address.hostname.replace(/^\[|\]$/g, ''), () => probe.close(() => resolve()))
  })
  const environment = softwareEnvironment(input.projectId, input.dataDir,input.root)
  if (url && input.purpose === 'trial') { environment.PORT = new URL(url).port; environment.APP_PORT = new URL(url).port }
  const resolved = resolveSoftwareCommand(input.root, input.command, environment)
  resolved.command=bindSoftwareProfile(resolved.command,resolved.env)
  const snapshot: SoftwareProcessSnapshot = { id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, purpose: input.purpose ?? (input.sessionId === 'user-launch' ? 'user' : 'development'), root: projectDirectory(input.root), source, data_dir: environment.APP_DATA_DIR, ...(input.internal ? { internal: true } : {}), state: 'starting', stdout: '', stderr: '', startedAt: new Date().toISOString(), ...(url ? { url } : {}) }
  // Save ownership before spawn. A failure cannot leave an untracked child.
  const file = pathFor(snapshot.id)
  writeJsonFile(file, snapshot)
  const supervisor = input.independentUserApp ? resolved : resolveSoftwareCommand(input.root,
    ['node', join(mainRootDir(), 'templates/tools/software_process_supervisor.cjs')], softwareEnvironment(input.projectId, input.dataDir))
  const child = spawn(supervisor.command[0], supervisor.command.slice(1), { cwd, env: supervisor.env, windowsHide: input.independentUserApp?!input.visibleDesktop:true,
    detached: process.platform !== 'win32' || input.independentUserApp, stdio: [input.independentUserApp ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  child.stdin?.on('error', () => { /* lifecycle error/exit handlers own terminal state */ })
  if (!input.independentUserApp) child.stdin?.write(`${JSON.stringify({ ...resolved, cwd, windowsHide:!input.visibleDesktop })}\n`)
  const entry: OwnedProcess = { snapshot, commandKey, file, child, signal: input.signal, restart: signal => startSoftwareProcess({ ...input, signal }), abort: () => { void stopSoftwareProcess(input.projectId, snapshot.id).catch(() => undefined) } }
  processes.set(snapshot.id, entry)
  for (const [id, previous] of processes) if (processes.size > 128 && !['starting', 'running', 'stopping'].includes(previous.snapshot.state)) processes.delete(id)
  snapshot.pid = child.pid
  const schedule = () => { if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = undefined; try { persist(entry) } catch { entry.abort() } }, 200) }
  child.stdout?.on('data', data => { snapshot.stdout = (snapshot.stdout + data.toString('utf8')).slice(-TAIL); schedule() })
  child.stderr?.on('data', data => { snapshot.stderr = (snapshot.stderr + data.toString('utf8')).slice(-TAIL); schedule() })
  child.once('error', error => { snapshot.state = 'failed'; snapshot.ready = false; snapshot.stderr = error.message; clearTimeout(entry.timer); input.signal?.removeEventListener('abort', entry.abort); try { persist(entry) } catch {} })
  child.once('exit', code => { if (!['stopped', 'stopping'].includes(snapshot.state)) snapshot.state = code === 0 ? 'exited' : 'failed'; snapshot.code = code; snapshot.ready = false;
    clearTimeout(entry.timer); input.signal?.removeEventListener('abort', entry.abort); try { persist(entry) } catch {} })
  input.signal?.addEventListener('abort', entry.abort, { once: true })
  if (input.signal?.aborted) { await stopSoftwareProcess(input.projectId, snapshot.id); input.signal.throwIfAborted() }
  try {
    persist(entry)
    const deadline = Date.now() + (input.readyMs ?? 30000)
    do {
      input.signal?.throwIfAborted()
      if (['failed', 'exited', 'stopped'].includes(snapshot.state)) return softwareProcess(input.projectId, snapshot.id)
      if (!url) { await new Promise(resolve => setTimeout(resolve, 120)); if (snapshot.state === 'starting') snapshot.state = 'running'; break }
      try {
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.any([...(input.signal ? [input.signal] : []), AbortSignal.timeout(700)]) })
        await response.body?.cancel()
        if (response.ok) { snapshot.ready = true; snapshot.state = 'running'; break }
      } catch { /* collect startup output before deciding readiness */ }
      await new Promise(resolve => setTimeout(resolve, 120))
    } while (Date.now() < deadline)
    if (url && !snapshot.ready) { await stopSoftwareProcess(input.projectId, snapshot.id); throw new Error(`PROCESS_NOT_READY: ${snapshot.stderr.slice(-2000) || snapshot.stdout.slice(-2000) || url}`) }
    persist(entry)
    return softwareProcess(input.projectId, snapshot.id)
  } catch (error) { await stopSoftwareProcess(input.projectId, snapshot.id); throw error }
}

export async function stopSoftwareSession(projectId: string, sessionId: string): Promise<void> {
  await Promise.all([...processes.values()].filter(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId)
    .map(entry => stopSoftwareProcess(projectId, entry.snapshot.id, sessionId)))
}
export function activeSoftwarePreview(projectId: string, sessionId?: string): string | undefined {
  return [...processes.values()].find(entry => entry.snapshot.projectId === projectId && !entry.snapshot.internal && !['trial','user'].includes(entry.snapshot.purpose ?? '') && entry.snapshot.sessionId !== 'user-launch'
    && (!sessionId || entry.snapshot.sessionId === sessionId) && entry.snapshot.state === 'running' && entry.snapshot.ready)?.snapshot.url
}
export function hasSoftwareSessionProcess(projectId: string, sessionId: string): boolean {
  return [...processes.values()].some(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId
    && ['starting', 'running', 'stopping'].includes(entry.snapshot.state))
}
/** Attachment requires the live owned handle, never a disk PID or a user app. */
export function ownedSoftwarePreview(projectId: string, sessionId: string, id: string): SoftwareProcessSnapshot {
  const snapshot = softwareProcess(projectId, id, sessionId)
  if (!processes.has(id) || snapshot.internal || ['trial','user'].includes(snapshot.purpose ?? '') || snapshot.state !== 'running' || !snapshot.ready || !snapshot.url || sessionId === 'user-launch') throw Error('DEBUG_PROCESS_NOT_OWNED_AND_READY')
  return snapshot
}
export function matchingOwnedSoftwarePreview(projectId: string, sessionId: string, root: string, url: string) {
  return [...processes.values()].find(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId
    && entry.snapshot.root === projectDirectory(root) && entry.snapshot.url === loopbackUrl(url) && !entry.snapshot.internal
    && entry.snapshot.state === 'running' && entry.snapshot.ready)?.snapshot.id
}
export async function restartOwnedSoftwarePreview(projectId: string, sessionId: string, id: string, signal: AbortSignal): Promise<SoftwareProcessSnapshot> {
  ownedSoftwarePreview(projectId, sessionId, id)
  const restart = processes.get(id)!.restart!
  await stopSoftwareProcess(projectId, id, sessionId); signal.throwIfAborted()
  return restart(signal)
}

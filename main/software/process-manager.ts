import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'
import { projectDirectory, resolveSoftwareCommand, softwareEnvironment } from './command-runtime'

export interface SoftwareProcessSnapshot {
  id: string; projectId: string; sessionId: string; state: 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'stopped' | 'interrupted'
  pid?: number; code?: number | null; url?: string; ready?: boolean; stdout: string; stderr: string; startedAt: string
}
interface OwnedProcess { snapshot: SoftwareProcessSnapshot; file: string; child: ChildProcess; abort: () => void; signal?: AbortSignal; timer?: ReturnType<typeof setTimeout>; stopping?: Promise<void> }
const processes = new Map<string, OwnedProcess>()
const TAIL = 32768
const pathFor = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('PROCESS_ID_INVALID')
  return join(getPromaHome(), 'software-processes', `${id}.json`)
}
export function redactSoftwareOutput(text: string): string {
  for (const [key, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD/i.test(key) && value && value.length >= 8) text = text.split(value).join('[REDACTED]')
  return text.replace(/((?:api[_-]?key|authorization|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]')
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

export async function startSoftwareProcess(input: { root: string; projectId: string; sessionId: string; command: unknown; cwd?: string; url?: string; signal?: AbortSignal; dataDir?: string; readyMs?: number }): Promise<SoftwareProcessSnapshot> {
  input.signal?.throwIfAborted()
  if ([...processes.values()].filter(p => p.snapshot.projectId === input.projectId && ['starting', 'running'].includes(p.snapshot.state)).length >= 3) throw new Error('PROCESS_CONCURRENCY_LIMIT: 请先停止不再使用的预览进程')
  const cwd = projectDirectory(input.root, input.cwd), url = input.url ? loopbackUrl(input.url) : undefined
  if (url) await new Promise<void>((resolve, reject) => {
    const address = new URL(url), probe = createServer()
    probe.once('error', () => reject(new Error('PREVIEW_PORT_ALREADY_IN_USE: 请复用已知进程或选择空闲端口，不能把其它服务当成本次启动成功')))
    probe.listen(Number(address.port || 80), address.hostname.replace(/^\[|\]$/g, ''), () => probe.close(() => resolve()))
  })
  const resolved = resolveSoftwareCommand(input.root, input.command, softwareEnvironment(input.projectId, input.dataDir))
  const snapshot: SoftwareProcessSnapshot = { id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, state: 'starting', stdout: '', stderr: '', startedAt: new Date().toISOString(), ...(url ? { url } : {}) }
  // Save ownership before spawn. A failure cannot leave an untracked child.
  const file = pathFor(snapshot.id)
  writeJsonFile(file, snapshot)
  const child = spawn(resolved.command[0], resolved.command.slice(1), { cwd, env: resolved.env, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const entry: OwnedProcess = { snapshot, file, child, signal: input.signal, abort: () => { void stopSoftwareProcess(input.projectId, snapshot.id).catch(() => undefined) } }
  processes.set(snapshot.id, entry)
  for (const [id, previous] of processes) if (processes.size > 128 && !['starting', 'running'].includes(previous.snapshot.state)) processes.delete(id)
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
export function activeSoftwarePreview(projectId: string): string | undefined {
  return [...processes.values()].find(entry => entry.snapshot.projectId === projectId && entry.snapshot.state === 'running' && entry.snapshot.ready)?.snapshot.url
}

import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'
import { projectDirectory, resolveSoftwareCommand, softwareEnvironment, bindSoftwareProfile } from './command-runtime'
import { mainRootDir } from '../platform/paths'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { createProcessOutput, type ProcessOutput } from './process-output'
import { dependencyInputVersion, isDependencySetup } from './dependency-state'

export interface SoftwareProcessSnapshot {
  kind?: 'service' | 'command'
  completion_reason?: 'exit' | 'timeout' | 'cancelled' | 'host_interrupted'
  output_seq?: number
  output?: ProcessOutput[]
  dependency_setup?: { root: string; input_version: string }
  purpose?: 'trial' | 'development' | 'acceptance' | 'user'
  source?: string
  data_dir?: string
  root?: string
  internal?: boolean
  id: string; projectId: string; sessionId: string; state: 'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'stopped' | 'interrupted'
  pid?: number; code?: number | null; url?: string; ready?: boolean; stdout: string; stderr: string; startedAt: string
}
interface OwnedProcess { snapshot: SoftwareProcessSnapshot; commandKey: string; file: string; child: ChildProcess; abort: () => void; signal?: AbortSignal; timer?: ReturnType<typeof setTimeout>; deadlineTimer?: ReturnType<typeof setTimeout>; stdinClosed?: boolean; stopping?: Promise<void>; restart?: (signal: AbortSignal) => Promise<SoftwareProcessSnapshot> }
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
function visibleOutput(snapshot: SoftwareProcessSnapshot, stream: 'stdout' | 'stderr') {
  return snapshot.kind === 'command' ? (snapshot.output ?? []).filter(line => line.stream === stream).map(line => line.text).join('').slice(-TAIL) : redactSoftwareOutput(snapshot[stream])
}
function persist(entry: OwnedProcess) { writeJsonFile(entry.file, { ...entry.snapshot, stdout: visibleOutput(entry.snapshot, 'stdout'), stderr: visibleOutput(entry.snapshot, 'stderr') }) }
/** Completed one-shot commands have no adoptable PID/handle. */
export function recordCompletedSoftwareCommand(input:{projectId:string;sessionId:string;root:string;dataDir:string;source:string;code:number;stdout:string;stderr:string}):SoftwareProcessSnapshot{
  const snapshot:SoftwareProcessSnapshot={id:randomUUID(),projectId:input.projectId,sessionId:input.sessionId,root:input.root,data_dir:input.dataDir,source:input.source,purpose:'trial',
    state:input.code===0?'exited':'failed',code:input.code,stdout:redactSoftwareOutput(input.stdout).slice(-TAIL),stderr:redactSoftwareOutput(input.stderr).slice(-TAIL),startedAt:new Date().toISOString()}
  writeJsonFile(pathFor(snapshot.id),snapshot);return snapshot
}

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
  return { ...stored, ...(!live && ['starting', 'running', 'stopping'].includes(stored.state) ? { state: 'interrupted' as const, ready: false, completion_reason: 'host_interrupted' as const } : {}),
    stdout: visibleOutput(stored, 'stdout'), stderr: visibleOutput(stored, 'stderr') }
}

export async function stopSoftwareProcess(projectId: string, id: string, sessionId?: string): Promise<SoftwareProcessSnapshot> {
  const snapshot = softwareProcess(projectId, id, sessionId), entry = processes.get(id)
  if (entry?.stopping) { await entry.stopping; return softwareProcess(projectId, id, sessionId) }
  if (!entry || !['starting', 'running'].includes(entry.snapshot.state)) return snapshot
  entry.stopping = (async () => {
    entry.snapshot.state = 'stopping'; entry.snapshot.ready = false
    entry.snapshot.completion_reason ??= 'cancelled'
    clearTimeout(entry.timer); clearTimeout(entry.deadlineTimer); entry.signal?.removeEventListener('abort', entry.abort)
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

export async function startSoftwareProcess(input: { root: string; projectId: string; sessionId: string; command: unknown; cwd?: string; url?: string; signal?: AbortSignal; dataDir?: string; readyMs?: number; independentUserApp?: boolean; internal?: boolean; visibleDesktop?:boolean; purpose?: SoftwareProcessSnapshot['purpose']; kind?: 'service' | 'command'; timeoutMs?: number }): Promise<SoftwareProcessSnapshot> {
  input.signal?.throwIfAborted()
  if (input.kind === 'command' && (input.url || input.independentUserApp || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs! < 100 || input.timeoutMs! > 300000)) throw Error('COMMAND_TIMEOUT_INVALID')
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
  const snapshot: SoftwareProcessSnapshot = { id: randomUUID(), projectId: input.projectId, sessionId: input.sessionId, kind: input.kind ?? 'service', purpose: input.purpose ?? (input.sessionId === 'user-launch' ? 'user' : 'development'), root: projectDirectory(input.root), source, data_dir: environment.APP_DATA_DIR, ...(input.internal ? { internal: true } : {}), state: 'starting', stdout: '', stderr: '', startedAt: new Date().toISOString(), ...(url ? { url } : {}) }
  if (input.kind === 'command' && isDependencySetup(input.command)) snapshot.dependency_setup = { root: cwd, input_version: dependencyInputVersion(cwd, input.command) }
  // Save ownership before spawn. A failure cannot leave an untracked child.
  const file = pathFor(snapshot.id)
  writeJsonFile(file, snapshot)
  const supervisor = input.independentUserApp ? resolved : resolveSoftwareCommand(input.root,
    ['node', join(mainRootDir(), 'templates/tools/software_process_supervisor.cjs')], softwareEnvironment(input.projectId, input.dataDir))
  const child = spawn(supervisor.command[0], supervisor.command.slice(1), { cwd, env: supervisor.env, windowsHide: input.independentUserApp?!input.visibleDesktop:true,
    detached: process.platform !== 'win32' || input.independentUserApp, stdio: [input.independentUserApp ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
  child.stdin?.on('error', () => { /* lifecycle error/exit handlers own terminal state */ })
  if (!input.independentUserApp) child.stdin?.write(`${JSON.stringify({ ...resolved, cwd, windowsHide:!input.visibleDesktop, interactive: input.kind === 'command' })}\n`)
  const entry: OwnedProcess = { snapshot, commandKey, file, child, signal: input.signal, restart: signal => startSoftwareProcess({ ...input, signal }), abort: () => { void stopSoftwareProcess(input.projectId, snapshot.id).catch(() => undefined) } }
  processes.set(snapshot.id, entry)
  for (const [id, previous] of processes) if (processes.size > 128 && !['starting', 'running', 'stopping'].includes(previous.snapshot.state)) processes.delete(id)
  snapshot.pid = child.pid
  const output = createProcessOutput(redactSoftwareOutput)
  const updateOutput = () => Object.assign(snapshot, output.snapshot())
  const schedule = () => { if (!entry.timer) entry.timer = setTimeout(() => { entry.timer = undefined; try { persist(entry) } catch { entry.abort() } }, 200) }
  child.stdout?.on('data', data => { snapshot.stdout = (snapshot.stdout + data.toString('utf8')).slice(-TAIL); output.push('stdout', data); updateOutput(); schedule() })
  child.stderr?.on('data', data => { snapshot.stderr = (snapshot.stderr + data.toString('utf8')).slice(-TAIL); output.push('stderr', data); updateOutput(); schedule() })
  child.once('error', error => { snapshot.state = 'failed'; snapshot.ready = false; snapshot.stderr = error.message;
    output.push('stderr', Buffer.from(error.message + '\n')); output.flush(); updateOutput(); snapshot.completion_reason ??= 'exit';
    clearTimeout(entry.timer); clearTimeout(entry.deadlineTimer); input.signal?.removeEventListener('abort', entry.abort); try { persist(entry) } catch {} })
  child.once(input.kind === 'command' ? 'close' : 'exit', code => { output.flush(); updateOutput(); if (!['stopped', 'stopping'].includes(snapshot.state)) snapshot.state = code === 0 ? 'exited' : 'failed'; snapshot.code = code; snapshot.ready = false;
    snapshot.completion_reason ??= 'exit'; clearTimeout(entry.timer); clearTimeout(entry.deadlineTimer); input.signal?.removeEventListener('abort', entry.abort); try { persist(entry) } catch {} })
  if (input.kind === 'command') entry.deadlineTimer = setTimeout(() => { snapshot.completion_reason = 'timeout'; void stopSoftwareProcess(input.projectId, snapshot.id, input.sessionId).catch(() => {}) }, input.timeoutMs)
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

export function activeSoftwareCommands(projectId: string, sessionId: string) {
  return [...processes.values()].filter(e => e.snapshot.projectId === projectId && e.snapshot.sessionId === sessionId && e.snapshot.kind === 'command' && ['starting','running','stopping'].includes(e.snapshot.state))
    .map(e => ({ process_id: e.snapshot.id, state: e.snapshot.state, started_at: e.snapshot.startedAt, output_seq: e.snapshot.output_seq ?? 0 }))
}
export async function settleSoftwareCommands(projectId: string, sessionId: string, signal: AbortSignal) {
  for (;;) {
    signal.throwIfAborted()
    const commands = activeSoftwareCommands(projectId, sessionId)
    if (!commands.length) return
    await Promise.all(commands.map(command => readSoftwareProcess(projectId, command.process_id, sessionId, command.output_seq, 1000, signal)))
  }
}

export async function readSoftwareProcess(projectId: string, id: string, sessionId: string, since = 0, waitMs = 0, signal?: AbortSignal) {
  if (!Number.isSafeInteger(since) || since < 0 || !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw Error('PROCESS_READ_INVALID')
  signal?.throwIfAborted()
  let snapshot = softwareProcess(projectId, id, sessionId)
  if (snapshot.state !== 'interrupted' && since > (snapshot.output_seq ?? 0)) throw Error('PROCESS_CURSOR_INVALID')
  const entry = processes.get(id)
  if (entry && waitMs && ['starting','running','stopping'].includes(snapshot.state) && (snapshot.output_seq ?? 0) <= since) await new Promise<void>((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); clearInterval(poll); entry.child.off('close', done); signal?.removeEventListener('abort', abort) }
    const done = () => { cleanup(); resolve() }
    const abort = () => { cleanup(); reject(signal?.reason ?? Error('PROCESS_READ_CANCELLED')) }
    const timer = setTimeout(done, waitMs), poll = setInterval(() => { if ((entry.snapshot.output_seq ?? 0) > since) done() }, 50)
    entry.child.once('close', done); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    if (!['starting','running','stopping'].includes(entry.snapshot.state)) done()
  })
  snapshot = softwareProcess(projectId, id, sessionId)
  return { ...snapshot, output: (snapshot.output ?? []).filter(line => line.seq > since),
    output_truncated: since > (snapshot.output_seq ?? 0) || Boolean(snapshot.output?.length && since < snapshot.output[0].seq - 1), next_seq: snapshot.output_seq ?? 0 }
}

export function writeSoftwareProcess(projectId: string, id: string, sessionId: string, text: string, closeStdin = false) {
  const snapshot = softwareProcess(projectId, id, sessionId), entry = processes.get(id)
  if (!entry || snapshot.kind !== 'command' || entry.stdinClosed || !['starting','running'].includes(snapshot.state)) throw Error('PROCESS_INPUT_NOT_AVAILABLE')
  if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || typeof closeStdin !== 'boolean') throw Error('PROCESS_INPUT_INVALID')
  entry.child.stdin!.write(JSON.stringify({ type: 'stdin', data: Buffer.from(text).toString('base64'), close: closeStdin }) + '\n')
  entry.stdinClosed = closeStdin
  return { process_id: id, bytes_queued: Buffer.byteLength(text), stdin_closed: closeStdin }
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

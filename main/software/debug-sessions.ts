import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { Browser, BrowserContext, BrowserServer, Page, Request } from 'playwright'
import type { ChildProcess } from 'node:child_process'
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import { readLaunchDeclaration } from '../desktop/launch-smoke'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { electronEntry, observeGuiStep } from './gui-observer'
import { softwareEnvironment, executeSoftwareCommand } from './command-runtime'
import { mainRootDir } from '../platform/paths'
import { pathToFileURL } from 'node:url'
import { startSoftwareProcess, stopSoftwareSession, softwareProcess, ownedSoftwarePreview, matchingOwnedSoftwarePreview, restartOwnedSoftwarePreview, redactSoftwareOutput } from './process-manager'
import { softwareVerificationFingerprint as verificationFingerprint } from '../desktop/verification-fingerprint'
import { materializeGuiFixtures } from '../desktop/gui-fixtures'
import { observeSoftwareUi } from './ui-observation'
import { debugWorkspace } from './debug-workspace'
import { saveSourceCheckpoint } from './source-checkpoints'
import { isNativeGuiTestModule } from './native-gui-tests'

export interface DebugObservation { seq: number; at: string; version: number; action?: string; kind: string; message: string;
  duration_ms?: number; method?: string; url?: string; status?: number }
export interface DebugSnapshot { id: string; projectId: string; sessionId: string; state: 'opening' | 'ready' | 'closed' | 'failed' | 'interrupted'; version: number; source?: string;
  ui?: Awaited<ReturnType<typeof observeSoftwareUi>>; data_dir?: string; resumed_from?: string;
  stale: boolean; url?: string; screenshot?: string; source_checkpoint?: { id: string; files?: number }; checkpoint_error?: string; fixtures?: GuiAcceptanceSuite['fixtures']; log_cursor?: number; observations_omitted?: number; observations: DebugObservation[]; steps: Array<{ id: string; passed: boolean; actual?: unknown }>; error?: string }
interface DebugSession { snapshot: DebugSnapshot; root: string; temporary: string; workspace: string; data: string; file: string; owner: string; page?: Page;
  child?: ChildProcess; nativeRoot?: number; browser?: BrowserContext; browserClient?: Browser; browserServer?: BrowserServer; externalProcessId?: string; ownedProcessId?: string; stdout?: string; stderr?: string; signal: AbortSignal; abort: () => void;
  activeAction?: string; formal?:boolean; cdpEndpoint?: string; seq: number; logBytes: number; closing?: Promise<void>; finished?: boolean; timer?: ReturnType<typeof setTimeout>; busy: boolean; launch: LaunchDeclaration }
const sessions = new Map<string, DebugSession>()
const observedPages = new WeakSet<Page>()
async function debugTarget(page:Page){const cdp=await page.context().newCDPSession(page);try{return(await cdp.send('Target.getTargetInfo')).targetInfo.targetId as string}finally{await cdp.detach()}}
const metadataPath = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('DEBUG_ID_INVALID')
  return join(getPromaHome(), 'software-debug-sessions', `${id}.json`)
}
function persist(session: DebugSession) {
  writeTextFileAtomic(session.file, JSON.stringify(session.snapshot))
  writeTextFileAtomic(join(session.workspace, 'checkpoint.json'), JSON.stringify(session.snapshot))
}
function savedSnapshot(projectId: string, sessionId: string, id: string): DebugSnapshot {
  const previous = JSON.parse(readFileSync(metadataPath(id), 'utf8')) as DebugSnapshot
  if (previous.projectId !== projectId || previous.sessionId !== sessionId || previous.id !== id) throw Error('DEBUG_SESSION_NOT_OWNED')
  return previous
}
function savedCheckpoint(projectId: string, sessionId: string): DebugSnapshot | undefined {
  const file = join(debugWorkspace(projectId, sessionId), 'checkpoint.json')
  if (!existsSync(file)) return
  const previous = JSON.parse(readFileSync(file, 'utf8')) as DebugSnapshot
  if (previous.projectId !== projectId || previous.sessionId !== sessionId) throw Error('DEBUG_CHECKPOINT_IDENTITY_INVALID')
  return previous
}
export function retainedDebugFixtures(projectId: string, sessionId: string) {
  return savedCheckpoint(projectId, sessionId)?.fixtures ?? []
}
/** Historical observation identity only; it grants no ownership of old PIDs and
 * does not imply that the observed version passed business acceptance. */
export function retainedDebugVersion(projectId: string, sessionId: string) {
  const snapshot = savedCheckpoint(projectId, sessionId)
  return snapshot?.source ? { source: snapshot.source, version: snapshot.version } : undefined
}
function owned(projectId: string, sessionId: string, id: string): DebugSession {
  const session = sessions.get(id)
  if (!session) {
    let previous: DebugSnapshot | undefined
    try { previous = JSON.parse(readFileSync(metadataPath(id), 'utf8')) } catch {}
    if (previous?.projectId === projectId && previous.sessionId === sessionId) throw Error('DEBUG_SESSION_INTERRUPTED: 重启后旧PID不会被接管，请重新打开调试会话')
    throw Error('DEBUG_SESSION_NOT_OWNED')
  }
  if (session.snapshot.projectId !== projectId || session.snapshot.sessionId !== sessionId) throw Error('DEBUG_SESSION_NOT_OWNED')
  return session
}
function log(session: DebugSession, kind: string, message: string, metadata: Partial<Pick<DebugObservation, 'version' | 'action' | 'duration_ms' | 'method' | 'url' | 'status'>> = {}) {
  const entry: DebugObservation = { seq: ++session.seq, at: new Date().toISOString(), version: session.snapshot.version, action: session.activeAction,
    kind, message: redactSoftwareOutput(message).slice(0, 1800), ...metadata }
  session.snapshot.observations.push(entry); session.logBytes += JSON.stringify(entry).length
  while (session.snapshot.observations.length > 200 || session.logBytes > 64000) session.logBytes -= JSON.stringify(session.snapshot.observations.shift()!).length
  if (['opening', 'ready'].includes(session.snapshot.state) && !session.timer) session.timer = setTimeout(() => {
    session.timer = undefined
    try { persist(session) } catch { session.abort() }
  }, 100)
}
function safeUrl(value: string): string {
  try { const url = new URL(value); return redactSoftwareOutput(`${url.origin}${url.pathname}`).slice(0, 1200) } catch { return '[unavailable URL]' }
}
function observePage(session: DebugSession, page: Page) {
  if (observedPages.has(page)) return
  observedPages.add(page)
  page.on('console', event => log(session, `console.${event.type()}`, event.text()))
  page.on('pageerror', error => log(session, 'renderer.error', error.stack || error.message || String(error)))
  const requests = new WeakMap<Request, { start: number; action?: string; version: number; status?: number }>()
  page.on('request', request => requests.set(request, { start: performance.now(), action: session.activeAction, version: session.snapshot.version }))
  page.on('response', response => { const state = requests.get(response.request()); if (state) state.status = response.status() })
  const finished = (request: Request, failed: boolean) => {
    const state = requests.get(request); requests.delete(request)
    const duration = state ? Math.max(0, Math.round(performance.now() - state.start)) : undefined
    // Keep normal traffic out of context. Failed and slow requests retain the
    // originating action/version even when they finish after the tool call.
    if (!failed && (state?.status ?? 0) < 400 && (duration ?? 0) < 1000) return
    const kind = failed ? 'network.failed' : (state?.status ?? 0) >= 400 ? 'network.error' : 'network.slow'
    const url = safeUrl(request.url()), method = request.method()
    log(session, kind, `${method} ${url}: ${failed ? request.failure()?.errorText ?? 'request failed' : `HTTP ${state?.status ?? 'unknown'}`}${duration === undefined ? '' : ` (${duration}ms)`}`,
      { action: state?.action, version: state?.version ?? session.snapshot.version, duration_ms: duration, method, url, status: state?.status })
  }
  page.on('requestfailed', request => finished(request, true))
  page.on('requestfinished', request => finished(request, false))
  page.on('download', download => log(session, 'download', download.suggestedFilename()))
  page.on('close', () => { log(session, 'page.closed', '调试窗口关闭'); if (page === session.page && session.snapshot.state === 'ready') void closeDebugSession(session.snapshot.projectId, session.snapshot.sessionId, session.snapshot.id).catch(() => {}) })
}
async function forceOwnedChild(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return
  if (process.platform === 'win32') await new Promise<void>(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()))
  else child.kill('SIGTERM')
}
async function debugOrigin(signal: AbortSignal) {
  const probe = createServer()
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done) })
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('DEBUG_PORT_UNAVAILABLE')
  await new Promise<void>(done => probe.close(() => done())); signal.throwIfAborted()
  return `http://127.0.0.1:${address.port}`
}
async function openManagedElectron(session: DebugSession, signal: AbortSignal) {
  const entry = electronEntry(session.root, session.launch.command), origin = await debugOrigin(signal)
  session.cdpEndpoint = origin
  const process = await startSoftwareProcess({ root: session.root, projectId: session.snapshot.projectId, sessionId: session.owner,
    command: [entry.executablePath, ...entry.args, `--user-data-dir=${join(session.workspace, 'profile')}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${new URL(origin).port}`],
    url: `${origin}/json/version`, dataDir: session.data, signal, internal: true, visibleDesktop:true })
  session.ownedProcessId = process.id
  session.nativeRoot = process.pid
  const { chromium } = await import('playwright')
  session.browserClient = await chromium.connectOverCDP(origin, { isLocal: true, artifactsDir: join(session.data, 'browser-downloads') })
  session.browser = session.browserClient.contexts()[0]
  if (!session.browser) throw Error('DEBUG_BROWSER_CONTEXT_MISSING')
  session.browser.on('page', page => observePage(session, page))
  session.page = session.browser.pages().find(page => !page.url().startsWith('devtools:')) ?? await session.browser.waitForEvent('page', { timeout: 15000 })
  observePage(session, session.page)
}
export function hasDebugSession(projectId: string, sessionId: string): boolean {
  return [...sessions.values()].some(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId && ['opening', 'ready'].includes(entry.snapshot.state))
}
export function activeDebugSessionId(projectId: string, sessionId: string) {
  return [...sessions.values()].find(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId && ['opening', 'ready'].includes(entry.snapshot.state))?.snapshot.id
}
export function assertDebugSessionProcess(projectId: string, sessionId: string, id: string, processId: string): void {
  const session = owned(projectId, sessionId, id)
  if (processId !== (session.externalProcessId ?? session.ownedProcessId)) throw Error('DEBUG_PROCESS_MISMATCH: 当前调试窗口连接另一进程，请先关闭再连接指定进程')
}
export async function closeDebugSession(projectId: string, sessionId: string, id: string): Promise<DebugSnapshot> {
  const session = owned(projectId, sessionId, id)
  if (session.closing) { await session.closing; return readDebugSession(projectId, sessionId, id) }
  if (session.snapshot.state !== 'failed') session.snapshot.state = 'closed'
  session.signal.removeEventListener('abort', session.abort)
  session.closing = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (session.launch.ui === 'browser' && !session.formal && session.browser) {
        try { const state = await session.browser.storageState(); writeTextFileAtomic(join(session.workspace, 'browser-state.json'), JSON.stringify(state)) }
        catch (error) { log(session, 'state.save_failed', String(error)) }
      }
      if(session.launch.ui==='electron'&&session.browser){
        await Promise.allSettled(session.browser.pages().map(page=>page.close({runBeforeUnload:true})))
        const until=Date.now()+2000
        while(session.ownedProcessId&&Date.now()<until&&['running','starting'].includes(softwareProcess(projectId,session.ownedProcessId,session.owner).state))await new Promise(done=>setTimeout(done,50))
      }
      // Close/flush the browser before stopping its backend; never replace a
      // persistence check by killing both at once and reinjecting cached state.
      await Promise.race([Promise.allSettled([session.browser?.close(), session.browserClient?.close(), session.browserServer?.close()]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DEBUG_CLOSE_TIMEOUT')), 8000) })]) }
    finally {
      clearTimeout(timer); await forceOwnedChild(session.child); await stopSoftwareSession(projectId, session.owner)
      if (existsSync(session.temporary)) {
        const target = realpathSync(session.temporary), tempRoot = realpathSync(tmpdir())
        if (dirname(target) !== tempRoot || !basename(target).startsWith('bloma-debug-')) throw Error('DEBUG_CLEANUP_PATH_INVALID')
        rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 })
      }
      clearTimeout(session.timer); session.timer = undefined; persist(session); session.finished = true
    }
  })()
  await session.closing
  return readDebugSession(projectId, sessionId, id)
}
export async function closeDebugSessions(projectId: string, sessionId: string) {
  const results = await Promise.allSettled([...sessions.values()].filter(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId)
    .map(entry => closeDebugSession(projectId, sessionId, entry.snapshot.id)))
  const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason
}
export async function closeAllDebugSessions() {
  const results = await Promise.allSettled([...sessions.values()].filter(entry => ['opening', 'ready'].includes(entry.snapshot.state))
    .map(entry => closeDebugSession(entry.snapshot.projectId, entry.snapshot.sessionId, entry.snapshot.id)))
  const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason
}
export function hasAnyDebugSession() { return [...sessions.values()].some(entry => ['opening', 'ready'].includes(entry.snapshot.state)) }
export function installDebugFixtures(projectId: string, sessionId: string, id: string, suite: GuiAcceptanceSuite) {
  const session = owned(projectId, sessionId, id)
  if (session.snapshot.state !== 'ready' || session.busy) throw Error('DEBUG_SESSION_NOT_READY')
  materializeGuiFixtures(projectId, suite, session.data)
  session.snapshot.fixtures = [...new Map([...(session.snapshot.fixtures ?? []), ...(suite.fixtures ?? [])].map(file => [file.path, file])).values()]
  persist(session)
}
export function readDebugSession(projectId: string, sessionId: string, id: string, since = 0): DebugSnapshot {
  if (!sessions.has(id)) {
    const previous = savedSnapshot(projectId, sessionId, id)
    return { ...previous, state: 'interrupted', stale: true, error: 'DEBUG_SESSION_INTERRUPTED: 旧进程未接管，下一次操作将用保留数据重新打开。' }
  }
  const session = owned(projectId, sessionId, id), current = verificationFingerprint(session.root)
  const processId = session.externalProcessId ?? session.ownedProcessId
  if (processId && ['ready', 'opening'].includes(session.snapshot.state)) {
    const process = softwareProcess(projectId, processId, session.externalProcessId ? sessionId : session.owner)
    for (const key of ['stdout', 'stderr'] as const) if (process[key] !== (session[key] ?? '')) {
      const previous = session[key] ?? '', delta = process[key].startsWith(previous) ? process[key].slice(previous.length) : process[key].slice(-2000)
      session[key] = process[key]
      const visible = delta.split('\n').filter(line => !/DevTools listening on|Debugger listening on/.test(line)).join('\n').trim()
      if (visible) log(session, `backend.${key}`, visible)
    }
    if (process.state === 'failed' || process.state === 'exited' || process.state === 'stopped') session.snapshot.error = `DEBUG_BACKEND_UNAVAILABLE: ${process.state}`
  }
  const available = session.snapshot.observations.filter(row => row.seq > since), recent = available.slice(-16)
  let characters = recent.reduce((total, row) => total + JSON.stringify(row).length, 0)
  while (characters > 12000 && recent.length > 1) characters -= JSON.stringify(recent.shift()!).length
  return { ...session.snapshot, stale: !current || current !== session.snapshot.source,
    log_cursor: session.seq, observations_omitted: available.length - recent.length,
    observations: recent, steps: [...session.snapshot.steps] }
}
export async function openDebugSession(input: { projectId: string; sessionId: string; root: string; launch: LaunchDeclaration; signal: AbortSignal; processId?: string; formal?:boolean }): Promise<DebugSnapshot> {
  input.signal.throwIfAborted()
  if (hasDebugSession(input.projectId, input.sessionId)) throw Error('DEBUG_SESSION_ALREADY_OPEN: 复用现有debug_session_id，或先close')
  const workspace = debugWorkspace(input.projectId, input.sessionId), previous = savedCheckpoint(input.projectId, input.sessionId)
  const id = randomUUID(), temporary = mkdtempSync(join(tmpdir(), 'bloma-debug-')), source = verificationFingerprint(input.root)
  if (!source) throw Error('DEBUG_SOURCE_UNREADABLE')
  // A borrowed start_service default directory is also host-owned and durable.
  // Arbitrary saved paths are never trusted as a new process data directory.
  const defaultData = softwareEnvironment(input.projectId).APP_DATA_DIR
  const data = previous?.data_dir && resolve(previous.data_dir) === resolve(defaultData) ? defaultData : join(workspace, 'data')
  const session: DebugSession = { root: resolve(input.root), temporary, workspace, data, file: metadataPath(id), owner: `debug-${id}`,
    snapshot: { id, projectId: input.projectId, sessionId: input.sessionId, state: 'opening', version: (previous?.version ?? 0) + 1, source, stale: false, observations: [], steps: [], data_dir: data,
      ...(previous ? { resumed_from: previous.id, fixtures: previous.fixtures, source_checkpoint: previous.source_checkpoint } : {}) },
    signal: input.signal, formal:input.formal, abort: () => { void closeDebugSession(input.projectId, input.sessionId, id).catch(() => {}) }, seq: 0, logBytes: 0, busy: false, launch: input.launch }
  sessions.set(id, session); persist(session); input.signal.addEventListener('abort', session.abort, { once: true })
  for (const [key, previous] of sessions) if (sessions.size > 128 && previous.finished) sessions.delete(key)
  try {
    const { chromium } = await import('playwright')
    if (input.launch.ui === 'electron') {
      if (input.processId) throw Error('DEBUG_ELECTRON_ATTACH_UNSUPPORTED')
      await openManagedElectron(session, input.signal)
    } else if (input.launch.ui === 'browser' && input.launch.url) {
      input.processId ??= matchingOwnedSoftwarePreview(input.projectId, input.sessionId, input.root, input.launch.url)
      const service = input.processId ? ownedSoftwarePreview(input.projectId, input.sessionId, input.processId)
        : await startSoftwareProcess({ root: input.root, projectId: input.projectId, sessionId: session.owner, command: input.launch.command,
          url: input.launch.url, dataDir: session.data, signal: input.signal })
      if (service.root !== resolve(input.root)) throw Error('DEBUG_PROCESS_ROOT_MISMATCH')
      if (!source || service.source !== source) throw Error('DEBUG_PROCESS_SOURCE_CHANGED: 已有服务不是当前源码版本；先stop_process后start_service，不能把旧后端绑定为新代码')
      if (!service.data_dir) throw Error('DEBUG_PROCESS_DATA_DIR_MISSING')
      session.data = service.data_dir; session.snapshot.data_dir = service.data_dir
      session.externalProcessId = input.processId; session.snapshot.url = service.url
      if (!input.processId) session.ownedProcessId = service.id
      if(input.formal){
        session.cdpEndpoint=await debugOrigin(input.signal)
        session.browser=await chromium.launchPersistentContext(join(workspace,'formal-profile'),{headless:true,acceptDownloads:true,
          args:['--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${new URL(session.cdpEndpoint).port}`],
          ...(existsSync(chromium.executablePath())?{executablePath:chromium.executablePath()}:{channel:process.platform==='win32'?'msedge':'chrome'}),env:softwareEnvironment(input.projectId,session.data),timeout:20000})
        session.page=session.browser.pages()[0]??await session.browser.newPage();observePage(session,session.page)
      }else{
      session.browserServer = await chromium.launchServer({ headless: true,
        args: ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${new URL(session.cdpEndpoint = await debugOrigin(input.signal)).port}`],
        ...(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }), env: softwareEnvironment(input.projectId, session.data), timeout: 20000 })
      session.child = session.browserServer.process()
      session.browserClient = await chromium.connectOverCDP(session.cdpEndpoint!, { isLocal: true, artifactsDir: join(session.data, 'browser-downloads') })
      const storage = join(workspace, 'browser-state.json')
      session.browser = session.browserClient.contexts()[0]
      if (!session.browser) throw Error('DEBUG_BROWSER_CONTEXT_MISSING')
      if (existsSync(storage)) await session.browser.setStorageState(storage)
      session.page = await session.browser.newPage(); observePage(session, session.page)
      }
      await session.page.goto(service.url!, { waitUntil: 'domcontentloaded', timeout: 15000 })
    } else throw Error('DEBUG_RUNTIME_UNSUPPORTED: 持续会话首期支持Electron/浏览器；Python仍使用固定GUI检查')
    if (!session.page) throw Error('DEBUG_PAGE_UNAVAILABLE')
    input.signal.throwIfAborted(); session.page.setDefaultTimeout(4000)
    for (const error of await session.page.pageErrors()) log(session, 'renderer.startup_error', error.stack || error.message || String(error))
    session.snapshot.state = 'ready'; persist(session)
    return readDebugSession(input.projectId, input.sessionId, id)
  } catch (error) {
    session.snapshot.error = String(error)
    if (session.closing) { await session.closing.catch(() => {}); session.closing = undefined }
    await closeDebugSession(input.projectId, input.sessionId, id); session.snapshot.state = 'failed'; persist(session); throw error
  }
}
export async function actDebugSession(input: { projectId: string; sessionId: string; id: string; steps?: GuiAcceptanceSuite['steps']; script?: string; phase?:'initial'|'reopened'; nativeTests?: { file: string; phase: string; report: string; trace: string }; timeoutMs?: number; reload?: boolean; signal: AbortSignal }): Promise<DebugSnapshot> {
  const session = owned(input.projectId, input.sessionId, input.id)
  if (session.snapshot.state !== 'ready' || !session.page || session.page.isClosed()) throw Error('DEBUG_SESSION_NOT_READY')
  if (session.busy) throw Error('DEBUG_SESSION_BUSY')
  session.busy = true
  try {
    input.signal.throwIfAborted()
    const restart = async () => {
      const source = verificationFingerprint(session.root); if (!source) throw Error('DEBUG_SOURCE_UNREADABLE')
      const declared = readLaunchDeclaration(session.root)
      const launchKey = (launch: LaunchDeclaration) => JSON.stringify([launch.schema_version, launch.command, launch.ui, launch.mode, launch.url, launch.artifact, launch.window_title])
      if (!declared?.ok || launchKey(declared.launch) !== launchKey(session.launch)) throw Error('DEBUG_LAUNCH_CHANGED: 正常入口声明已改变，请close后重新open；不能把旧入口冒充当前程序')
      session.activeAction = 'reload'; session.snapshot.state = 'opening'
      if (session.launch.ui === 'electron') {
        await stopSoftwareSession(input.projectId, session.owner); await session.browserClient?.close().catch(() => {})
        session.browser = undefined; session.browserClient = undefined
        session.snapshot.version++; session.snapshot.source = source
        await openManagedElectron(session, input.signal)
      } else {
        const service = session.externalProcessId ? await restartOwnedSoftwarePreview(input.projectId, input.sessionId, session.externalProcessId, input.signal)
          : (await stopSoftwareSession(input.projectId, session.owner), await startSoftwareProcess({ root: session.root, projectId: input.projectId, sessionId: session.owner,
            command: session.launch.command, url: session.launch.url, dataDir: session.data, signal: input.signal }))
        if (session.externalProcessId) session.externalProcessId = service.id
        else session.ownedProcessId = service.id
        session.snapshot.version++; session.snapshot.source = source; session.snapshot.url = service.url
        if (!session.page) throw Error('DEBUG_PAGE_UNAVAILABLE_AFTER_RESTART')
        await session.page.goto(service.url!, { waitUntil: 'domcontentloaded' })
      }
      input.signal.throwIfAborted()
      if (!session.page) throw Error('DEBUG_PAGE_UNAVAILABLE_AFTER_RESTART')
      session.page.setDefaultTimeout(4000); session.snapshot.state = 'ready'
      session.snapshot.error = undefined; session.stdout = ''; session.stderr = ''; log(session, 'version.reload', '已重启调试入口以绑定新代码，保留隔离持久数据；旧观察保留原版本编号')
    }
    if (input.reload) await restart()
    else if (readDebugSession(input.projectId, input.sessionId, input.id).stale) throw Error('DEBUG_SOURCE_CHANGED: 先reload以标记新版本；若每次保存业务数据都会触发，核对是否把APP_DATA_DIR覆盖到了项目内，使用宿主提供的工程外数据目录。不能把旧窗口当作新代码')
    session.snapshot.steps = []
    for (const step of input.steps ?? []) {
      input.signal.throwIfAborted(); session.activeAction = step.id
      if (step.kind === 'restart') { await restart(); session.snapshot.steps.push({ id: step.id, passed: true, actual: '正常入口已重启，隔离数据保留' }); continue }
      const bounded = (value: unknown) => typeof value === 'string' && value.length > 2000 ? `${value.slice(0, 2000)}…[省略${value.length - 2000}字符]` : value
      try { const actual = await observeGuiStep(session.page, step, { data: session.data, fixtures: session.snapshot.fixtures, nativeProcessRoot: session.nativeRoot, signal: input.signal }); session.snapshot.steps.push({ id: step.id, passed: true, actual: bounded(actual) }) }
      catch (error) { session.snapshot.steps.push({ id: step.id, passed: false, actual: bounded((error as { actual?: unknown }).actual ?? String(error)) }); log(session, 'action.failed', String(error)); break }
    }
    if (input.script) {
      const script = realpathSync(resolve(session.root, input.script)), rel = relative(realpathSync(session.root), script)
      if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel) || !/\.(?:c|m)?js$/i.test(script)) throw Error('BROWSER_SCRIPT_PROJECT_FILE_REQUIRED')
      if (!session.cdpEndpoint) throw Error('BROWSER_SCRIPT_CONNECTION_UNAVAILABLE')
      session.activeAction = 'browser-script'
      const native=isNativeGuiTestModule(script), report=join(session.workspace,`development-${Date.now()}.jsonl`),trace=report+'.trace.json'
      const command=native?['node','--test','--test-concurrency=1',`--test-reporter=${pathToFileURL(join(mainRootDir(),'templates/tools/node-test-reporter.mjs')).href}`,
        `--test-reporter-destination=${report}`,join(mainRootDir(),'templates/tools/browser-test-runner.mjs')]:['node',join(mainRootDir(),'templates/tools/browser-script.mjs'),script]
      const result = await executeSoftwareCommand({ projectId: input.projectId, root: session.root,
        command, timeoutMs: input.timeoutMs ?? 30000,
        signal: input.signal, dataDir: session.data, browserBinding: { endpoint: session.cdpEndpoint, page: session.page.url(),targetId:await debugTarget(session.page), evidenceDir: join(session.workspace, 'evidence', session.formal ? 'acceptance' : 'development', `${input.phase ?? 'initial'}-${Date.now()}`),
          ...(native?{nativeTest:{file:script,phase:input.phase??'initial',trace}}:{}) } })
      const nativeOutput=native&&existsSync(report)?readFileSync(report,'utf8'):''
      session.snapshot.steps.push({ id: 'browser-script', passed: result.code === 0,
        actual: redactSoftwareOutput((result.code===0?result.stdout:result.stderr||result.stdout)+nativeOutput).slice(-12000) })
      log(session, result.code === 0 ? 'script.completed' : 'script.failed', `Browser script exited ${result.code}`)
    }
    if (input.nativeTests) {
      if (!session.cdpEndpoint) throw Error('GUI_NATIVE_CONNECTION_UNAVAILABLE')
      session.activeAction = 'native-tests'
      const result = await executeSoftwareCommand({ projectId: input.projectId, root: session.root,
        command: ['node','--test','--test-concurrency=1',`--test-reporter=${pathToFileURL(join(mainRootDir(),'templates/tools/node-test-reporter.mjs')).href}`,
          `--test-reporter-destination=${input.nativeTests.report}`,join(mainRootDir(),'templates/tools/browser-test-runner.mjs')],
        dataDir:session.data, signal:input.signal,timeoutMs:input.timeoutMs??180000,
        browserBinding:{endpoint:session.cdpEndpoint,page:session.page.url(),targetId:await debugTarget(session.page),evidenceDir:join(session.workspace,'evidence','acceptance',input.nativeTests.phase),nativeTest:input.nativeTests} })
      session.snapshot.steps.push({id:'native-tests',passed:result.code===0,actual:{exit_code:result.code,stderr:redactSoftwareOutput(result.stderr).slice(-4000)}})
    }
    session.activeAction = undefined
    session.snapshot.ui = await observeSoftwareUi(session.page)
    if (session.launch.ui === 'browser' && !session.formal && session.browser) {
      writeTextFileAtomic(join(session.workspace, 'browser-state.json'), JSON.stringify(await session.browser.storageState()))
    }
    const screenshotDir = join(session.workspace, 'evidence', session.formal ? 'acceptance' : 'development'); mkdirSync(screenshotDir, { recursive: true })
    session.snapshot.screenshot = join(screenshotDir, `v${session.snapshot.version}-${Date.now()}.png`)
    await session.page.screenshot({ path: session.snapshot.screenshot })
    if (!input.nativeTests && !session.snapshot.steps.some(step => !step.passed)
      && !session.snapshot.observations.some(row => row.version === session.snapshot.version && /^renderer\.(?:error|startup_error)$/.test(row.kind))) {
      try {
        session.snapshot.source_checkpoint = saveSourceCheckpoint(input.projectId, input.sessionId, session.root, session.snapshot.source!)
        session.snapshot.checkpoint_error = undefined
      } catch (error) { session.snapshot.checkpoint_error = String(error) }
    }
    persist(session); return readDebugSession(input.projectId, input.sessionId, input.id)
  } catch (error) {
    if (input.reload) { session.snapshot.state = 'failed'; session.snapshot.error = String(error); await closeDebugSession(input.projectId, input.sessionId, input.id) }
    throw error
  } finally { session.activeAction = undefined; session.busy = false }
}

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import type { Browser, BrowserContext, BrowserServer, Page, Request } from 'playwright'
import type { ChildProcess } from 'node:child_process'
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { electronEntry, observeGuiStep } from './gui-observer'
import { softwareEnvironment } from './command-runtime'
import { startSoftwareProcess, stopSoftwareSession, softwareProcess, ownedSoftwarePreview, matchingOwnedSoftwarePreview, restartOwnedSoftwarePreview, redactSoftwareOutput } from './process-manager'
import { softwareVerificationFingerprint as verificationFingerprint } from '../desktop/verification-fingerprint'
import { materializeGuiFixtures } from '../desktop/gui-fixtures'

export interface DebugObservation { seq: number; at: string; version: number; action?: string; kind: string; message: string;
  duration_ms?: number; method?: string; url?: string; status?: number }
export interface DebugSnapshot { id: string; projectId: string; sessionId: string; state: 'opening' | 'ready' | 'closed' | 'failed' | 'interrupted'; version: number; source?: string;
  stale: boolean; url?: string; screenshot?: string; fixtures?: GuiAcceptanceSuite['fixtures']; log_cursor?: number; observations_omitted?: number; observations: DebugObservation[]; steps: Array<{ id: string; passed: boolean; actual?: unknown }>; error?: string }
interface DebugSession { snapshot: DebugSnapshot; root: string; temporary: string; data: string; file: string; owner: string; page?: Page;
  child?: ChildProcess; nativeRoot?: number; browser?: BrowserContext; browserClient?: Browser; browserServer?: BrowserServer; externalProcessId?: string; ownedProcessId?: string; stdout?: string; stderr?: string; signal: AbortSignal; abort: () => void;
  activeAction?: string; seq: number; logBytes: number; closing?: Promise<void>; finished?: boolean; timer?: ReturnType<typeof setTimeout>; busy: boolean; launch: LaunchDeclaration }
const sessions = new Map<string, DebugSession>()
const observedPages = new WeakSet<Page>()
const metadataPath = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('DEBUG_ID_INVALID')
  return join(getPromaHome(), 'software-debug-sessions', `${id}.json`)
}
function persist(session: DebugSession) { writeTextFileAtomic(session.file, JSON.stringify(session.snapshot)) }
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
async function openManagedElectron(session: DebugSession, signal: AbortSignal) {
  const probe = createServer()
  await new Promise<void>((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done) })
  const address = probe.address(); if (!address || typeof address === 'string') throw Error('DEBUG_PORT_UNAVAILABLE')
  await new Promise<void>(done => probe.close(() => done())); signal.throwIfAborted()
  const entry = electronEntry(session.root, session.launch.command), origin = `http://127.0.0.1:${address.port}`
  const process = await startSoftwareProcess({ root: session.root, projectId: session.snapshot.projectId, sessionId: session.owner,
    command: [entry.executablePath, ...entry.args, `--user-data-dir=${join(session.temporary, 'profile')}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${address.port}`],
    url: `${origin}/json/version`, dataDir: session.data, signal, internal: true })
  session.ownedProcessId = process.id
  session.nativeRoot = process.pid
  const { chromium } = await import('playwright')
  session.browserClient = await chromium.connectOverCDP(origin)
  session.browser = session.browserClient.contexts()[0]
  if (!session.browser) throw Error('DEBUG_BROWSER_CONTEXT_MISSING')
  session.browser.on('page', page => observePage(session, page))
  session.page = session.browser.pages().find(page => !page.url().startsWith('devtools:')) ?? await session.browser.waitForEvent('page', { timeout: 15000 })
  observePage(session, session.page)
}
export function hasDebugSession(projectId: string, sessionId: string): boolean {
  return [...sessions.values()].some(entry => entry.snapshot.projectId === projectId && entry.snapshot.sessionId === sessionId && ['opening', 'ready'].includes(entry.snapshot.state))
}
export async function closeDebugSession(projectId: string, sessionId: string, id: string): Promise<DebugSnapshot> {
  const session = owned(projectId, sessionId, id)
  if (session.closing) { await session.closing; return readDebugSession(projectId, sessionId, id) }
  if (session.snapshot.state !== 'failed') session.snapshot.state = 'closed'
  session.signal.removeEventListener('abort', session.abort)
  session.closing = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([Promise.allSettled([session.browser?.close(), session.browserClient?.close(), session.browserServer?.close(), stopSoftwareSession(projectId, session.owner)]),
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
export async function openDebugSession(input: { projectId: string; sessionId: string; root: string; launch: LaunchDeclaration; signal: AbortSignal; processId?: string }): Promise<DebugSnapshot> {
  input.signal.throwIfAborted()
  if (hasDebugSession(input.projectId, input.sessionId)) throw Error('DEBUG_SESSION_ALREADY_OPEN: 复用现有debug_session_id，或先close')
  const id = randomUUID(), temporary = mkdtempSync(join(tmpdir(), 'bloma-debug-')), source = verificationFingerprint(input.root)
  if (!source) throw Error('DEBUG_SOURCE_UNREADABLE')
  const session: DebugSession = { root: resolve(input.root), temporary, data: join(temporary, 'data'), file: metadataPath(id), owner: `debug-${id}`,
    snapshot: { id, projectId: input.projectId, sessionId: input.sessionId, state: 'opening', version: 1, source, stale: false, observations: [], steps: [] },
    signal: input.signal, abort: () => { void closeDebugSession(input.projectId, input.sessionId, id).catch(() => {}) }, seq: 0, logBytes: 0, busy: false, launch: input.launch }
  sessions.set(id, session); persist(session); input.signal.addEventListener('abort', session.abort, { once: true })
  for (const [key, previous] of sessions) if (sessions.size > 128 && previous.finished) sessions.delete(key)
  try {
    const { chromium } = await import('playwright')
    const environment = softwareEnvironment(input.projectId, session.data)
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
      session.externalProcessId = input.processId; session.snapshot.url = service.url
      if (!input.processId) session.ownedProcessId = service.id
      session.browserServer = await chromium.launchServer({ headless: true,
        ...(existsSync(chromium.executablePath()) ? { executablePath: chromium.executablePath() } : { channel: process.platform === 'win32' ? 'msedge' : 'chrome' }), env: environment, timeout: 20000 })
      session.child = session.browserServer.process(); session.browserClient = await chromium.connect(session.browserServer.wsEndpoint())
      session.browser = await session.browserClient.newContext({ acceptDownloads: true }); session.page = await session.browser.newPage(); observePage(session, session.page)
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
export async function actDebugSession(input: { projectId: string; sessionId: string; id: string; steps?: GuiAcceptanceSuite['steps']; reload?: boolean; signal: AbortSignal }): Promise<DebugSnapshot> {
  const session = owned(input.projectId, input.sessionId, input.id)
  if (session.snapshot.state !== 'ready' || !session.page || session.page.isClosed()) throw Error('DEBUG_SESSION_NOT_READY')
  if (session.busy) throw Error('DEBUG_SESSION_BUSY')
  session.busy = true
  try {
    input.signal.throwIfAborted()
    if (input.reload) {
      const source = verificationFingerprint(session.root); if (!source) throw Error('DEBUG_SOURCE_UNREADABLE')
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
        await session.page.goto(service.url!, { waitUntil: 'domcontentloaded' })
      }
      input.signal.throwIfAborted(); session.page.setDefaultTimeout(4000); session.snapshot.state = 'ready'
      session.snapshot.steps = []; session.snapshot.error = undefined; session.stdout = ''; session.stderr = ''; log(session, 'version.reload', '已重启调试入口以绑定新代码，保留隔离持久数据；旧观察保留原版本编号')
    } else if (readDebugSession(input.projectId, input.sessionId, input.id).stale) throw Error('DEBUG_SOURCE_CHANGED: 先reload以标记新版本；若每次保存业务数据都会触发，核对是否把APP_DATA_DIR覆盖到了项目内，使用宿主提供的工程外数据目录。不能把旧窗口当作新代码')
    session.snapshot.steps = []
    for (const step of input.steps ?? []) {
      input.signal.throwIfAborted(); session.activeAction = step.id
      if (step.kind === 'restart') throw Error('GUI_ACTION_UNSUPPORTED_IN_SESSION: 重开检查请用正式验收或关闭后重新open')
      try { const actual = await observeGuiStep(session.page, step, { data: session.data, fixtures: session.snapshot.fixtures, nativeProcessRoot: session.nativeRoot, signal: input.signal }); session.snapshot.steps.push({ id: step.id, passed: true, actual }) }
      catch (error) { session.snapshot.steps.push({ id: step.id, passed: false, actual: (error as { actual?: unknown }).actual ?? String(error) }); log(session, 'action.failed', String(error)); break }
    }
    session.activeAction = undefined
    const screenshotDir = join(getPromaHome(), 'software-debug-sessions', session.snapshot.id); mkdirSync(screenshotDir, { recursive: true })
    session.snapshot.screenshot = join(screenshotDir, `v${session.snapshot.version}-${Date.now()}.png`)
    await session.page.screenshot({ path: session.snapshot.screenshot })
    persist(session); return readDebugSession(input.projectId, input.sessionId, input.id)
  } catch (error) {
    if (input.reload) { session.snapshot.state = 'failed'; session.snapshot.error = String(error); await closeDebugSession(input.projectId, input.sessionId, input.id) }
    throw error
  } finally { session.activeAction = undefined; session.busy = false }
}

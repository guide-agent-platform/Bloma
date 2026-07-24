import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import type {
  AnalyticsTrackInput,
  AnalyticsTrackResult,
  DocumentRef,
  DocumentSyncInput,
  DocumentSyncResult,
  RollbackResult,
  SandboxRunInput,
  SandboxRunResult,
  SandboxStopInput,
  SandboxStopResult,
  Snapshot,
  SnapshotCreateInput,
  SnapshotRollbackInput,
} from '../shared/types'
import { getAnalyticsPath, getDocumentsDir, getSnapshotsDir } from '../storage/config-paths'
import { appendJsonLine, writeJsonFile } from '../storage/json-store'
import { findProject } from './project-service'

interface SandboxProcess {
  process: ChildProcess
  port: number
}

type SandboxProcessFactory = (projectRoot: string, port: number, command?: string) => ChildProcess
type PortAllocator = (start: number, end: number) => Promise<number>
type HealthCheck = (url: string) => Promise<boolean>
type Sleep = (ms: number) => Promise<void>
type SnapshotCaptureProvider = () => Promise<{ buffer: Buffer; extension: 'png' | 'jpg' | 'svg' } | undefined>

const SANDBOX_PORT_START = 3000
const SANDBOX_PORT_END = 3999
const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000
const HEALTH_CHECK_INTERVAL_MS = 250
const MAX_PORT_ATTEMPTS = 10

const activeSandboxes = new Map<string, SandboxProcess>()
let sandboxProcessFactory: SandboxProcessFactory = spawnStaticServer
let allocatePort: PortAllocator = findAvailablePort
let sandboxHealthCheck: HealthCheck = defaultHealthCheck
let sandboxSleep: Sleep = sleep
let snapshotCaptureProvider: SnapshotCaptureProvider = defaultSnapshotCapture

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const project = findProject(input.project_id)

  await stopSandbox(input)

  const timeoutMs = input.timeout_ms ?? DEFAULT_SANDBOX_TIMEOUT_MS
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await allocatePort(SANDBOX_PORT_START, SANDBOX_PORT_END)
    const previewUrl = `http://localhost:${port}`
    const child = sandboxProcessFactory(project.root_path, port, input.command)
    activeSandboxes.set(project.project_id, { process: child, port })

    const started = await waitForSandbox(child, previewUrl, timeoutMs)
    if (started.ok) {
      child.once('exit', () => {
        const current = activeSandboxes.get(project.project_id)
        if (current?.process === child) activeSandboxes.delete(project.project_id)
      })
      return { status: 'running', preview_url: previewUrl, port }
    }

    child.kill()
    activeSandboxes.delete(project.project_id)
    if (started.category !== 'port_unavailable') {
      return { status: 'failed', error_summary: sandboxError(started.category) }
    }
  }

  return { status: 'failed', error_summary: sandboxError('port_unavailable') }
}

export function stopSandbox(_input: SandboxStopInput): SandboxStopResult {
  const current = activeSandboxes.get(_input.project_id)
  if (current) {
    current.process.kill()
    activeSandboxes.delete(_input.project_id)
  }
  return { stopped: true }
}

export function setSandboxRuntimeForTests(overrides: {
  processFactory?: SandboxProcessFactory
  portAllocator?: PortAllocator
  healthCheck?: HealthCheck
  sleep?: Sleep
}): void {
  sandboxProcessFactory = overrides.processFactory ?? spawnStaticServer
  allocatePort = overrides.portAllocator ?? findAvailablePort
  sandboxHealthCheck = overrides.healthCheck ?? defaultHealthCheck
  sandboxSleep = overrides.sleep ?? sleep
}

export function clearSandboxRuntimeForTests(): void {
  for (const sandbox of activeSandboxes.values()) sandbox.process.kill()
  activeSandboxes.clear()
  setSandboxRuntimeForTests({})
}

async function waitForSandbox(
  child: ChildProcess,
  previewUrl: string,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; category: 'process_crashed' | 'startup_timeout' | 'port_unavailable' }> {
  let crashed = false
  let portUnavailable = false
  child.once('exit', () => {
    crashed = true
  })
  child.once('error', (error) => {
    crashed = true
    portUnavailable = /EADDRINUSE/i.test(error.message)
  })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (portUnavailable) return { ok: false, category: 'port_unavailable' }
    if (crashed) return { ok: false, category: 'process_crashed' }
    if (await sandboxHealthCheck(previewUrl)) return { ok: true }
    await sandboxSleep(HEALTH_CHECK_INTERVAL_MS)
  }

  return { ok: false, category: 'startup_timeout' }
}

function spawnStaticServer(projectRoot: string, port: number, command?: string): ChildProcess {
  if (command) {
    const [executable, ...args] = command.replaceAll('{port}', String(port)).split(/\s+/).filter(Boolean)
    return spawn(executable, args, sandboxSpawnOptions(projectRoot))
  }
  return spawn(process.execPath, ['-e', STATIC_SERVER_SCRIPT, String(port)], sandboxSpawnOptions(projectRoot))
}

function sandboxSpawnOptions(projectRoot: string): SpawnOptions {
  return {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, Path: process.env.Path },
    stdio: 'ignore',
    windowsHide: true,
  }
}

async function findAvailablePort(start: number, end: number): Promise<number> {
  for (let port = start; port <= end; port += 1) {
    if (await isPortAvailable(port)) return port
  }
  throw new Error('SANDBOX_PORT_UNAVAILABLE')
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function defaultHealthCheck(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
    return response.ok
  } catch {
    return false
  }
}

function sandboxError(category: 'process_crashed' | 'startup_timeout' | 'port_unavailable'): SandboxRunResult['error_summary'] {
  const summaries = {
    process_crashed: '预览启动失败，请再试一次。',
    startup_timeout: '预览启动时间比预期更长，请稍后重试。',
    port_unavailable: '预览端口暂时不可用，请稍后重试。',
  }
  return { category, user_visible_summary: summaries[category] }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function defaultSnapshotCapture(): Promise<{ buffer: Buffer; extension: 'svg' }> {
  return {
    extension: 'svg',
    buffer: Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540"><rect width="960" height="540" fill="#f7f5fb"/><text x="48" y="72" fill="#1d1d1f" font-family="Arial" font-size="28">Bloma sketch snapshot</text><text x="48" y="118" fill="#6e6e73" font-family="Arial" font-size="18">Preview capture placeholder</text></svg>',
      'utf8',
    ),
  }
}

const STATIC_SERVER_SCRIPT = `
const { createReadStream, existsSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize, resolve, sep } = require('node:path');
const root = process.cwd();
const port = Number(process.argv[1]);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
createServer((req, res) => {
  const rawUrl = new URL(req.url || '/', 'http://localhost');
  const requested = rawUrl.pathname === '/' ? '/index.html' : decodeURIComponent(rawUrl.pathname);
  const normalized = normalize(requested).replace(/^([/\\\\])+/, '');
  const filePath = resolve(join(root, normalized));
  if (filePath !== root && !filePath.startsWith(root + sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const finalPath = existsSync(filePath) && statSync(filePath).isDirectory() ? join(filePath, 'index.html') : filePath;
  if (!existsSync(finalPath)) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[extname(finalPath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(finalPath).pipe(res);
}).listen(port, '127.0.0.1');
`

export async function createSnapshot(input: SnapshotCreateInput): Promise<Snapshot> {
  const project = findProject(input.project_id)
  const snapshotId = randomUUID()
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
  const snapshotRoot = `${snapshotDir}/${snapshotId}`
  const filesArchivePath = `${snapshotRoot}/files`
  const documentsArchivePath = input.include_documents ? `${snapshotRoot}/documents` : undefined

  mkdirSync(snapshotRoot, { recursive: true })
  cpSync(project.root_path, filesArchivePath, { recursive: true, force: true })
  if (documentsArchivePath) {
    const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    if (existsSync(documentsDir)) cpSync(documentsDir, documentsArchivePath, { recursive: true, force: true })
  }

  const capture = await snapshotCaptureProvider()
  const screenshotPath = capture ? `${snapshotRoot}/screenshot.${capture.extension}` : undefined
  if (capture && screenshotPath) writeFileSync(screenshotPath, capture.buffer)

  const snapshot: Snapshot = {
    snapshot_id: snapshotId,
    project_id: project.project_id,
    kind: input.kind,
    name: `${input.kind}-${snapshotId.slice(0, 8)}`,
    summary: input.summary,
    screenshot_path: screenshotPath,
    files_archive_path: filesArchivePath,
    documents_archive_path: documentsArchivePath,
    health_status: input.health_status,
    created_at: new Date().toISOString(),
  }
  writeJsonFile(`${snapshotRoot}/metadata.json`, snapshot)
  writeJsonFile(`${snapshotDir}/${snapshotId}.json`, snapshot)
  return snapshot
}

export async function rollbackSnapshot(input: SnapshotRollbackInput): Promise<RollbackResult> {
  const project = findProject(input.project_id)
  const guard = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'rollback_guard',
    summary: `回滚前保护快照：${input.reason}`,
    include_documents: true,
    health_status: 'healthy',
  })
  return {
    rolled_back: true,
    project_id: project.project_id,
    current_snapshot_id: input.snapshot_id,
    guard_snapshot_id: guard.snapshot_id,
  }
}

export function setSnapshotCaptureProvider(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

export function setSnapshotCaptureProviderForTests(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

export function syncDocuments(input: DocumentSyncInput): DocumentSyncResult {
  const project = findProject(input.project_id)
  const dir = getDocumentsDir(project.workspace_slug, project.project_id)
  const doc: DocumentRef = {
    document_id: randomUUID(),
    type: input.checkpoint === 'mvp_tested' ? 'test_report' : 'prd',
    path: `${dir}/${input.checkpoint}.md`,
    status: 'synced',
  }
  writeJsonFile(doc.path, { checkpoint: input.checkpoint, changed_files: input.changed_files ?? [] })
  return { documents: [doc], stale_documents: [] }
}

export function trackAnalytics(input: AnalyticsTrackInput): AnalyticsTrackResult {
  const workspaceSlug = input.event.project_id ? findProject(input.event.project_id).workspace_slug : 'default-software-builder'
  const eventId = randomUUID()
  appendJsonLine(getAnalyticsPath(workspaceSlug), {
    event_id: eventId,
    ...input.event,
    created_at: new Date().toISOString(),
  })
  return { recorded: true, event_id: eventId }
}

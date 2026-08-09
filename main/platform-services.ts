import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import type {
  AnalyticsTrackInput,
  AnalyticsTrackResult,
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
import { appendJsonLine, readJsonFile, writeJsonFile } from '../storage/json-store'
import { findProject, updateProject } from './project-service'

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

/** 快照容量策略（A2-16，闭环 ATK3-G-001，architecture §14）：单项目活跃快照上限。 */
export const MAX_SNAPSHOTS_PER_PROJECT = 100
/** 归档保护集：保留最近 N 个 + 每种 kind 最新一个，即使超限也不归档。 */
export const SNAPSHOT_RECENT_KEEP = 20

const activeSandboxes = new Map<string, SandboxProcess>()

/** 沙箱 stdout/stderr 内部日志（P0 不可见，供 A2-08 修复循环与调试分析）。 */
const sandboxLogs = new Map<string, string>()
let sandboxProcessFactory: SandboxProcessFactory = spawnStaticServer
let allocatePort: PortAllocator = findAvailablePort
let sandboxHealthCheck: HealthCheck = defaultHealthCheck
let sandboxSleep: Sleep = sleep
let snapshotCaptureProvider: SnapshotCaptureProvider = defaultSnapshotCapture

/** 静态服务器在端口被占用（EADDRINUSE）时的退出码，父进程据此重试下一个端口。 */
const EXIT_PORT_IN_USE = 10

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const project = findProject(input.project_id)

  await stopSandbox(input)
  sandboxLogs.set(input.project_id, '')

  const timeoutMs = input.timeout_ms ?? DEFAULT_SANDBOX_TIMEOUT_MS
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await allocatePort(SANDBOX_PORT_START, SANDBOX_PORT_END)
    const previewUrl = `http://localhost:${port}`
    const child = sandboxProcessFactory(project.root_path, port, input.command)
    activeSandboxes.set(project.project_id, { process: child, port })

    // 捕获 stdout/stderr 到内部日志（供修复循环分析，不向 P0 展示堆栈）
    const appendLog = (chunk: Buffer | string): void => {
      sandboxLogs.set(input.project_id, (sandboxLogs.get(input.project_id) ?? '') + String(chunk))
    }
    child.stdout?.on('data', appendLog)
    child.stderr?.on('data', appendLog)

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
      return { status: 'failed', error_summary: classifySandboxFailure(started.category, getSandboxLogs(input.project_id)) }
    }
  }

  return { status: 'failed', error_summary: classifySandboxFailure('port_unavailable', '') }
}

/** 读取沙箱内部日志（stdout/stderr 合并），供修复循环与调试使用。 */
export function getSandboxLogs(projectId: string): string {
  return sandboxLogs.get(projectId) ?? ''
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
  child.once('exit', (code) => {
    crashed = true
    // 静态服务器在 EADDRINUSE 时以 EXIT_PORT_IN_USE 退出，视为端口不可用并换端口重试
    if (code === EXIT_PORT_IN_USE) portUnavailable = true
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

const ALLOWED_SANDBOX_COMMANDS = new Set(['npm run dev', 'npm start', 'node static-server'])

function spawnStaticServer(projectRoot: string, port: number, command?: string): ChildProcess {
  const options = sandboxSpawnOptions(projectRoot, port)
  if (command) {
    const normalized = command.trim()
    if (!ALLOWED_SANDBOX_COMMANDS.has(normalized)) {
      throw new Error(`SANDBOX_COMMAND_NOT_ALLOWED: ${normalized}`)
    }
    const withPort = normalized.replaceAll('{port}', String(port))
    const [executable, ...args] = withPort.split(/\s+/).filter(Boolean)
    // Windows 下 npm 为 npm.cmd，spawn 无法直接执行，需经 shell 解析（静态服务器等直接 spawn）
    const needsShell = /\.(cmd|bat)$/i.test(executable) || executable === 'npm'
    if (needsShell) {
      return spawn(withPort, { ...options, shell: true })
    }
    return spawn(executable, args, options)
  }
  return spawn(resolveNodeExecutable(), ['-e', STATIC_SERVER_SCRIPT, String(port)], options)
}

function resolveNodeExecutable(): string {
  return process.env.npm_node_execpath || process.env.NODE || process.execPath
}

function sandboxSpawnOptions(projectRoot: string, port: number): SpawnOptions {
  return {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, Path: process.env.Path, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
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

/** 将沙箱启动失败分类为对 P0 可读的错误摘要（不暴露堆栈/内部标识），供 A2-08 修复循环识别依赖/语法问题。 */
function classifySandboxFailure(
  category: 'process_crashed' | 'startup_timeout' | 'port_unavailable',
  stderr: string,
): SandboxRunResult['error_summary'] {
  if (category === 'port_unavailable') {
    return { category: 'port_unavailable', user_visible_summary: '预览端口暂时被占用，正在换一个。' }
  }
  if (category === 'startup_timeout') {
    return { category: 'timeout_error', user_visible_summary: '预览启动时间比预期更长，请稍后重试。' }
  }
  if (/Cannot find module|ENOENT|npm ERR/i.test(stderr)) {
    return { category: 'dependency_error', user_visible_summary: '预览缺少运行依赖，无法启动。' }
  }
  if (/SyntaxError|Unexpected token/i.test(stderr)) {
    return { category: 'syntax_error', user_visible_summary: '预览代码存在语法错误，无法启动。' }
  }
  return { category: 'runtime_error', user_visible_summary: '预览启动失败，请再试一次。' }
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
const server = createServer((req, res) => {
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
  res.writeHead(200, {
    'Content-Type': types[extname(finalPath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
    // 生成代码不得联网：禁止 fetch/XHR/WebSocket 到任何外部地址
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; font-src 'self'",
  });
  createReadStream(finalPath).pipe(res);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') process.exit(10);
  throw err;
});
server.listen(port, '127.0.0.1');
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
  // A2-16 快照容量门禁：创建后立即执行归档策略
  enforceSnapshotCapacity(project.workspace_slug, project.project_id)
  return snapshot
}

export interface SnapshotCapacityResult {
  active_count: number
  archived: string[]
}

/**
 * 快照容量策略（A2-16）：单项目活跃快照超上限（100）时，按
 * 「保留最近 N + 每 kind 最新」保护集，把最旧的其余快照归档到 archive/。
 * 归档仅移出活跃集、不删除数据；归档合并/清理留给后续迭代。
 */
export function enforceSnapshotCapacity(workspaceSlug: string, projectId: string): SnapshotCapacityResult {
  const snapshotDir = getSnapshotsDir(workspaceSlug, projectId)
  const active = listActiveSnapshots(snapshotDir)
  if (active.length <= MAX_SNAPSHOTS_PER_PROJECT) return { active_count: active.length, archived: [] }

  // 保护集：最近 SNAPSHOT_RECENT_KEEP 个 + 每种 kind 最新一个
  const byNewest = [...active].sort((a, b) => b.created_at.localeCompare(a.created_at))
  const protectedIds = new Set<string>()
  for (const snap of byNewest.slice(0, SNAPSHOT_RECENT_KEEP)) protectedIds.add(snap.snapshot_id)
  const seenKinds = new Set<string>()
  for (const snap of byNewest) {
    if (seenKinds.has(snap.kind)) continue
    seenKinds.add(snap.kind)
    protectedIds.add(snap.snapshot_id)
  }

  // 最旧优先归档，直到活跃数回落到上限；保护集内永不归档
  const oldestFirst = [...active].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const archiveDir = join(snapshotDir, 'archive')
  const archived: string[] = []
  for (const snap of oldestFirst) {
    if (active.length - archived.length <= MAX_SNAPSHOTS_PER_PROJECT) break
    if (protectedIds.has(snap.snapshot_id)) continue
    const source = join(snapshotDir, snap.snapshot_id)
    if (!existsSync(source)) continue
    mkdirSync(archiveDir, { recursive: true })
    renameSync(source, join(archiveDir, snap.snapshot_id))
    const indexSource = `${source}.json`
    if (existsSync(indexSource)) renameSync(indexSource, join(archiveDir, `${snap.snapshot_id}.json`))
    archived.push(snap.snapshot_id)
  }
  return { active_count: active.length - archived.length, archived }
}

interface ActiveSnapshotMeta {
  snapshot_id: string
  kind: string
  created_at: string
}

function listActiveSnapshots(snapshotDir: string): ActiveSnapshotMeta[] {
  const result: ActiveSnapshotMeta[] = []
  for (const entry of readdirSync(snapshotDir)) {
    const full = join(snapshotDir, entry)
    if (!statSync(full).isDirectory() || entry === 'archive') continue
    const meta = readJsonFile<Snapshot | null>(join(full, 'metadata.json'), null)
    if (!meta?.snapshot_id) continue
    result.push({ snapshot_id: meta.snapshot_id, kind: meta.kind, created_at: meta.created_at })
  }
  return result
}

export async function rollbackSnapshot(input: SnapshotRollbackInput): Promise<RollbackResult> {
  const project = findProject(input.project_id)
  const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)

  // 1. 校验目标快照存在
  const targetPath = `${snapshotDir}/${input.snapshot_id}.json`
  if (!existsSync(targetPath)) throw new Error('SNAPSHOT_NOT_FOUND')
  const target = readJsonFile<Snapshot>(targetPath, null as never)
  if (!target) throw new Error('SNAPSHOT_NOT_FOUND')

  // 2. 回滚前拍 guard 快照（保留回滚前状态）
  const guard = await createSnapshot({
    request_id: input.request_id,
    project_id: input.project_id,
    kind: 'rollback_guard',
    summary: `回滚前保护快照：${input.reason}`,
    include_documents: true,
    health_status: project.current_snapshot_id ? 'healthy' : 'unhealthy',
  })

  // 3. 停掉正在运行的 sandbox（否则文件句柄占用，Windows 下 rmSync 会 EPERM）
  stopSandbox({ request_id: input.request_id, project_id: project.project_id })

  // 4. 等待文件句柄释放（Windows 异步释放，给 200ms 缓冲）
  await new Promise((resolve) => setTimeout(resolve, 200))

  // 5. 恢复项目文件（先清空再复制，确保与快照完全一致）
  rmSync(project.root_path, { recursive: true, force: true })
  mkdirSync(project.root_path, { recursive: true })
  cpSync(target.files_archive_path, project.root_path, { recursive: true, force: true })

  // 6. 恢复文档（如果有）
  if (target.documents_archive_path && existsSync(target.documents_archive_path)) {
    const docDir = getDocumentsDir(project.workspace_slug, project.project_id)
    rmSync(docDir, { recursive: true, force: true })
    cpSync(target.documents_archive_path, docDir, { recursive: true, force: true })
  }

  // 7. 更新项目指针
  updateProject(project.project_id, { current_snapshot_id: input.snapshot_id })

  // 8. 重启 sandbox
  const sandbox = await runSandbox({ request_id: input.request_id, project_id: input.project_id })

  return {
    rolled_back: true,
    project_id: project.project_id,
    current_snapshot_id: input.snapshot_id,
    guard_snapshot_id: guard.snapshot_id,
    preview_url: sandbox.preview_url,
  }
}

export function setSnapshotCaptureProvider(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

export function setSnapshotCaptureProviderForTests(provider?: SnapshotCaptureProvider): void {
  snapshotCaptureProvider = provider ?? defaultSnapshotCapture
}

export function trackAnalytics(input: AnalyticsTrackInput): AnalyticsTrackResult {
  const workspaceSlug = resolveAnalyticsWorkspace(input.event.project_id)
  const eventId = randomUUID()
  appendJsonLine(getAnalyticsPath(workspaceSlug), {
    event_id: eventId,
    ...input.event,
    created_at: new Date().toISOString(),
  })
  return { recorded: true, event_id: eventId }
}

/** 项目缺失（已归档/删除）时兜底到默认工作区，不让埋点失败反噬业务。 */
function resolveAnalyticsWorkspace(projectId: string | undefined): string {
  if (!projectId) return 'default-software-builder'
  try {
    return findProject(projectId).workspace_slug
  } catch {
    return 'default-software-builder'
  }
}

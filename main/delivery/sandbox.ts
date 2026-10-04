// 沙箱/预览进程宿主（PR3a 自 platform-services 拆出）：进程生命周期、端口分配、健康检查、
// 内嵌零约定文件服务器脚本、real-fullstack spawn 分流（幂等守卫三项比对）。
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  SnapshotDocumentEntry,
  SnapshotDocumentListResult,
  SnapshotRollbackInput,
} from '../../shared/types'
import { getAnalyticsPath, getDocumentsDir, getSnapshotsDir } from '../../storage/config-paths'
import { appendJsonLine, readJsonFile, writeJsonFile } from '../../storage/json-store'
import { readDocumentsManifest } from '../project/document-engine'
import { findProject, updateProject } from '../project/project-service'
import { PRODUCT_CSP } from '../coding/product-csp'

interface SandboxProcess {
  process: ChildProcess
  port: number
  /** 启动命令（幂等守卫据此区分「内嵌静态服务器」与显式命令沙箱，command 不匹配不复用） */
  command?: string
  /** LLM 代理环境签名（完整程序渠道）：env 变化即重启（幂等守卫三项比对之一） */
  envSig: string
  /** R0.3（2026-09-19 狗衆 7601e5ae）：real-fullstack 服务入口指纹（server.js/package.json/
   *  server/ 子树）——server 端代码变更即重启，防「旧进程继续跑旧代码」假反馈。可选字段：
   *  旧沙箱/非 fullstack 一律 null 语义，守卫用 ?? null 归一化比对。 */
  serverSig?: string | null
}

type SandboxProcessFactory = (projectRoot: string, port: number, command?: string, llmEnv?: Record<string, string>) => ChildProcess
type PortAllocator = (start: number, end: number) => Promise<number>
type HealthCheck = (url: string) => Promise<boolean>
type Sleep = (ms: number) => Promise<void>
const SANDBOX_PORT_START = 3000
const SANDBOX_PORT_END = 3999
const DEFAULT_SANDBOX_TIMEOUT_MS = 30_000
const HEALTH_CHECK_INTERVAL_MS = 250
const MAX_PORT_ATTEMPTS = 10
const activeSandboxes = new Map<string, SandboxProcess>()

/** 沙箱 stdout/stderr 内部日志（P0 不可见，供 A2-08 修复循环与调试分析）。 */
const sandboxLogs = new Map<string, string>()
let sandboxProcessFactory: SandboxProcessFactory = spawnStaticServer
let allocatePort: PortAllocator = findAvailablePort
let sandboxHealthCheck: HealthCheck = defaultHealthCheck
let sandboxSleep: Sleep = sleep
/** 静态服务器在端口被占用（EADDRINUSE）时的退出码，父进程据此重试下一个端口。 */
const EXIT_PORT_IN_USE = 10

export async function runSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const project = findProject(input.project_id)

  // 幂等守卫：同一 project 已 running 且健康时直接复用（不 stop 不 spawn）。
  // 消除 runMvpViaAgentLoop 交付前对 loop 内 run_preview 沙箱的冗余重启（preview_url 抖动）；
  // 崩溃/挂起时 map 已被 exit 清理或 healthCheck 失败 → 照常走 stop+spawn 重启。
  // llm_env 签名参与比对（完整程序渠道）：loop 内 run_preview 起的沙箱无 AI 环境，
  // 交付时带 llm_env 的调用必须重启注入，不能复用无环境实例。
  const existing = activeSandboxes.get(project.project_id)
  const llmEnvSig = JSON.stringify(input.llm_env ?? {})
  // R0.3：real-fullstack 服务入口指纹——幂等守卫第四项比对。旧沙箱无 serverSig
  //  （undefined）与 null 归一化后相等：非 fullstack 路径行为字节不变。
  const serverSig: string | null = null // web 线拆除刀3：fullstack 指纹守卫随 web 预览退役（恒 null=行为等价）
  if (
    existing
    && existing.command === (input.command ?? undefined)
    && existing.envSig === llmEnvSig
    && (existing.serverSig ?? null) === (serverSig ?? null)
    && (await sandboxHealthCheck(`http://localhost:${existing.port}`))
  ) {
    return { status: 'running', preview_url: `http://localhost:${existing.port}`, port: existing.port }
  }

  await stopSandbox(input)
  sandboxLogs.set(input.project_id, '')

  const timeoutMs = input.timeout_ms ?? DEFAULT_SANDBOX_TIMEOUT_MS
  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt += 1) {
    const port = await allocatePort(SANDBOX_PORT_START, SANDBOX_PORT_END)
    const previewUrl = `http://localhost:${port}`
    const child = sandboxProcessFactory(project.root_path, port, input.command, input.llm_env)
    activeSandboxes.set(project.project_id, { process: child, port, command: input.command, envSig: llmEnvSig, serverSig })

    // 捕获 stdout/stderr 到内部日志（供修复循环分析，不向 P0 展示堆栈）；W2：真实服务器
    // 可能长呱呱刷屏，环形截尾保留最近 32KB（失败回流/成功尾部部不受影响）
    const appendLog = (chunk: Buffer | string): void => {
      const prev = sandboxLogs.get(input.project_id) ?? ''
      let next = prev + String(chunk)
      if (next.length > 32_768) next = next.slice(-32_768)
      sandboxLogs.set(input.project_id, next)
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

export async function stopSandbox(_input: SandboxStopInput): Promise<SandboxStopResult> {
  const current = activeSandboxes.get(_input.project_id)
  if (current) {
    activeSandboxes.delete(_input.project_id)
    await terminateProcessTree(current.process)
  }
  return { stopped: true }
}

/** 等待进程退出的兜底上限：超过即放弃等待（进程可能已僵死，调用方的 rmSync 重试兜底）。 */
const TERMINATE_WAIT_MS = 2_000

/**
 * 终止沙箱进程并等待其真正退出。Windows 下两个坑（回滚 rmSync 报 EBUSY 的根因）：
 * ① kill() 只是通知，进程退出与 cwd/句柄锁释放是异步的，不等退出就删目录会撞锁；
 * ② shell:true 包装的 npm 命令，kill 只终止 cmd.exe 外壳，真正的 node 孙进程存活
 *   且 cwd 仍锁着项目目录——标记 treeKillWin32 的进程用 taskkill /T /F 整树击杀。
 * （测试注入的 mock 进程无此标记，只走 kill()，不会被真实 taskkill 误伤）
 */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  // 真实运行中进程两字段为 null，已退出为数值/信号串；测试 mock 未定义视为运行中
  const alreadyExited = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null
  if (alreadyExited) return
  if (process.platform === 'win32' && (child as ChildProcess & { treeKillWin32?: boolean }).treeKillWin32 && typeof child.pid === 'number') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else {
    child.kill()
  }
  const exited = new Promise<void>((resolvePromise) => child.once('exit', () => resolvePromise()))
  const giveUp = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, TERMINATE_WAIT_MS))
  await Promise.race([exited, giveUp])
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

function spawnStaticServer(projectRoot: string, port: number, command?: string, llmEnv?: Record<string, string>): ChildProcess {
  // W2 预览引擎（真实脚手架）：按产物标记分流——real-fullstack(spawn node server.js+
  // vendor 供货) / real-static(零约定只读 file server)；旧注入路径(static-server.js 在)
  // 返回 null 走原逻辑，字节级不变。real 标记优先于 command（real 项目的 npm start ≡
  // node server.js，直接 spawn 免 shell 包装树击杀与 npm 查找）。
  const options = sandboxSpawnOptions(projectRoot, port, llmEnv)
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
      const child = spawn(withPort, { ...options, shell: true })
      // shell 包装的进程树：kill 只杀外壳不杀孙进程，Windows 下需整树击杀（见 terminateProcessTree）
      if (process.platform === 'win32') (child as ChildProcess & { treeKillWin32?: boolean }).treeKillWin32 = true
      return child
    }
    return spawn(executable, args, options)
  }
  // 内嵌脚本不占项目目录作 cwd（Windows：进程 cwd 会锁目录，回滚 rmSync 报 EBUSY），
  // 服务根目录改由参数传入；cwd 落在系统临时目录。
  return spawn(resolveNodeExecutable(), ['-e', STATIC_SERVER_SCRIPT, String(port), projectRoot], sandboxSpawnOptions(tmpdir(), port, llmEnv))
}

function resolveNodeExecutable(): string {
  // Electron 下 process.execPath 是 electron.exe 而非 node，不能当作 node 回退；
  // 优先 npm_node_execpath / NODE，最后退回 PATH 上的 node（与 MVP 路径 spawn('node', …) 一致）。
  return process.env.npm_node_execpath || process.env.NODE || 'node'
}

function sandboxSpawnOptions(projectRoot: string, port: number, llmEnv?: Record<string, string>): SpawnOptions {
  return {
    cwd: projectRoot,
    // BLOMA_APP_LLM_*（完整程序渠道）：产物 /api/llm 同源代理的模型环境，密钥只进
    // 本进程，前端代码/项目文件永远拿不到
    env: { PATH: process.env.PATH, Path: process.env.Path, PORT: String(port), ...(llmEnv ?? {}) },
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
    // 404 也算活：服务器已 listening 并正常处理请求——桌面项目根无 index.html，/ 恒 404
    //（确认门批 2026-10-04：UX 草图沙箱首次真机即踩，30s 探活全 404 误判 startup_timeout）。
    // 仅拒 5xx/网络错误：那才是服务没起来或已崩溃。
    return response.ok || response.status === 404
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


const STATIC_SERVER_SCRIPT = `
const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize, resolve, sep } = require('node:path');
// 服务根目录由参数传入（cwd 已挪到系统临时目录，避免 Windows 下进程 cwd 锁住项目目录）
const root = resolve(process.argv[2]);
const port = Number(process.argv[1]);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml' };
// ---- 后端路由自动挂载（完整程序阶段 1，2026-09-06；与产物 static-server.js 模板同构）----
const ROUTES_DIR = join(root, 'server', 'routes');
const DATA_DIR = join(root, 'data');
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function dataPath(name) {
  const safe = normalize(String(name || '')).replace(/^([/\\\\.]+)+/, '');
  const p = resolve(join(DATA_DIR, safe + (extname(safe) ? '' : '.json')));
  if (!p.startsWith(DATA_DIR + sep)) throw new Error('bad_data_path');
  return p;
}
function readData(name, fallback) {
  try { return JSON.parse(readFileSync(dataPath(name), 'utf8')); } catch (e) { return fallback; }
}
function writeData(name, value) {
  const p = dataPath(name);
  mkdirSync(p.slice(0, p.lastIndexOf(sep)), { recursive: true });
  const tmp = p + '.tmp';
  require('node:fs').writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  require('node:fs').renameSync(tmp, p);
}
const routes = [];
// B1（P0-B，2026-09-11）：挂载失败登记——不再只进 console，供 /_bloma/routes 健康端点回流（与产物模板同构）
const routeErrors = [];
function loadRoutes() {
  routes.length = 0;
  routeErrors.length = 0;
  if (!existsSync(ROUTES_DIR)) return;
  for (const file of readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort()) {
    try {
      const fileUrl = join(ROUTES_DIR, file);
      // 热加载：应用可在预览运行中写路由文件，删 require 缓存让下一次请求拿到新代码
      delete require.cache[require.resolve(fileUrl)];
      const mod = require(fileUrl);
      const prefix = '/api/' + file.replace(/\\.js$/, '');
      const ctx = { dataDir: DATA_DIR, readData: readData, writeData: writeData, sendJson: sendJson };
      for (const [key, handler] of Object.entries(mod || {})) {
        const m = /^(GET|POST|PUT|PATCH|DELETE)\\s+\\/(.*)$/.exec(key);
        if (!m || typeof handler !== 'function') continue;
        // 裸 '/' 路由挂成 /api/<前缀>（无尾斜杠），与请求侧的尾斜杠归一化对齐
        const routePath = ('/' + prefix.slice(1) + '/' + m[2].replace(/^\\/+/, '')).replace(/\\/+$/, '');
        routes.push({ method: m[1], path: routePath, handler: handler, ctx: ctx });
      }
    } catch (e) {
      routeErrors.push({ file: file, message: String((e && e.message) || e).slice(0, 300) });
      console.error('[routes] 挂载失败 ' + file + ': ' + (e && e.message));
    }
  }
}
function matchRoute(method, pathname) {
  for (let i = routes.length - 1; i >= 0; i -= 1) {
    const r = routes[i];
    if (r.method !== method) continue;
    if (r.path === pathname) return r;
    const rp = r.path.split('/'); const ap = pathname.split('/');
    if (rp.length === ap.length && rp.some((s) => s.startsWith(':')) && rp.every((s, j) => s.startsWith(':') || s === ap[j])) {
      const params = {}; rp.forEach((s, j) => { if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(ap[j]); });
      return { ...r, params: params };
    }
  }
  return undefined;
}
async function handleApi(req, res, rawUrl) {
  loadRoutes();
  const hit = matchRoute(req.method, rawUrl.pathname.replace(/\\/+$/, '') || rawUrl.pathname);
  if (!hit) { sendJson(res, 404, { error: 'not_found' }); return; }
  const query = Object.fromEntries(rawUrl.searchParams.entries());
  let body = undefined;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const raw = await new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 512 * 1024) req.destroy(); }); req.on('end', () => ok(s)); req.on('error', () => ok(s)); });
    if (raw) { try { body = JSON.parse(raw); } catch (e) { sendJson(res, 400, { error: 'bad_json' }); return; } }
  }
  try { await hit.handler(req, res, { ...hit.ctx, query: query, body: body, params: hit.params || {} }); }
  catch (e) { sendJson(res, 500, { error: 'route_error', message: String(e && e.message || e).slice(0, 200) }); }
}
// ---- 同源 AI 代理（Bloma 完整程序渠道，2026-09-06；与产物模板同构）----
// 前端 CSP 只放行同源（connect-src 'self'），浏览器永远不直接出网；需要真实模型
// 能力的功能统一 POST /api/llm，由本进程（Bloma 注入 BLOMA_APP_LLM_* 环境变量）
// 代为出网。密钥只存在于本进程环境变量，绝不写入前端代码/项目文件。
const LLM_BASE = (process.env.BLOMA_APP_LLM_BASE_URL || '').replace(/\\/+$/, '');
const LLM_KEY = process.env.BLOMA_APP_LLM_KEY || '';
const LLM_MODEL = process.env.BLOMA_APP_LLM_MODEL || '';
const LLM_PROTOCOL = process.env.BLOMA_APP_LLM_PROTOCOL === 'anthropic' ? 'anthropic' : 'openai';
const LLM_TIMEOUT_MS = Number(process.env.BLOMA_APP_LLM_TIMEOUT_MS) || 60000;
const server = createServer((req, res) => {
  const rawUrl = new URL(req.url || '/', 'http://localhost');
  // ---- B1 健康端点：路由挂载状态（与产物模板同构；api-contract 探针 404 时取真实报错）----
  if (rawUrl.pathname === '/_bloma/routes' && req.method === 'GET') {
    loadRoutes();
    sendJson(res, 200, { mounted: routes.map((r) => ({ method: r.method, path: r.path })), errors: routeErrors });
    return;
  }
  if (rawUrl.pathname === '/api/llm' && (req.method === 'POST' || req.method === 'OPTIONS')) {
    if (req.method === 'OPTIONS') { res.writeHead(403); res.end('Forbidden'); return; }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 512 * 1024) req.destroy(); });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (e) { sendJson(res, 400, { error: 'bad_json' }); return; }
      const messages = Array.isArray(body.messages) ? body.messages : [];
      if (body.mock) {
        if (body.mock === 'fail') { sendJson(res, 200, { error: 'mock_failure' }); return; }
        const lastUser = messages.slice().reverse().find((m) => m && m.role === 'user');
        const topic = lastUser && typeof lastUser.content === 'string' ? lastUser.content.slice(0, 80) : '';
        sendJson(res, 200, { content: '【模拟应答】已根据「' + topic + '」生成确定性结果（GWT mock 模式）。' });
        return;
      }
      if (!LLM_BASE || !LLM_KEY || !LLM_MODEL) { sendJson(res, 503, { error: 'llm_not_configured' }); return; }
      if (typeof fetch !== 'function') { sendJson(res, 500, { error: 'node_too_old' }); return; }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
      const headers = { 'Content-Type': 'application/json' };
      let upstreamUrl;
      let upstreamBody;
      if (LLM_PROTOCOL === 'anthropic') {
        upstreamUrl = LLM_BASE + '/v1/messages';
        headers['x-api-key'] = LLM_KEY;
        headers['anthropic-version'] = '2023-06-01';
        upstreamBody = { model: LLM_MODEL, max_tokens: Number(body.max_tokens) || 1024, messages: messages };
      } else {
        upstreamUrl = LLM_BASE + '/chat/completions';
        headers['Authorization'] = 'Bearer ' + LLM_KEY;
        upstreamBody = { model: LLM_MODEL, messages: messages, temperature: body.temperature, max_tokens: Number(body.max_tokens) || 1024, stream: false };
      }
      fetch(upstreamUrl, { method: 'POST', headers: headers, body: JSON.stringify(upstreamBody), signal: controller.signal })
        .then(async (upstream) => {
          clearTimeout(timer);
          let data = {};
          try { data = JSON.parse(await upstream.text()); } catch (e) { data = {}; }
          if (!upstream.ok) { sendJson(res, upstream.status, { error: 'upstream_error', status: upstream.status }); return; }
          const content = LLM_PROTOCOL === 'anthropic'
            ? (Array.isArray(data.content) ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('') : '')
            : (data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content || '' : '');
          sendJson(res, 200, { content: content });
        })
        .catch((err) => {
          clearTimeout(timer);
          sendJson(res, 502, { error: 'upstream_failed', message: String(err && err.message || err).slice(0, 200) });
        });
    });
    return;
  }
  if (rawUrl.pathname.startsWith('/api/')) { handleApi(req, res, rawUrl).catch(() => { try { sendJson(res, 500, { error: 'route_error' }); } catch (e) {} }); return; }
  // 后端专属目录不走静态托管：server/ 是路由代码、data/ 是运行数据，前端一律经 /api 访问
  const staticRel = rawUrl.pathname.replace(/^\\/+/, '');
  if (staticRel === 'server' || staticRel.startsWith('server/') || staticRel === 'data' || staticRel.startsWith('data/')) {
    res.writeHead(404);
    res.end('Not found');
    return;
  }
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
    // 生成代码不得联网：CSP 只放行同源 connect-src（完整程序渠道：AI 能力走同源
    // /api/llm 代理，由服务器进程出网），浏览器直连外部地址仍被硬拦截。
    // script-src 不再保留 'unsafe-eval'（2026-08-17 设计 §7.0/FEAS-C3 收紧）：eval/Function()
    // 的禁令原本只写在提示词里（CSP 实含 unsafe-eval、并不拦截），收紧后该约束被真正
    // 强制——MVP 提示词已同步要求用显式 if/switch 或事件监听实现交互逻辑。
    // CSP 单一真相源：main/coding/product-csp.ts（沙箱脚本与产物模板两处同构引用）。
    'Content-Security-Policy': ${JSON.stringify(PRODUCT_CSP)},
  });
  createReadStream(finalPath).pipe(res);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') process.exit(10);
  throw err;
});
server.listen(port, '127.0.0.1');
`


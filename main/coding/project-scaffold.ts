/**
 * ProjectScaffold — 平台托管的系统接管文件（package.json / static-server.js）。
 *
 * Agent Loop 的工具集（write_file/edit_file）无权写这两个「系统接管」文件（agent-tools 拒绝），
 * 因此它们由平台在 loop 结束后补齐。原属 mvp-engine.ts（模板引擎），废旧管道改造后模板引擎
 * 整体删除，仅保留这两个平台托管文件渲染函数——loop 是唯一运行时，产物骨架也由 loop 产出。
 *
 * PR-1 骨架先行（2026-09-03）：新增 renderSkeletonToProject——loop 启动前把骨架包
 * （main/templates/skeletons/{type}/）确定性渲染到项目根（无 LLM，纯 fs）。已存在的
 * 文件一律跳过（幂等：迭代重跑/恢复场景不覆盖既有产物）；渲染失败由调用方回退
 * 「无骨架现状」并落决策日志（skeleton_render_failed），绝不阻断 MVP 生成。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PRODUCT_CSP } from './product-csp'
import type { ProjectSkeleton } from '../project-templates'

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

export function renderPackageJson(projectName: string): string {
  const slug = slugify(projectName) || 'bloma-mvp'
  return `${JSON.stringify(
    {
      name: slug,
      version: '0.1.0',
      private: true,
      scripts: { start: 'node static-server' },
    },
    null,
    2,
  )}\n`
}

/** 自包含应用服务器：读取 PORT 环境变量（沙箱注入），带路径穿越防护与 CSP 网络隔离。
 * 完整程序阶段 1（2026-09-06）：泛化为「静态托管 + 后端 API 服务器」——自动挂载
 * server/routes/*.js 为 /api/* 端点（前后端分离），数据持久化到项目 data/ 目录，
 * /api/llm 同源 AI 代理（密钥经 BLOMA_APP_LLM_* 只进本进程）。 */
export function renderStaticServer(): string {
  return `// 自包含应用服务器（Bloma MVP 模板：静态托管 + server/routes 自动挂载 + /api/llm 代理）
const { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize, resolve, sep } = require('node:path');
const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
// ---- 后端路由自动挂载（完整程序阶段 1，2026-09-06）----
// server/routes/*.js 由应用编写：module.exports = { 'GET /path': async (req, res, ctx) => {...} }；
// 文件名成为路由前缀（notes.js → /api/notes/*），启动时一次性挂载。ctx = { dataDir, json, readData, writeData }
// 数据持久化目录 data/（重启不丢；服务只读写该目录，路径穿越防护同静态托管）。
const ROUTES_DIR = join(root, 'server', 'routes');
const DATA_DIR = join(root, 'data');
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
// data/ 读写助手（原子写：先写临时文件再改名，防半截文件）
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
  mkdirSync(dirnameOf(p), { recursive: true });
  const tmp = p + '.tmp';
  require('node:fs').writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  require('node:fs').renameSync(tmp, p);
}
function dirnameOf(p) { const i = p.lastIndexOf(sep); return i <= 0 ? p.slice(0, 1) : p.slice(0, i); }
const routes = [];
// B1（P0-B，2026-09-11 审计案 35c1a633）：挂载失败登记——不再只进 console，供 /_bloma/routes 健康端点回流
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
        routes.push({ method: m[1], path: routePath });
        routes[routes.length - 1].handler = handler;
        routes[routes.length - 1].ctx = ctx;
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
    // 尾参通配：路由尾 /:id 之类的段按单段通配匹配
    const rp = r.path.split('/'); const ap = pathname.split('/');
    if (rp.length === ap.length && rp.some((s, j) => s.startsWith(':')) && rp.every((s, j) => s.startsWith(':') || s === ap[j])) {
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
  // 查询参数透传；body 限 512KB，JSON 解析失败如实 400
  const query = Object.fromEntries(rawUrl.searchParams.entries());
  let body = undefined;
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    const raw = await new Promise((ok) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 512 * 1024) req.destroy(); }); req.on('end', () => ok(s)); req.on('error', () => ok(s)); });
    if (raw) { try { body = JSON.parse(raw); } catch (e) { sendJson(res, 400, { error: 'bad_json' }); return; } }
  }
  try { await hit.handler(req, res, { ...hit.ctx, query: query, body: body, params: hit.params || {} }); }
  catch (e) { sendJson(res, 500, { error: 'route_error', message: String(e && e.message || e).slice(0, 200) }); }
}
// ---- 同源 AI 代理（Bloma 完整程序渠道，2026-09-06）----
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
  // ---- B1 健康端点：路由挂载状态（api-contract 探针 404 时取真实 require 报错回流修复任务）----
  if (rawUrl.pathname === '/_bloma/routes' && req.method === 'GET') {
    loadRoutes();
    sendJson(res, 200, { mounted: routes.map((r) => ({ method: r.method, path: r.path })), errors: routeErrors });
    return;
  }
  // ---- 后端 API：/api/llm 代理 + server/routes 挂载端点 ----
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
    // CSP 只放行同源 connect-src：AI 能力走本进程 /api/llm 代理，浏览器直连外部仍硬拦
    // CSP 单一真相源：./product-csp.ts（沙箱脚本与产物模板两处同构引用）
    'Content-Security-Policy': ${JSON.stringify(PRODUCT_CSP)},
  });
  createReadStream(finalPath).pipe(res);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') process.exit(10);
  throw err;
});
server.listen(port, '127.0.0.1', () => {
  console.log('MVP static server listening on ' + port);
});
`
}

// =========================================================================
// PR-1 骨架先行（2026-09-03）：loop 前确定性渲染骨架包
// =========================================================================

/** 骨架先行总开关：缺省开启；BLOMA_SCAFFOLD=0/off/false 关闭（关闭后行为=现状从零写）。 */
export function scaffoldEnabled(): boolean {
  const raw = process.env.BLOMA_SCAFFOLD
  if (!raw) return true
  const value = raw.trim().toLowerCase()
  return value !== '0' && value !== 'off' && value !== 'false'
}

/** 骨架渲染结果：written = 本次新写入；skipped = 目标已存在跳过（幂等，不覆盖既有产物）。 */
export interface SkeletonRenderResult {
  written: string[]
  skipped: string[]
}

/**
 * 把骨架包渲染到项目根（纯 fs，无 LLM；manifest 已在加载时校验过路径安全）。
 * 逐文件：目标存在 → skip；不存在 → mkdir -p + 写入。抛错（fs 异常）由调用方
 * catch 后回退无骨架现状（fail-open：骨架是增强不是依赖）。
 */
export function renderSkeletonToProject(skeleton: ProjectSkeleton, rootPath: string): SkeletonRenderResult {
  const written: string[] = []
  const skipped: string[] = []
  for (const entry of skeleton.files) {
    const target = join(rootPath, entry.path)
    if (existsSync(target)) {
      skipped.push(entry.path)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, readFileSync(join(skeleton.baseDir, entry.path), 'utf8'), 'utf8')
    written.push(entry.path)
  }
  return { written, skipped }
}

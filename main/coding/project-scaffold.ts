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

/** 自包含静态服务器：读取 PORT 环境变量（沙箱注入），带路径穿越防护与 CSP 网络隔离。 */
export function renderStaticServer(): string {
  return `// 自包含静态服务器（Bloma MVP 模板）
const { createReadStream, existsSync, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, normalize, resolve, sep } = require('node:path');
const root = process.cwd();
const port = Number(process.env.PORT) || 3000;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
// ---- 同源 AI 代理（Bloma 完整程序渠道，2026-09-06）----
// 前端 CSP 只放行同源（connect-src 'self'），浏览器永远不直接出网；需要真实模型
// 能力的功能统一 POST /api/llm，由本进程（Bloma 注入 BLOMA_APP_LLM_* 环境变量）
// 代为出网。密钥只存在于本进程环境变量，绝不写入前端代码/项目文件。
const LLM_BASE = (process.env.BLOMA_APP_LLM_BASE_URL || '').replace(/\\/+$/, '');
const LLM_KEY = process.env.BLOMA_APP_LLM_KEY || '';
const LLM_MODEL = process.env.BLOMA_APP_LLM_MODEL || '';
const LLM_PROTOCOL = process.env.BLOMA_APP_LLM_PROTOCOL === 'anthropic' ? 'anthropic' : 'openai';
const LLM_TIMEOUT_MS = Number(process.env.BLOMA_APP_LLM_TIMEOUT_MS) || 60000;
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const server = createServer((req, res) => {
  const rawUrl = new URL(req.url || '/', 'http://localhost');
  // ---- POST /api/llm：同源 AI 代理 ----
  // 请求: {messages:[{role:'user'|'assistant',content}...], temperature?, max_tokens?, mock?}
  // 成功: 200 {content:"模型回复文本"}；失败: 4xx/5xx {error:"..."}
  //       （llm_not_configured=预览环境未注入模型，属正常降级路径，前端须有失败态）
  // mock: 请求带 mock:true 返回确定性模拟应答（mock:'fail' 返回失败应答）——
  //       终验探针以 ?mock=1 打开页面时前端自动附加，GWT 断言因此可确定性收口
  if (req.method === 'POST' && rawUrl.pathname === '/api/llm') {
    // 跨站预检一律拒绝：同源页面请求不预检不受影响，外部网站无法借用本机密钥出网
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'",
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

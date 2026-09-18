/**
 * W2 预览引擎（真实脚手架改造，2026-09-18；BLOMA_REAL_SCAFFOLD 生效的新项目专用）。
 *
 * 「沙箱」退化为预览呈现后的运行时判定（按产物标记，非开关——骨架在创建时已定形态，
 * 运行时跟随产物；旧路径产物永远有 static-server.js、永无根 server.js，标记无歧义）：
 * - 根目录 server.js 存在（real-fullstack）→ spawn `node server.js`（cwd=项目根、
 *   PORT/BLOMA_APP_LLM_* env 注入、无出网），vendor 钉版 Express 幂等供货 node_modules；
 * - static-server.js 存在（旧注入路径）→ 返回 null，调用方走原 spawnStaticServer；
 * - 两者皆无（real-static 纯静态）→ 零约定只读 file server（只 serve 目录，无路由、
 *   无注入、无 /api——静态产物双击即开的等价物，GWT 探针需要 http URL 是它存在的唯一理由）。
 *
 * 本模块不 import platform-services（那里反向消费本模块，避免环）；node 可执行文件
 * 解析与 platform-services.resolveNodeExecutable 同口径（3 行重复，注释互指）。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'

/** 与 platform-services.resolveNodeExecutable 同口径（Electron 下 execPath 非 node）。 */
function resolveNodeExecutable(): string {
  return process.env.npm_node_execpath || process.env.NODE || 'node'
}

/** real-fullstack 产物标记：根目录 server.js（骨架预置、agent 可改；旧路径永无此文件）。 */
export function isRealFullstackProject(projectRoot: string): boolean {
  return readRealScaffoldVariant(projectRoot) === 'real-fullstack'
}

/** 真实脚手架变体标记文件（骨架渲染时写入项目根，随快照归档/恢复）：
 *  W3（2026-09-18）引入——运行时/交付链/工具面都以它为权威判定，而非文件存在性启发。
 *  背景：旧路径项目 loop 期间 static-server.js 尚未落盘（交付链才注入），靠「无
 *  static-server.js」判 real-static 会误伤旧路径 loop 期预览；server.js 只覆盖
 *  fullstack 不覆盖 real-static。标记文件是唯一三处（预览/交付/工具面）一致且跨重启、
 *  跨快照恢复稳定的真相源。agent 写入被工具面拒绝（平台管理文件）。 */
export const REAL_VARIANT_MARKER = '.bloma-real-variant'
export type RealScaffoldVariant = 'real-static' | 'real-fullstack'

export function readRealScaffoldVariant(projectRoot: string): RealScaffoldVariant | null {
  try {
    const raw = readFileSync(join(projectRoot, REAL_VARIANT_MARKER), 'utf8').trim()
    return raw === 'real-static' || raw === 'real-fullstack' ? raw : null
  } catch {
    return null
  }
}

export function writeRealScaffoldMarker(projectRoot: string, variant: RealScaffoldVariant): void {
  writeFileSync(join(projectRoot, REAL_VARIANT_MARKER), variant, 'utf8')
}

/** vendor 钉版依赖根：~/.proma/bloma-vendor/express/node_modules（scripts/ensure-vendor-express.mjs 预装）。 */
export function getVendorNodeModulesDir(): string {
  return join(getPromaHome(), 'bloma-vendor', 'express', 'node_modules')
}

/**
 * 逐文件复制目录（陷阱 #48：Node 22 cpSync(recursive) 源/目标含非 ASCII 路径段错误杀进程，
 * 中文项目名必踩——export-manifest/PR-3 同款规避：readdirSync + copyFileSync 逐文件）。
 */
function copyTreeFileByFile(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const from = join(src, entry)
    const to = join(dest, entry)
    if (statSync(from).isDirectory()) copyTreeFileByFile(from, to)
    else copyFileSync(from, to)
  }
}

/**
 * vendor 供货（幂等）：项目 node_modules 已有 express → 跳过；vendor 库缺失 → false
 * （服务器启动将因 require 失败而红，stderr 经日志回流如实可见——fail-open 不静默）。
 */
export function ensureVendorNodeModules(projectRoot: string): boolean {
  const projectModules = join(projectRoot, 'node_modules')
  if (existsSync(join(projectModules, 'express'))) return true
  const vendorDir = getVendorNodeModulesDir()
  if (!existsSync(join(vendorDir, 'express'))) return false
  try {
    copyTreeFileByFile(vendorDir, projectModules)
    return existsSync(join(projectModules, 'express'))
  } catch {
    return false
  }
}

/**
 * 零约定只读 file server（real-static 专用）：只做静态目录服务——按扩展名给 MIME、
 * 目录请求回落 index.html、404 如实。无路由挂载、无 /api 代理、无 CSP 注入（纯静态
 * 产物等价于双击打开；AI 能力属 real-fullstack 形态）。进程从临时目录启动（Windows
 * 进程 cwd 锁目录的回滚 EBUSY 坑），服务根目录由参数传入。
 */
export const STATIC_FILE_SERVER_SCRIPT = `
const http = require('http');
const fs = require('fs');
const path = require('path');
const port = Number(process.argv[1]);
const root = require('path').resolve(process.argv[2]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};
http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/\\\\/g, '/');
  let file = path.join(root, path.normalize(rel).replace(/^([.]{2}[/\\\\])+/, ''));
  if (!file.startsWith(root)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found: ' + rel);
  }
}).listen(port, '127.0.0.1', () => console.log('[file-server] listening on ' + port));
`

/**
 * 运行时入口：按产物标记解析预览进程。返回 null = 旧注入路径（调用方走原逻辑）。
 * env 与 platform-services.sandboxSpawnOptions 同构：PORT + BLOMA_APP_LLM_*（密钥只进
 * 进程环境）+ PATH；cwd 钉项目根（server.js 的 express.static/npm start 语义）。
 */
export function resolveRealScaffoldSpawn(
  projectRoot: string,
  port: number,
  llmEnv?: Record<string, string>,
): ChildProcess | null {
  // W3：标记文件为权威判定（旧路径 loop 期 static-server.js 尚未落盘，文件存在性启发会误伤）
  const variant = readRealScaffoldVariant(projectRoot)
  if (variant === 'real-fullstack') {
    ensureVendorNodeModules(projectRoot)
    const options: SpawnOptions = {
      cwd: projectRoot,
      env: { PATH: process.env.PATH, Path: process.env.Path, PORT: String(port), ...(llmEnv ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
    return spawn(resolveNodeExecutable(), ['server.js'], options)
  }
  if (variant === 'real-static') {
    // 零约定只读 file server（cwd 落临时目录，根目录参数传入——与旧内嵌脚本同口径）
    return spawn(resolveNodeExecutable(), ['-e', STATIC_FILE_SERVER_SCRIPT, String(port), projectRoot], {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH, Path: process.env.Path },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }
  return null
}

#!/usr/bin/env node
/**
 * Bloma 一键启动器（scripts/start.mjs），2026-09-01。
 *
 * 自动化流程：依赖预检 → 构建（renderer + main，可 --skip-build 跳过）→ 启动
 * Electron 弹出应用窗口，控制台输出透传、退出码透传。
 *
 * 为什么不直接 npm start：npm start 的 build 失败时错误埋在长日志里、且旧
 * dist-main 仍在时容易误跑旧版（陷阱 41：线上跑 dist-main，源码修复必须
 * rebuild 才生效）。本脚本构建失败即停、不再启动，并打印产物时间戳兜底核对。
 *
 * 用法：
 *   node scripts/start.mjs              # 预检 + 构建 + 启动
 *   node scripts/start.mjs --skip-build # 跳过构建（产物已新鲜时秒起）
 *   node scripts/start.mjs --no-install # 跳过依赖自动安装（默认缺失时自动 npm ci）
 */

import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(import.meta.url)
const args = new Set(process.argv.slice(2))
const SKIP_BUILD = args.has('--skip-build')
const NO_INSTALL = args.has('--no-install')

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function log(tag, message) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log(`[${stamp}] ${tag} ${message}`)
}

/** dist 产物路径与时间戳（启动前兜底核对：确认跑的是新代码）。 */
function artifactInfo() {
  const main = join(root, 'dist-main', 'main', 'index.js')
  const renderer = join(root, 'dist', 'index.html')
  const fmt = (path) => (existsSync(path) ? statSync(path).mtime.toLocaleString('zh-CN', { hour12: false }) : '缺失')
  return { main, renderer, mainAt: fmt(main), rendererAt: fmt(renderer) }
}

function runNpm(command, label) {
  log('▶', `${label}（npm ${command}）…`)
  const started = Date.now()
  const result = spawnSync(NPM, command.split(' '), {
    cwd: root,
    stdio: 'inherit',
    shell: true,
    env: process.env,
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (result.status !== 0) {
    console.error('')
    console.error(`✗ ${label}失败（退出码 ${result.status}，耗时 ${seconds}s）。已停止，不启动旧产物。`)
    console.error('  排查建议：')
    console.error('  1. 看上方报错首行（typecheck/vite/esbuild 的错误都带文件名与行号）')
    console.error('  2. 只想快速起旧版本：node scripts/start.mjs --skip-build')
    process.exit(result.status ?? 1)
  }
  log('✓', `${label}完成（${seconds}s）`)
}

// ---------------------------------------------------------------- ① 依赖预检

const electronExe = process.platform === 'win32'
  ? join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : join(root, 'node_modules', 'electron', 'dist', 'electron')

if (!existsSync(electronExe)) {
  if (NO_INSTALL) {
    console.error('✗ node_modules 缺失（electron 二进制不存在）。请先 npm ci，或去掉 --no-install 让脚本自动安装。')
    process.exit(1)
  }
  log('!', '首次运行：安装依赖（npm ci）…')
  runNpm('ci', '依赖安装')
}

// ---------------------------------------------------------------- ② 构建

if (SKIP_BUILD) {
  const info = artifactInfo()
  log('⏭', '跳过构建（--skip-build）。当前产物时间戳：')
  console.log(`    dist-main/main/index.js  ${info.mainAt}`)
  console.log(`    dist/index.html           ${info.rendererAt}`)
  if (info.mainAt === '缺失' || info.rendererAt === '缺失') {
    console.error('✗ 产物缺失，无法启动。去掉 --skip-build 先构建一次。')
    process.exit(1)
  }
} else {
  runNpm('run build', '构建')
}

// ---------------------------------------------------------------- ③ 启动 Electron

// electron 包在 Node 上下文导出其可执行文件路径（而非拉起子进程），直接取用
let electronPath
try {
  electronPath = require('electron')
} catch {
  console.error('✗ 无法解析 electron 可执行文件路径，请重装依赖：npm ci')
  process.exit(1)
}
if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
  console.error(`✗ electron 二进制不存在：${electronPath}。请重装依赖：npm ci`)
  process.exit(1)
}

const info = artifactInfo()
log('🚀', '启动 Bloma（窗口即将弹出）…')
console.log(`    main 产物: ${info.mainAt}`)
console.log(`    渲染产物: ${info.rendererAt}`)
console.log('    （关闭应用窗口或 Ctrl+C 退出；源码有改动请重新跑本脚本确保构建新鲜）')

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
})

// 控制台 Ctrl+C → 一并终止 Electron（不留后台残留进程）
process.on('SIGINT', () => {
  child.kill('SIGINT')
})
child.on('close', (code) => {
  log('■', `Bloma 已退出（code=${code ?? 0}）`)
  process.exit(code ?? 0)
})

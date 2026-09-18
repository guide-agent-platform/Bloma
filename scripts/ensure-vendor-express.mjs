#!/usr/bin/env node
/**
 * 预装 real-fullstack 的 vendor 钉版依赖（W2，2026-09-18 改造）。
 *
 * 用途：把钉死版本的 express 安装到 ~/.proma/bloma-vendor/express/node_modules。
 * 预览引擎（main/coding/preview-runtime.ts ensureVendorNodeModules）在拉起 real-fullstack
 * 产物时从这里逐文件复制到项目 node_modules（零网络、零 install 脚本执行；快照排除、
 * 回滚后幂等补拷）。导出包不含 node_modules，用户侧 npm install 还原（package.json 已声明）。
 *
 * 维护者执行（一次性，需网络）：
 *   node scripts/ensure-vendor-express.mjs
 * 升级版本：改下面的 EXPRESS_VERSION 后删除 ~/.proma/bloma-vendor/express 重跑。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// 与 storage/config-paths.getPromaHome 同口径（mjs 不能 import TS；两处同步义务）
function promaHome() {
  const trimmed = process.env.PROMA_HOME ? process.env.PROMA_HOME.trim() : ''
  if (trimmed && trimmed !== 'undefined' && trimmed !== 'null') return trimmed
  return join(homedir(), '.proma')
}

const EXPRESS_VERSION = '4.21.2'
const vendorRoot = join(promaHome(), 'bloma-vendor', 'express')
const marker = join(vendorRoot, `.express-${EXPRESS_VERSION}`)

if (existsSync(marker) && existsSync(join(vendorRoot, 'node_modules', 'express'))) {
  console.log(`[vendor] express@${EXPRESS_VERSION} 已就位：${vendorRoot}`)
  process.exit(0)
}

console.log(`[vendor] 安装 express@${EXPRESS_VERSION} 到 ${vendorRoot}（npm install --prefix，需要网络）...`)
rmSync(vendorRoot, { recursive: true, force: true })
execFileSync('npm', ['install', `express@${EXPRESS_VERSION}`, '--prefix', vendorRoot, '--omit=dev', '--no-audit', '--no-fund'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})
// 版本钉死标记（内容无关，存在性即版本指纹）
writeFileSync(marker, EXPRESS_VERSION, 'utf8')
console.log(`[vendor] 完成。项目侧由 ensureVendorNodeModules 幂等复制。`)

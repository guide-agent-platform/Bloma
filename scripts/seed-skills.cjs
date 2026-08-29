#!/usr/bin/env node
/**
 * seed-skills.cjs — 种子 skill 安装脚本（skill 机制 2026-08-28，guidance v5 ①）
 *
 * 把 resources/skills/ 下的首批团队 SOP skill 复制到全局白名单根
 * <PROMA_HOME>/skills/（与 main/skill-loader.ts resolveSkillRoots 的全局根一致）。
 * 已存在的同名 skill 跳过（不覆盖用户改动）；--force 可强制覆盖。
 *
 * 用法：
 *   npm run seed:skills           # 安装种子 skill（幂等）
 *   npm run seed:skills -- --force
 */

const { mkdirSync, copyFileSync, existsSync } = require('node:fs')
const { homedir } = require('node:os')
const { join, dirname } = require('node:path')

const PROMA_HOME = process.env.PROMA_HOME || join(homedir(), '.proma')
const SOURCE_ROOT = join(__dirname, '..', 'resources', 'skills')
const TARGET_ROOT = join(PROMA_HOME, 'skills')
const FORCE = process.argv.includes('--force')

const SEEDS = [
  { dir: 'dev-loop', name: 'dev-loop', desc: 'Bloma 开发循环 SOP' },
  { dir: 'ui-walkthrough', name: 'ui-walkthrough', desc: 'UI 走查 SOP' },
  { dir: 'ac-audit', name: 'ac-audit', desc: '验收标准审计 SOP' },
]

let installed = 0
let skipped = 0
for (const seed of SEEDS) {
  const src = join(SOURCE_ROOT, seed.dir, 'SKILL.md')
  const dest = join(TARGET_ROOT, seed.dir, 'SKILL.md')
  if (!existsSync(src)) {
    console.error(`SKIP(缺源): ${seed.name} — ${src}`)
    skipped++
    continue
  }
  if (existsSync(dest) && !FORCE) {
    console.log(`SKIP(已存在): ${seed.name}`)
    skipped++
    continue
  }
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log(`INSTALLED: ${seed.name} -> ${dest}`)
  installed++
}
console.log(`\n种子 skill 安装完成：${installed} 安装 / ${skipped} 跳过（全局根 ${TARGET_ROOT}）`)

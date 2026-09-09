#!/usr/bin/env node
/**
 * L1 A/B 对比报告（2026-09-09）。
 *
 * 读两份 l1-report JSON（--base/--exp，如 b0 vs p1），按 seed 输出
 * 关键指标「基线 → 实验（Δ）」对照 + 逐 run 终态对照 + 可比性告警。
 * 纪律同 l1-report：报分布不报最好；n 不齐或 seed 缺失时明确标注不可比。
 *
 * 用法：node bench/harness/l1-ab.mjs --base b0 --exp p1 [--out bench/reports/l1-ab-b0-vs-p1.md]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const reportsDir = fileURLToPath(new URL('../reports/', import.meta.url))

const argv = process.argv.slice(2)
const args = { base: '', exp: '', out: '' }
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--base') args.base = argv[++i] ?? ''
  else if (argv[i] === '--exp') args.exp = argv[++i] ?? ''
  else if (argv[i] === '--out') args.out = argv[++i] ?? ''
  else { console.error(`未知参数：${argv[i]}`); process.exit(2) }
}
if (!args.base || !args.exp) { console.error('用法：l1-ab.mjs --base <labelA> --exp <labelB>'); process.exit(2) }

const load = (label) => {
  const file = join(reportsDir, `l1-report-${label}.json`)
  if (!existsSync(file)) { console.error(`缺报告：${file}`); process.exit(1) }
  return JSON.parse(readFileSync(file, 'utf8'))
}
const baseRuns = load(args.base)
const expRuns = load(args.exp)

const fmt = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '-' : typeof x === 'number' ? x.toFixed(d) : String(x))
const cell = (b, e, d = 1, unit = '') => {
  const delta = Number.isFinite(b) && Number.isFinite(e) ? `${e - b >= 0 ? '+' : ''}${(e - b).toFixed(d)}` : '-'
  return `${fmt(b, d)}${unit} → ${fmt(e, d)}${unit}（${delta}）`
}
const seedIds = [...new Set([...baseRuns.map((s) => s.seedId), ...expRuns.map((s) => s.seedId)])].sort()

const lines = []
lines.push(`# L1 A/B 对比：${args.base} vs ${args.exp}`)
lines.push('')
lines.push(`> 生成：${new Date().toISOString()}｜口径：同 seed 同 N 分布对照（P0 稿 §6）；Δ=exp−base`)
lines.push('')

for (const seedId of seedIds) {
  const b = baseRuns.find((s) => s.seedId === seedId)
  const e = expRuns.find((s) => s.seedId === seedId)
  lines.push(`## ${seedId}`)
  lines.push('')
  if (!b || !e) {
    lines.push(`> ⚠️ 不可比：${!b ? `${args.base} 缺此 seed` : ''}${!b && !e ? '；' : ''}${!e ? `${args.exp} 缺此 seed` : ''}`)
    lines.push('')
    continue
  }
  if (b.n !== e.n) lines.push(`> ⚠️ n 不齐：base n=${b.n} / exp n=${e.n}（分布对照仅供参考）`)
  lines.push('')
  lines.push('| 指标 | base → exp（Δ） |')
  lines.push('|---|---|')
  lines.push(`| e2e 成功率 | ${cell(b.e2eSuccessRate, e.e2eSuccessRate, 2)} |`)
  lines.push(`| 首过（0 修复 converged） | ${b.firstPassCount}/${b.n} → ${e.firstPassCount}/${e.n} |`)
  lines.push(`| 轮数 mean | ${cell(b.turns.mean, e.turns.mean, 1)} |`)
  lines.push(`| 轮数 median | ${cell(b.turns.median, e.turns.median, 1)} |`)
  lines.push(`| 轮数 max | ${cell(b.turns.max, e.turns.max, 0)} |`)
  lines.push(`| 耗时min mean | ${cell(b.durationMin.mean, e.durationMin.mean, 1)} |`)
  lines.push(`| 修复 mean/max | ${cell(b.repairs.mean, e.repairs.mean, 2)} / ${cell(b.repairs.max, e.repairs.max, 0)} |`)
  lines.push(`| CAP 保留 | ${cell(b.capRetention, e.capRetention, 2)} |`)
  lines.push(`| 协议泄漏率 | ${cell(b.protocolLeakRate, e.protocolLeakRate, 3)} |`)
  lines.push(`| 空正文率 | ${cell(b.emptyBodyRate, e.emptyBodyRate, 3)} |`)
  lines.push(`| 首次约束违规 run | ${b.violationRuns}/${b.n} → ${e.violationRuns}/${e.n} |`)
  lines.push(`| 有效交付 tokens mean | ${cell(b.effectiveTokens.mean, e.effectiveTokens.mean, 0)} |`)
  lines.push('')
  lines.push('| run(base) | 终态 | run(exp) | 终态 |')
  lines.push('|---|---|---|---|')
  const max = Math.max(b.runs.length, e.runs.length)
  for (let i = 0; i < max; i += 1) {
    const rb = b.runs[i]
    const re = e.runs[i]
    lines.push(`| ${rb ? rb.runId.slice(14) : '-'} | ${rb ? rb.terminal : '-'} | ${re ? re.runId.slice(14) : '-'} | ${re ? re.terminal : '-'} |`)
  }
  lines.push('')
}

const out = args.out || join(reportsDir, `l1-ab-${args.base}-vs-${args.exp}.md`)
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(out)

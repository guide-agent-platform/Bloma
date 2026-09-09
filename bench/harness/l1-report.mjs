#!/usr/bin/env node
/**
 * bench L1 报告汇总（P0 Phase 0.5，2026-09-09）。
 *
 * 把 bench/runs/<seed>/<run-id>/ 档案按 seed 聚合 → bench/reports/l1-report-<label>.md + .json。
 * 报告分布（均值/中位/极值/逐 run），不报最好成绩（P0 稿 §6 纪律）。
 *
 * 用法：
 *   node bench/harness/l1-report.mjs [--label b0] [--seed seed-xxx] [--out bench/reports/x.md]
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runsRoot = fileURLToPath(new URL('../runs/', import.meta.url))
const reportsDir = fileURLToPath(new URL('../reports/', import.meta.url))

function parseArgs(argv) {
  const out = { label: '', seed: '', out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--label') out.label = argv[++i] ?? ''
    else if (a === '--seed') out.seed = argv[++i] ?? ''
    else if (a === '--out') out.out = argv[++i] ?? ''
    else { console.error(`未知参数：${a}`); process.exit(2) }
  }
  return out
}

function loadRuns(args) {
  if (!existsSync(runsRoot)) return []
  const runs = []
  for (const seedId of readdirSync(runsRoot)) {
    if (args.seed && seedId !== args.seed) continue
    const seedDir = join(runsRoot, seedId)
    if (!statSync(seedDir).isDirectory()) continue
    for (const runId of readdirSync(seedDir)) {
      const runDir = join(seedDir, runId)
      if (!statSync(runDir).isDirectory()) continue
      const manifest = join(runDir, 'manifest.json')
      const metrics = join(runDir, 'metrics.json')
      if (!existsSync(manifest)) continue
      try {
        runs.push({
          seedId, runId, dir: runDir,
          manifest: JSON.parse(readFileSync(manifest, 'utf8')),
          metrics: existsSync(metrics) ? JSON.parse(readFileSync(metrics, 'utf8')) : null,
        })
      } catch { /* 坏档案跳过 */ }
    }
  }
  return runs
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 0) return null
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

function fmt(x, digits = 1) {
  return x === null || x === undefined || Number.isNaN(x) ? '-' : (typeof x === 'number' ? x.toFixed(digits) : String(x))
}

function summarizeSeed(seedId, runs) {
  const converged = runs.filter((r) => r.manifest.terminal?.kind === 'converged')
  const stalls = runs.filter((r) => ['stalled', 'timeout'].includes(r.manifest.terminal?.kind))
  const blocked = runs.filter((r) => r.manifest.terminal?.kind === 'blocked')
  const turnList = runs.map((r) => r.metrics?.metrics?.loop?.lastTurns).filter((x) => Number.isFinite(x))
  const durationMin = runs.map((r) => {
    const a = Date.parse(r.manifest.startedAt ?? '')
    const b = Date.parse(r.manifest.finishedAt ?? '')
    return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / 60000 : NaN
  }).filter((x) => Number.isFinite(x))
  const repairs = runs.map((r) => r.metrics?.metrics?.loop?.repairRounds).filter((x) => Number.isFinite(x))
  const ext = runs.map((r) => r.metrics?.extended).filter(Boolean)
  const capList = ext.map((e) => e.coreCapabilityRetention).filter((x) => x !== 'n/a')
  const tokenList = ext.map((e) => e.effectiveDeliveryTokens).filter((x) => Number.isFinite(x))
  return {
    seedId,
    n: runs.length,
    converged: converged.length,
    stalledOrTimeout: stalls.length,
    blocked: blocked.length,
    e2eSuccessRate: runs.length ? converged.length / runs.length : null,
    firstPassCount: runs.filter((r) => (r.metrics?.metrics?.loop?.repairRounds ?? 0) === 0 && r.manifest.terminal?.kind === 'converged').length,
    turns: { mean: turnList.length ? turnList.reduce((a, b) => a + b, 0) / turnList.length : null, median: median(turnList), max: turnList.length ? Math.max(...turnList) : null },
    durationMin: { mean: durationMin.length ? durationMin.reduce((a, b) => a + b, 0) / durationMin.length : null, median: median(durationMin), max: durationMin.length ? Math.max(...durationMin) : null },
    repairs: { mean: repairs.length ? repairs.reduce((a, b) => a + b, 0) / repairs.length : null, max: repairs.length ? Math.max(...repairs) : null },
    capRetention: capList.length ? capList.reduce((a, b) => a + b, 0) / capList.length : null,
    protocolLeakRate: ext.length ? ext.reduce((a, e) => a + (e.protocolLeakRate || 0), 0) / ext.length : null,
    emptyBodyRate: ext.length ? ext.reduce((a, e) => a + (e.emptyBodyRate || 0), 0) / ext.length : null,
    violationRuns: ext.filter((e) => e.firstConstraintViolation?.violated).length,
    effectiveTokens: { mean: tokenList.length ? tokenList.reduce((a, b) => a + b, 0) / tokenList.length : null, max: tokenList.length ? Math.max(...tokenList) : null },
    runs: runs.map((r) => ({
      runId: r.runId,
      terminal: `${r.manifest.terminal?.kind}@${r.manifest.terminal?.stage}`,
      turns: r.metrics?.metrics?.loop?.lastTurns ?? null,
      repairs: r.metrics?.metrics?.loop?.repairRounds ?? null,
      testCompleted: r.metrics?.metrics?.loop?.testCompleted ? `${r.metrics.metrics.loop.testCompleted.failed}f/${r.metrics.metrics.loop.testCompleted.total}t` : null,
      flags: (r.metrics?.flags || []).map((f) => f.code),
    })),
  }
}

function toMarkdown(summaries, args) {
  const lines = []
  lines.push(`# L1 基准报告${args.label ? `（${args.label}）` : ''}`)
  lines.push('')
  lines.push(`> 生成：${new Date().toISOString()}｜runs 目录：bench/runs/｜纪律：报分布不报最好（P0 稿 §6）`)
  lines.push('')
  lines.push('## 按 seed 汇总')
  lines.push('')
  lines.push('| seed | n | e2e成功率 | 首过 | 轮数(均/中/max) | 耗时min(均/max) | 修复(均/max) | CAP保留 | 泄漏率 | 空正文 | 违规run | tokens(均/max) |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const s of summaries) {
    lines.push(`| ${s.seedId} | ${s.n} | ${fmt(s.e2eSuccessRate, 2)} | ${s.firstPassCount}/${s.n} | ${fmt(s.turns.mean)}/${fmt(s.turns.median)}/${fmt(s.turns.max, 0)} | ${fmt(s.durationMin.mean)}/${fmt(s.durationMin.max)} | ${fmt(s.repairs.mean)}/${fmt(s.repairs.max, 0)} | ${fmt(s.capRetention, 2)} | ${fmt(s.protocolLeakRate, 3)} | ${fmt(s.emptyBodyRate, 3)} | ${s.violationRuns} | ${fmt(s.effectiveTokens.mean, 0)}/${fmt(s.effectiveTokens.max, 0)} |`)
  }
  lines.push('')
  lines.push('## 逐 run 明细')
  lines.push('')
  for (const s of summaries) {
    lines.push(`### ${s.seedId}（converged ${s.converged}/${s.n}｜stalled/timeout ${s.stalledOrTimeout}｜blocked ${s.blocked}）`)
    lines.push('')
    lines.push('| run | 终态 | 轮数 | 修复 | 终验 | 特征标记 |')
    lines.push('|---|---|---|---|---|---|')
    for (const r of s.runs) {
      lines.push(`| ${r.runId.slice(0, 19)} | ${r.terminal} | ${fmt(r.turns, 0)} | ${fmt(r.repairs, 0)} | ${r.testCompleted ?? '-'} | ${(r.flags || []).join(', ') || '-'} |`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const runs = loadRuns(args)
  if (runs.length === 0) { console.error('runs/ 下无档案（先跑 l1-run.mjs）'); process.exit(1) }
  const bySeed = new Map()
  for (const r of runs) {
    if (args.label && !(r.manifest.label === args.label || r.runId.includes(args.label))) continue
    if (!bySeed.has(r.seedId)) bySeed.set(r.seedId, [])
    bySeed.get(r.seedId).push(r)
  }
  const summaries = [...bySeed.entries()].map(([seedId, rs]) => summarizeSeed(seedId, rs)).sort((a, b) => a.seedId.localeCompare(b.seedId))
  const md = toMarkdown(summaries, args)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const outBase = args.out || join(reportsDir, `l1-report-${args.label || stamp}`)
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(`${outBase}.md`, md, 'utf8')
  writeFileSync(`${outBase}.json`, JSON.stringify(summaries, null, 2), 'utf8')
  console.log(`seeds=${summaries.length} runs=${runs.length}`)
  console.log(`${outBase}.md`)
  console.log(`${outBase}.json`)
}

main()

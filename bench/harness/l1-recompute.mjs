#!/usr/bin/env node
/**
 * bench L1 run 档案指标重算（P0 Phase 0.4 收尾件，2026-09-09）。
 *
 * 背景：run 档案的 metrics.json 是 run 当时 collector 口径的快照；collector 修正
 * （如 <session-recall> 注入段过滤，2026-09-09）后，B0 各 run 间可能出现口径漂移。
 * 本脚本从档案自带的原始证据（session-raw.jsonl + evidence.json 的 docs/artifacts/
 * assistantIntegrity/analytics 字段）按**当前** collector/metrics 口径统一重算，
 * 就地更新 metrics.json（原值保留在 metrics.preRecompute 供对照）。
 *
 * 用法：node bench/harness/l1-recompute.mjs [--seed xxx] [--label b0]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectSession } from './collector.mjs'
import { computeExtendedMetrics, computeFlags, computeProjectMetrics } from './metrics.mjs'

const runsRoot = fileURLToPath(new URL('../runs/', import.meta.url))

function parseArgs(argv) {
  const out = { seed: '', label: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--seed') out.seed = argv[++i] ?? ''
    else if (a === '--label') out.label = argv[++i] ?? ''
  }
  return out
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(runsRoot)) { console.error('runs/ 不存在'); process.exit(1) }
  let recomputed = 0
  for (const seedId of readdirSync(runsRoot)) {
    if (args.seed && seedId !== args.seed) continue
    const seedDir = join(runsRoot, seedId)
    if (!readdirSync(seedDir, { withFileTypes: true }).every((e) => e.isDirectory())) continue
    for (const runId of readdirSync(seedDir)) {
      if (args.label && !runId.includes(args.label)) continue
      const runDir = join(seedDir, runId)
      const manifestPath = join(runDir, 'manifest.json')
      const metricsPath = join(runDir, 'metrics.json')
      const rawPath = join(runDir, 'session-raw.jsonl')
      if (!existsSync(manifestPath) || !existsSync(metricsPath) || !existsSync(rawPath)) continue
      const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'))
      const evidence = JSON.parse(readFileSync(join(runDir, 'evidence.json'), 'utf8'))
      // 临时 home 复刻会话文件，按当前 collector 口径重算 session 派生字段
      const tmpHome = mkdtempSync(join(tmpdir(), 'l1-recompute-'))
      try {
        mkdirSync(join(tmpHome, 'agent-sessions'), { recursive: true })
        const sid = evidence.session?.sessionId || 'unknown'
        cpSync(rawPath, join(tmpHome, 'agent-sessions', `${sid}.jsonl`))
        evidence.session = collectSession(evidence.session?.sessionId, tmpHome)
      } finally {
        rmSync(tmpHome, { recursive: true, force: true })
      }
      // artifacts/docs/analytics 用 run 时快照（promaHome 已清理，原始目录不可再扫）
      const next = {
        flags: computeFlags(evidence),
        metrics: computeProjectMetrics(evidence),
        extended: computeExtendedMetrics(evidence),
        preRecompute: { extended: metrics.extended ?? null, capRetentionBefore: metrics.extended?.coreCapabilityRetention ?? null },
      }
      writeFileSync(metricsPath, JSON.stringify(next, null, 2))
      recomputed += 1
      console.log(`${seedId}/${runId}: capRetention ${metrics.extended?.coreCapabilityRetention ?? '-'} → ${next.extended.coreCapabilityRetention}`)
    }
  }
  console.log(`recomputed=${recomputed}`)
}

main()

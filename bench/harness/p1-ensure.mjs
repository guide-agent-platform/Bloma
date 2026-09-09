#!/usr/bin/env node
/**
 * Phase 1 A/B + 回归批跑（幂等，2026-09-09）。
 *
 * 前置硬门：bench/reports/l1-report-b0.json 必须存在（B0 基线已完成）——
 * 既保证可比性，也避免与 b0-ensure 并发抢渠道/机器资源。
 *
 * 两段：
 * ① AB 牌组：3 个 B0 同款 seed ×3 次，--prompts-dir bench/prompts/phase1（外置覆盖），
 *    label p1-N，与 B0 同 seed 同 N 严格可比；跑完 recompute+report --label p1。
 * ② 回归牌组：seed-regress 中 3 条可自动跑 seed ×3 次（iter-time 为 manualOnly 不进），
 *    同覆盖目录，label p1r-N；跑完 recompute+report --label p1r。
 * 最后自动：l1-ab（b0 vs p1 对比）+ l1-regress-check（p1r 回归判定）。
 *
 * 用法：node bench/harness/p1-ensure.mjs [--prompts-dir bench/prompts/phase1]
 * 幂等：中断后重跑即续（按 bench/runs/<seed>/ 下 label 目录计数补齐）。
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runsRoot = join(root, 'bench', 'runs')
const reportsDir = join(root, 'bench', 'reports')

const argv = process.argv.slice(2)
let promptsDir = join(root, 'bench', 'prompts', 'phase1')
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--prompts-dir') promptsDir = argv[i + 1] ?? ''
  else { console.error(`未知参数：${argv[i]}`); process.exit(2) }
}
if (!existsSync(promptsDir) || !readdirSync(promptsDir).some((f) => f.endsWith('.md'))) {
  console.error(`prompts 目录无效（需含 .md 覆盖）：${promptsDir}`)
  process.exit(2)
}

if (!existsSync(join(reportsDir, 'l1-report-b0.json'))) {
  console.error('前置未满足：bench/reports/l1-report-b0.json 不存在（B0 基线未完成）。先等 b0-ensure 跑完出报告。')
  process.exit(2)
}

const TARGET = 3
const AB_SEEDS = ['seed-b-crud-calculator', 'seed-ai-note-distilled', 'seed-game-shmup']
const REGRESS_SEEDS = ['seed-guide-delegate', 'seed-guide-rush', 'seed-ai-nopersist']

const stamp = () => new Date().toISOString()
const countDone = (seed, tag) => {
  const dir = join(runsRoot, seed)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((name) => name.includes(`-${tag}-`)).length
}

function runDeck(deckName, seeds, tag) {
  for (const seed of seeds) {
    let done = countDone(seed, tag)
    while (done < TARGET) {
      console.log(`[${stamp()}] ${deckName} ${seed}: ${done}/${TARGET}，补跑 #${done + 1}`)
      try {
        execSync(
          `node bench/harness/l1-run.mjs --seed ${seed} --mode quick --timeout-min 30 --label ${tag}-${done + 1} --prompts-dir "${promptsDir}"`,
          { cwd: root, stdio: 'inherit', timeout: 40 * 60_000 },
        )
      } catch (error) {
        console.error(`[${stamp()}] ${seed} #${done + 1} 失败（继续下一个）：${String(error.message).slice(0, 200)}`)
      }
      done = countDone(seed, tag)
    }
    console.log(`[${stamp()}] ${deckName} ${seed}: 齐了 ${done}/${TARGET}`)
  }
  execSync(`node bench/harness/l1-recompute.mjs --label ${tag}`, { cwd: root, stdio: 'inherit' })
  execSync(`node bench/harness/l1-report.mjs --label ${tag}`, { cwd: root, stdio: 'inherit' })
}

console.log(`[${stamp()}] === Phase 1 批跑开始｜prompts=${promptsDir} ===`)
runDeck('AB', AB_SEEDS, 'p1')
console.log(`[${stamp()}] === AB 牌组完成 → 回归牌组 ===`)
runDeck('REGRESS', REGRESS_SEEDS, 'p1r')

execSync(`node bench/harness/l1-ab.mjs --base b0 --exp p1`, { cwd: root, stdio: 'inherit' })
execSync(`node bench/harness/l1-regress-check.mjs --label p1r`, { cwd: root, stdio: 'inherit' })
console.log(`[${stamp()}] DONE：bench/reports/l1-report-p1.* / l1-report-p1r.* / l1-ab-b0-vs-p1.md / l1-regress-p1r.md`)

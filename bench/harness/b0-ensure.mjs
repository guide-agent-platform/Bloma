#!/usr/bin/env node
/**
 * B0 断点补跑（幂等，2026-09-09）。
 *
 * 扫 bench/runs/ 下 label=b0 的 run 档案，对不足 3 次的 seed 串行补跑到 N=3。
 * 用途：批跑脚本被中断（会话退出/进程被杀/机器重启）后，任何会话跑一次本脚本即可补齐，
 * 不会重复跑已完成的。跑完自动汇总 l1-report --label b0。
 *
 * 用法：nohup node bench/harness/b0-ensure.mjs > /tmp/b0-ensure.log 2>&1 &
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runsRoot = join(root, 'bench', 'runs')
const TARGET = 3
const SEEDS = ['seed-b-crud-calculator', 'seed-ai-note-distilled', 'seed-game-shmup']

function countDone(seed) {
  const dir = join(runsRoot, seed)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((name) => name.includes('-b0-') || name.includes('b0-')).length
}

const stamp = () => new Date().toISOString()
for (const seed of SEEDS) {
  let done = countDone(seed)
  let noProgress = 0
  while (done < TARGET) {
    console.log(`[${stamp()}] ${seed}: ${done}/${TARGET}，补跑 #${done + 1}`)
    try {
      execSync(`node bench/harness/l1-run.mjs --seed ${seed} --mode quick --timeout-min 30 --label b0-${done + 1}`, {
        cwd: root, stdio: 'inherit', timeout: 40 * 60_000,
      })
    } catch (error) {
      console.error(`[${stamp()}] ${seed} #${done + 1} 失败（继续下一个）：${String(error.message).slice(0, 200)}`)
    }
    const next = countDone(seed)
    if (next === done) {
      noProgress += 1
      if (noProgress >= 3) { console.error(`[${stamp()}] ${seed}: 连续 ${noProgress} 次无新档案，中止防死循环`); process.exit(1) }
    } else noProgress = 0
    done = next
  }
  console.log(`[${stamp()}] ${seed}: 齐了 ${done}/${TARGET}`)
}
console.log(`[${stamp()}] 全部齐了，出报告`)
execSync('node bench/harness/l1-recompute.mjs --label b0', { cwd: root, stdio: 'inherit' })
execSync('node bench/harness/l1-report.mjs --label b0', { cwd: root, stdio: 'inherit' })
console.log(`[${stamp()}] DONE：bench/reports/l1-report-*-b0.md（重算口径+按 seed 汇总）`)

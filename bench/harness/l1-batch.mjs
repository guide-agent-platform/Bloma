#!/usr/bin/env node
/**
 * L1 通用批跑器（2026-09-09，Phase 2 起各步单因子 A/B 共用）。
 *
 * 与 b0-ensure/p1-ensure 的关系：那两个是特定流程的编排（固定 seed/牌组/后处理链）；
 * 本脚本是通用引擎——任意 label × seeds × N × --prompts-dir × BLOMA_* env，跑完
 * recompute+report。幂等（按 bench/runs/<seed>/ 下 -<label>- 目录计数补齐）。
 *
 * 防双跑：启动前检测是否有 l1-run 进程在跑（Windows tasklist / POSIX ps），
 * 有则拒绝启动（2026-09-09 双跑事故教训：并发 run 互抢渠道污染基线）。
 *
 * 用法：
 *   node bench/harness/l1-batch.mjs --label b1 \
 *     --seeds seed-ai-note-distilled,seed-b-crud-calculator,seed-game-shmup \
 *     --n 3 [--env BLOMA_CAP_CONTRACT=1] [--prompts-dir bench/prompts/phase1] \
 *     [--gate bench/reports/l1-report-b0.json] [--no-report]
 *
 * 示例（Phase 2 B1：CAP 单因子，对照 B0）：
 *   node bench/harness/l1-batch.mjs --label b1 --n 3 --env BLOMA_CAP_CONTRACT=1 \
 *     --gate bench/reports/l1-report-b0.json
 *   # 对比：node bench/harness/l1-ab.mjs --base b0 --exp b1
 * 注意单因子纪律：--env 与 --prompts-dir 不要同时给（除非明确做组合因子实验）。
 */

import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const runsRoot = join(root, 'bench', 'runs')
const reportsDir = join(root, 'bench', 'reports')

const argv = process.argv.slice(2)
const args = { label: '', seeds: [], n: 3, env: {}, promptsDir: '', gate: '', noReport: false }
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i]
  if (a === '--label') args.label = argv[++i] ?? ''
  else if (a === '--seeds') args.seeds = (argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  else if (a === '--n') args.n = Number(argv[++i] ?? 3)
  else if (a === '--env') {
    const [k, ...rest] = String(argv[++i] ?? '').split('=')
    if (!k || rest.length === 0) { console.error(`--env 需 K=V 形式：${argv[i]}`); process.exit(2) }
    args.env[k] = rest.join('=')
  } else if (a === '--prompts-dir') args.promptsDir = argv[++i] ?? ''
  else if (a === '--gate') args.gate = argv[++i] ?? ''
  else if (a === '--no-report') args.noReport = true
  else { console.error(`未知参数：${a}`); process.exit(2) }
}
if (!args.label || args.seeds.length === 0) {
  console.error('用法：l1-batch.mjs --label <label> --seeds <s1,s2,...> [--n 3] [--env K=V] [--prompts-dir D] [--gate F] [--no-report]')
  process.exit(2)
}
if (Object.keys(args.env).length > 0 && args.promptsDir) {
  console.error('单因子纪律：--env 与 --prompts-dir 同时设置会引入两个变量；如确为组合实验请确认后注释掉本检查。')
  process.exit(2)
}
if (args.gate && !existsSync(join(root, args.gate))) {
  console.error(`前置未满足：${args.gate} 不存在（基线/上一步未完成）。`)
  process.exit(2)
}

/** 活跃 l1-run 检测（防双跑）：发现运行中的 l1-run/b0-ensure/p1-ensure 即拒绝。 */
function assertIdle() {
  try {
    const out = process.platform === 'win32'
      ? execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'l1-run|b0-ensure|p1-ensure|l1-batch\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8' })
      : execSync('ps -eo args', { encoding: 'utf8' })
    const hits = process.platform === 'win32'
      ? out.split('\n').map((l) => l.trim()).filter((l) => /^\d+$/.test(l) && Number(l) !== process.pid)
      : out.split('\n').filter((l) => /l1-run|b0-ensure|p1-ensure|l1-batch/.test(l) && !/grep/.test(l))
    if (hits.length > 0) {
      console.error(`检测到 ${hits.length} 个在跑的 bench 进程（PID ${hits.join(',')}）——为防双跑污染基线，拒绝启动。等它跑完或先停它。`)
      process.exit(3)
    }
  } catch (error) {
    if (String(error.message).includes('exit 3')) throw error
    // 检测工具失败不阻断（POSIX 分支 exit code 或权限问题）——记录后继续
    console.warn('[warn] 活跃进程检测未成功，继续（风险自负）：', String(error.message).slice(0, 120))
  }
}
assertIdle()

const stamp = () => new Date().toISOString()
const countDone = (seed) => {
  const dir = join(runsRoot, seed)
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((name) => name.includes(`-${args.label}-`)).length
}

const envPrefix = Object.entries(args.env).map(([k, v]) => `${k}=${v}`).join(' ')
console.log(`[${stamp()}] === l1-batch 开始｜label=${args.label} seeds=${args.seeds.join(',')} n=${args.n}${envPrefix ? ` env=${envPrefix}` : ''}${args.promptsDir ? ` prompts=${args.promptsDir}` : ''} ===`)
for (const seed of args.seeds) {
  let done = countDone(seed)
  while (done < args.n) {
    console.log(`[${stamp()}] ${seed}: ${done}/${args.n}，跑 #${done + 1}`)
    try {
      execSync(
        `${envPrefix ? envPrefix + ' ' : ''}node bench/harness/l1-run.mjs --seed ${seed} --mode quick --timeout-min 30 --label ${args.label}-${done + 1}${args.promptsDir ? ` --prompts-dir "${args.promptsDir}"` : ''}`,
        { cwd: root, stdio: 'inherit', timeout: 40 * 60_000 },
      )
    } catch (error) {
      console.error(`[${stamp()}] ${seed} #${done + 1} 失败（继续下一个）：${String(error.message).slice(0, 200)}`)
    }
    done = countDone(seed)
  }
  console.log(`[${stamp()}] ${seed}: 齐了 ${done}/${args.n}`)
}
if (!args.noReport) {
  execSync(`node bench/harness/l1-recompute.mjs --label ${args.label}`, { cwd: root, stdio: 'inherit' })
  execSync(`node bench/harness/l1-report.mjs --label ${args.label}`, { cwd: root, stdio: 'inherit' })
}
console.log(`[${stamp()}] DONE：bench/reports/l1-report-${args.label}.*`)

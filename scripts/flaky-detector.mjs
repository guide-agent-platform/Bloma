#!/usr/bin/env node
// flaky-detector.mjs — 重复跑测试 N 轮，跨 run 聚合 flaky 模式（Bloma 质量门配套诊断工具）
//
// 动机（2026-08-28 主任务实测）：全量 62 文件并发跑时 IO 争抢可使单用例从 ~0.7s 膨胀到 >5s，
// 默认 5s timeout 偶发超时并级联失败；重跑全绿。此类 flaky 单独跑无法复现（mill-build.org/blog/4），
// 必须全量并发重复跑 + 跨 run 聚合才能定位。
//
// 用法:
//   node scripts/flaky-detector.mjs                       # unit 套件跑 3 轮
//   node scripts/flaky-detector.mjs --runs 5              # 5 轮
//   node scripts/flaky-detector.mjs --suite integration   # 换套件
//   node scripts/flaky-detector.mjs -- 'tests/unit/fs*'   # vitest 原生过滤参数透传
//
// 判定语义:
//   恒失败 (fail == runs)      → 真 bug，非 flaky，先修
//   flaky   (0 < fail < runs)  → 候选 flaky（N 轮内出现，复现率 = fail/runs）
//   duration 膨胀比            → max/median 跨轮时长比；仅 med≥100ms 计（毫秒级是噪声，见脚本内注释）
// 输出: 控制台摘要 + markdown 报告（--out，默认 .context/enhancements/flaky-report-<ts>.md）

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const VITEST_CLI = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')

// ---- 参数 ----
const args = process.argv.slice(2)
let runs = 3
let suite = 'unit'
let outPath = ''
let vitestPassthrough = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = Number(args[++i])
  else if (args[i] === '--suite') suite = args[++i]
  else if (args[i] === '--out') outPath = args[++i]
  else if (args[i] === '--') { vitestPassthrough = args.slice(i + 1); break }
  else vitestPassthrough.push(args[i])
}
if (!Number.isFinite(runs) || runs < 2) {
  console.error('[flaky-detector] --runs 至少 2（聚合需要多轮）')
  process.exit(2)
}

const tmpDir = join(ROOT, '.tmp-flaky')
mkdirSync(tmpDir, { recursive: true })
const target = vitestPassthrough.length ? vitestPassthrough : [join('tests', suite)]

// ---- 执行 N 轮 ----
const perRun = [] // {run, code, seconds, json}
for (let r = 1; r <= runs; r++) {
  const outFile = join(tmpDir, `run-${r}.json`)
  const t0 = Date.now()
  console.log(`\n========== [flaky-detector] run ${r}/${runs}: vitest run ${target.join(' ')} ==========`)
  const res = spawnSync(process.execPath, [VITEST_CLI, 'run', ...target, '--reporter=json', '--outputFile', outFile], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'], // 测试输出直通，退出码非 0 属预期
    timeout: 15 * 60 * 1000,
  })
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  const code = res.status ?? (res.error ? -1 : 'SIGKILL')
  let json = null
  if (existsSync(outFile)) {
    try { json = JSON.parse(readFileSync(outFile, 'utf8')) } catch { /* reporter 输出损坏按空处理 */ }
  }
  perRun.push({ run: r, code, seconds, json })
  console.log(`[flaky-detector] run ${r} exit=${code} ${seconds}s tests=${json?.numTotalTests ?? '?'}`)
  rmSync(outFile, { force: true })
}

// ---- 聚合 ----
// key: "file::fullName" -> {file, name, pass, fail, durations[], timeoutHits, failRuns[], msgs[]}
const cases = new Map()
for (const { run, json } of perRun) {
  if (!json?.testResults) continue
  for (const tr of json.testResults) {
    const file = (tr.name || '').replace(/\\/g, '/').replace(/^.*?(tests\/)/, '$1')
    for (const ar of tr.assertionResults || []) {
      const key = `${file}::${ar.fullName}`
      if (!cases.has(key)) cases.set(key, { file, name: ar.fullName, pass: 0, fail: 0, durations: [], timeoutHits: 0, failRuns: [], msgs: [] })
      const c = cases.get(key)
      const dur = Number(ar.duration) || 0
      c.durations.push(dur)
      const msg = (ar.failureMessages || []).join('\n')
      // 超时判定：显式关键词或时长贴近常见 vitest 默认 5s 上限
      if (/timeout|timed out|exceeded/i.test(msg) || (dur > 0 && dur >= 4500 && dur <= 6000)) c.timeoutHits++
      if (ar.status === 'passed') c.pass++
      else {
        c.fail++
        c.failRuns.push(run)
        if (msg && c.msgs.length < 2) c.msgs.push(msg.slice(0, 300))
      }
    }
  }
}

const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const analyzed = [...cases.values()].map((c) => {
  const med = median(c.durations.filter((d) => d > 0))
  const max = Math.max(...c.durations, 0)
  return { ...c, medDur: med, maxDur: max, swellRatio: med > 0 ? +(max / med).toFixed(1) : 0, flakyRate: +(c.fail / runs).toFixed(2) }
})

const hardFail = analyzed.filter((c) => c.fail === runs)
const flaky = analyzed.filter((c) => c.fail > 0 && c.fail < runs).sort((a, b) => b.fail - a.fail || b.swellRatio - a.swellRatio)
// 膨胀比只在绝对时长有意义时计（med>=100ms）：实测毒秒级 med 下 max 偶发抖动可达 25 倍，但距 timeout 三个数量级，纯属噪声（2026-08-28 实验：3 轮出 15 例、全新 2 轮 0 例，非系统性冷启动）
const swellSuspects = analyzed.filter((c) => c.fail === 0 && c.swellRatio >= 3 && c.medDur >= 100).sort((a, b) => b.swellRatio - a.swellRatio).slice(0, 15)
const timeoutish = analyzed.filter((c) => c.timeoutHits > 0)

// run 级失败曲线（IO 争抢信号：某轮失败数突增、其余轮干净）
const failCurve = perRun.map((r) => ({ run: r.run, fails: r.json ? (r.json.numFailedTests ?? 0) : 'n/a', seconds: r.seconds, code: r.code }))
const hadAnyFail = failCurve.some((f) => typeof f.fails === 'number' && f.fails > 0)

// ---- 输出 ----
const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
outPath = outPath || join(ROOT, '..', '.context', 'enhancements', `flaky-report-${ts}.md`)

const lines = []
lines.push(`# flaky-detector 报告 (${ts})`, '')
lines.push(`- 套件: \`${target.join(' ')}\`，轮数: ${runs}，vitest 3.2.7 并发模式`)
lines.push(`- 每轮: ${failCurve.map((f) => `r${f.run}=${f.fails}f/${f.seconds}s`).join(' · ')}`)
lines.push(`- 判定口径: 恒失败=${hardFail.length}，flaky 候选=${flaky.length}，超时相关=${timeoutish.length}，时长膨胀比≥3（未失败）=${swellSuspects.length}`)
lines.push('')
if (hardFail.length) {
  lines.push('## 恒失败（真 bug，非 flaky，先修）', '')
  for (const c of hardFail) lines.push(`- \`${c.file}\` **${c.name}**（${runs}/${runs} 失败）`, `  - ${c.msgs[0] || ''}`)
  lines.push('')
}
if (flaky.length) {
  lines.push(`## flaky 候选（跨轮失败）`, '')
  for (const c of flaky) lines.push(`- \`${c.file}\` **${c.name}** — 失败 ${c.fail}/${runs}（r${c.failRuns.join(',r')}）${c.timeoutHits ? `，超时特征×${c.timeoutHits}` : ''}，时长 med=${c.medDur.toFixed ? c.medDur.toFixed(1) : c.medDur}ms max=${c.maxDur.toFixed ? c.maxDur.toFixed(1) : c.maxDur}ms 膨胀比=${c.swellRatio} 逐轮=[${c.durations.map((d) => d.toFixed(0)).join(',')}]ms`, ...(c.msgs[0] ? [`  - ${c.msgs[0]}`] : []))
  lines.push('')
}
if (swellSuspects.length) {
  lines.push('## 时长膨胀比 ≥3（本次未失败，IO 争抢敏感，失败轮必查）', '')
  for (const c of swellSuspects) lines.push(`- \`${c.file}\` **${c.name}** — med=${c.medDur.toFixed ? c.medDur.toFixed(1) : c.medDur}ms max=${c.maxDur.toFixed ? c.maxDur.toFixed(1) : c.maxDur}ms 膨胀比=${c.swellRatio} 逐轮=[${c.durations.map((d) => d.toFixed(0)).join(',')}]ms`)
  lines.push('')
}
if (!hadAnyFail) lines.push('> 本 N 轮内无失败——flaky 未复现；按 trunk.org 口径可提高 --runs（如 5-10）或保持并发全量跑再聚合。')
lines.push('', '---', '- 方法信源: mill-build.org/blog/4-flaky-tests（并行型 flaky 单跑不复现）；dev.to 2026 guide（30 次/95% 阈值）；trunk.io/ultimate-guide（单独→乱序→并行三步法）')

mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8')

console.log('\n========== [flaky-detector] 摘要 ==========')
console.log(`轮曲线: ${failCurve.map((f) => `r${f.run}=${f.fails}f/${f.seconds}s`).join(' | ')}`)
console.log(`恒失败: ${hardFail.length} | flaky 候选: ${flaky.length} | 超时相关: ${timeoutish.length} | 膨胀比≥3: ${swellSuspects.length}`)
for (const c of hardFail) console.log(`  [HARD] ${c.file} :: ${c.name}`)
for (const c of flaky) console.log(`  [FLAKY ${c.fail}/${runs}] ${c.file} :: ${c.name} (swell=${c.swellRatio})`)
for (const c of swellSuspects.slice(0, 5)) console.log(`  [SWELL ${c.swellRatio}] ${c.file} :: ${c.name} durs=[${c.durations.map((d) => d.toFixed(0)).join(',')}]ms`)
console.log(`报告: ${outPath}`)
rmSync(tmpDir, { recursive: true, force: true })

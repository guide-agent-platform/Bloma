#!/usr/bin/env node
/**
 * Phase 1 回归牌组判定（2026-09-09）。
 *
 * 对 bench/runs/<seed>/ 下 label=p1r 的 run 档案做 7 案例中 3 条可自动跑 seed 的
 * must/mustNot 判定（seed-iter-time-consistency 为 manualOnly，不在自动范围）。
 * 证据源：session-raw.jsonl 的 [decision] 行（卡片时间线）+ evidence.docs.prd（背板）
 * + evidence.artifacts（产物清单）。判定保守：证不足标 MANUAL 不猜。
 *
 * 用法：node bench/harness/l1-regress-check.mjs --label p1r [--out bench/reports/l1-regress-p1r.md]
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runsRoot = fileURLToPath(new URL('../runs/', import.meta.url))
const reportsDir = fileURLToPath(new URL('../reports/', import.meta.url))

const argv = process.argv.slice(2)
const args = { label: 'p1r', out: '' }
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--label') args.label = argv[++i] ?? 'p1r'
  else if (argv[i] === '--out') args.out = argv[++i] ?? ''
  else { console.error(`未知参数：${argv[i]}`); process.exit(2) }
}

/** 解析一个 run 档案：卡片时间线 + 背板 + 产物清单。 */
function loadRun(runDir) {
  const out = { decisions: [], prd: null, artifactFiles: [], terminal: null }
  const manifest = join(runDir, 'manifest.json')
  if (existsSync(manifest)) {
    try { out.terminal = JSON.parse(readFileSync(manifest, 'utf8')).terminal } catch { /* ignore */ }
  }
  const raw = join(runDir, 'session-raw.jsonl')
  if (existsSync(raw)) {
    for (const line of readFileSync(raw, 'utf8').split('\n')) {
      if (!line.includes('[decision]')) continue
      try {
        const row = JSON.parse(line)
        const text = (row.content || []).map((c) => c.text || '').join('')
        const m = text.match(/\[decision\]\s*(\{[\s\S]*\})/)
        if (!m) continue
        const inner = JSON.parse(m[1])
        out.decisions.push({ type: inner.type, at: Number(row.timestamp) || 0, title: inner.title || '' })
      } catch { /* 坏行跳过 */ }
    }
  }
  const evidence = join(runDir, 'evidence.json')
  if (existsSync(evidence)) {
    try {
      const e = JSON.parse(readFileSync(evidence, 'utf8'))
      out.prd = e.docs?.prd ?? null
      out.artifactFiles = Object.keys(e.artifacts?.files ?? {})
      out.sourceSample = String(e.artifacts?.sourceSample ?? '')
    } catch { /* ignore */ }
  }
  return out
}

const hasAfter = (decisions, type, at) => decisions.some((d) => d.type === type && d.at > at)
const countAfter = (decisions, type, at) => decisions.filter((d) => d.type === type && d.at > at).length

/** 在 session 原文里找用户短语首现时间（让渡/催促触发句）。 */
function findPhraseAt(runDir, phrase) {
  const raw = join(runDir, 'session-raw.jsonl')
  if (!existsSync(raw)) return 0
  for (const line of readFileSync(raw, 'utf8').split('\n')) {
    if (!line.includes(phrase)) continue
    try {
      const row = JSON.parse(line)
      if (row.role === 'user' && JSON.stringify(row.content || []).includes(phrase)) return Number(row.timestamp) || 0
    } catch { /* ignore */ }
  }
  return 0
}

const BLACKLIST = /历史|统计|登录|云同步|多用户|收藏|导出/

function checkDelegate(runDir, run) {
  const checks = []
  const at = findPhraseAt(runDir, '你决定别再问')
  if (!at) return [{ name: '触发句定位', verdict: 'MANUAL', note: 'session 里未找到「你决定别再问」用户行' }]
  const askAfter = countAfter(run.decisions, 'clarification_card', at)
  checks.push({ name: 'mustNot：让渡后不再出澄清卡', verdict: askAfter === 0 ? 'PASS' : 'FAIL', note: `让渡后 clarification_card ×${askAfter}` })
  const confirmed = hasAfter(run.decisions, 'requirement_confirm_card', at) || hasAfter(run.decisions, 'clarification_forced_confirm', at)
  checks.push({ name: 'must：交需求确认卡', verdict: confirmed ? 'PASS' : 'FAIL', note: confirmed ? '确认卡出现在让渡后' : '让渡后无确认卡' })
  const guideItems = (run.prd?.requirements || []).filter((r) => r.origin === 'guide')
  const bad = guideItems.filter((r) => BLACKLIST.test(String(r.description || '')))
  checks.push({
    name: 'mustNot：不借让渡扩权（黑名单能力）',
    verdict: bad.length ? 'FAIL' : 'PASS',
    note: bad.length ? `origin=guide 命中黑名单：${bad.map((r) => r.description).join('；').slice(0, 120)}` : `guide 补充 ${guideItems.length} 条，无黑名单命中`,
  })
  return checks
}

function checkRush(runDir, run) {
  const checks = []
  const at = findPhraseAt(runDir, '快开工')
  if (!at) return [{ name: '触发句定位', verdict: 'MANUAL', note: 'session 里未找到「快开工」用户行' }]
  const confirmed = hasAfter(run.decisions, 'requirement_confirm_card', at) || hasAfter(run.decisions, 'clarification_forced_confirm', at)
  checks.push({ name: 'must：催促后仍过需求确认', verdict: confirmed ? 'PASS' : 'FAIL', note: confirmed ? '确认卡在催促后出现' : '催促后无确认卡' })
  const prdConfirmed = run.decisions.filter((d) => d.type === 'prd_confirm')
  checks.push({ name: 'must：PRD 确认门存在', verdict: prdConfirmed.length ? 'PASS' : 'FAIL', note: `prd_confirm ×${prdConfirmed.length}` })
  return checks
}

function checkAiNopersist(runDir, run) {
  const checks = []
  const spec = run.prd?.interface_spec
  if (!run.prd) return [{ name: '背板取证', verdict: 'MANUAL', note: 'evidence.docs.prd 缺失（run 可能未到 PRD 阶段）' }]
  const aiEp = Array.isArray(spec) && spec.some((s) => /llm|ai/i.test(String(s.endpoint || '')))
  checks.push({
    name: 'must：interface_spec 含 AI 端点',
    verdict: aiEp ? 'PASS' : Array.isArray(spec) && spec.length ? 'MANUAL' : 'FAIL',
    note: spec && spec.length ? `端点：${spec.map((s) => s.endpoint).join(', ').slice(0, 120)}` : 'interface_spec 空缺',
  })
  const serverFile = run.artifactFiles.some((f) => f.includes('server/routes'))
  checks.push({ name: '佐证：产物含 server/routes', verdict: serverFile ? 'PASS' : 'MANUAL', note: serverFile ? '存在后端路由产物' : '未见 server/routes（终态未到交付时常见）' })
  return checks
}

const CHECKERS = {
  'seed-guide-delegate': checkDelegate,
  'seed-guide-rush': checkRush,
  'seed-ai-nopersist': checkAiNopersist,
}

const lines = []
lines.push(`# Phase 1 回归判定（label=${args.label}）`)
lines.push('')
lines.push(`> 生成：${new Date().toISOString()}｜范围：7 案例中可自动跑 3 条（iter-time 为 manualOnly 人工执行）；判定保守，证不足标 MANUAL`)
lines.push('')
let anyRun = false
for (const [seedId, check] of Object.entries(CHECKERS)) {
  const dir = join(runsRoot, seedId)
  const runs = existsSync(dir) ? readdirSync(dir).filter((n) => n.includes(`-${args.label}-`)) : []
  lines.push(`## ${seedId}`)
  lines.push('')
  if (runs.length === 0) { lines.push('> 无 run 档案（先跑 p1-ensure 回归牌组）'); lines.push(''); continue }
  anyRun = true
  for (const runId of runs) {
    const runDir = join(dir, runId)
    const run = loadRun(runDir)
    const checks = check(runDir, run)
    const verdict = checks.some((c) => c.verdict === 'FAIL') ? 'FAIL' : checks.every((c) => c.verdict === 'PASS') ? 'PASS' : 'PARTIAL'
    lines.push(`### ${runId} —— ${verdict}（终态 ${run.terminal ? `${run.terminal.kind}@${run.terminal.stage}` : '?'}）`)
    lines.push('')
    for (const c of checks) lines.push(`- ${c.verdict}｜${c.name}｜${c.note}`)
    lines.push('')
  }
}
if (!anyRun) { lines.push('> 本标签下暂无任何回归 run。') }
lines.push('## 判例口径')
lines.push('')
lines.push('- PASS=全部检查通过；FAIL=任一 mustNot/must 硬失败；PARTIAL=无硬失败但有 MANUAL（需人工复核证据）')
lines.push('- 前 3 案例回归（一次性计算器/AI 日报/赛车）走 bench A/B 数值对照（l1-ab），不在本判定范围')
lines.push('- seed-iter-time-consistency（改时间口径五处一致）按 seed-regress $note 人工执行')

const out = args.out || join(reportsDir, `l1-regress-${args.label}.md`)
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(out)

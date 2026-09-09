/**
 * bench 离线扫描 CLI（P0a，2026-09-09）。
 *
 * 用法：
 *   node bench/harness/scan.mjs
 *   node bench/harness/scan.mjs --projects 7ae665fc,a9755cd9
 *   node bench/harness/scan.mjs --out bench/reports/custom.md
 *
 * 只读；输出到 bench/reports/。数据源与纪律见 bench/README.md。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findProjHome, paths, readProjectIndex, findSessionId, collectSession, collectDocuments, summarizeAnalytics } from './collector.mjs'
import { computeProjectMetrics } from './metrics.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const args = new Set(process.argv.slice(2))
function argValue(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}
const filterPrefix = argValue('projects')?.split(',').map((s) => s.trim()).filter(Boolean) || []
const outOverride = argValue('out')
const home = findProjHome()
const { workspace } = paths(home)

function loadAnalyticsIndex() {
  const file = join(workspace, 'analytics.jsonl')
  if (!existsSync(file)) return new Map()
  const map = new Map()
  for (const l of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(l)
      if (!e.project_id) continue
      if (!map.has(e.project_id)) map.set(e.project_id, [])
      map.get(e.project_id).push(e)
    } catch { /* 跳过坏行 */ }
  }
  return map
}

function loadSeeds() {
  const file = join(root, 'bench', 'tasks', 'seed-v0.json')
  if (!existsSync(file)) return []
  try { return JSON.parse(readFileSync(file, 'utf8')).seeds || [] } catch { return [] }
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')

async function main() {
  const projects = readProjectIndex(home).filter((p) =>
    filterPrefix.length === 0 || filterPrefix.some((pre) => p.id.startsWith(pre))
  )
  if (projects.length === 0) {
    console.error('未找到项目（--projects 过滤后为空），检查 BLOMA_PROMA_HOME 与 projects.json')
    process.exit(1)
  }
  console.error(`读取 ${projects.length} 个项目 …`)
  const analyticsByProject = loadAnalyticsIndex()
  const seeds = loadSeeds()
  const seedByProject = new Map(seeds.map((s) => [s.source.projectId, s]))

  const rows = []
  for (const p of projects) {
    const sid = findSessionId(p.id, analyticsByProject, home)
    const session = collectSession(sid, home)
    const docs = collectDocuments(p.id, home)
    const analytics = summarizeAnalytics(analyticsByProject.get(p.id) || [], p.id)
    const evidence = { project: p, docs, analytics, session }
    const m = computeProjectMetrics(evidence)
    const seed = seedByProject.get(p.id)
    m.seed = seed ? { id: seed.id, category: seed.category, title: seed.title, expectation: seed.expectation, knownIssue: seed.knownIssue } : null
    rows.push(m)
  }

  rows.sort((a, b) => (a.created || '').localeCompare(b.created || ''))

  // —— md 报告 ——
  const lines = []
  lines.push('# bench 离线报告（P0a）')
  lines.push(`> 生成：${new Date().toLocaleString('zh-CN', { hour12: false })} · PROMA_HOME=${home} · 项目数=${rows.length}`)
  lines.push('')
  lines.push('## 汇总')
  const flagCounts = {}
  for (const r of rows) for (const f of r.flags) flagCounts[f.code] = (flagCounts[f.code] || 0) + 1
  lines.push('| 项目 | 名称 | stage | req | 契约 | test-report | loop | turns | repair | 风险标记 |')
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of rows) {
    lines.push(`| ${r.id.slice(0, 8)} | ${r.name || '—'} | ${r.stage || '—'} | ${r.prd.requirementCount ?? '—'} | ${r.prd.hasInterfaceSpec ? '✓' : '—'} | ${r.test.hasReport ? `${r.test.passed}/${r.test.total}` : '—'} | ${r.loop.lastStatus || '—'} | ${r.loop.lastTurns ?? '—'} | ${r.loop.repairAttempts} | ${r.flags.map((f) => f.code).join(', ') || '—'} |`)
  }
  lines.push('')
  lines.push('### 特征出现次数')
  if (Object.keys(flagCounts).length) {
    for (const [code, n] of Object.entries(flagCounts).sort((a, b) => b[1] - a[1])) lines.push(`- ${code}: ${n}`)
  } else lines.push('（无）')
  lines.push('')
  lines.push('## 逐项目证据')
  for (const r of rows) {
    lines.push(`### ${r.id.slice(0, 8)} ${r.name || ''} [${r.stage || ''}]`)
    if (r.seed) lines.push(`- seed: ${r.seed.id}（${r.seed.category}）· ${r.seed.expectation}${r.seed.knownIssue ? ` · knownIssue=${r.seed.knownIssue}` : ''}`)
    if (r.prd.requirementCount !== null) lines.push(`- PRD: ${r.prd.requirementCount} 需求项${r.prd.hasInterfaceSpec ? ' · 含 interface_spec' : ''}${r.prd.userConfirmed ? ' · 已用户确认' : ' · 未确认'}`)
    if (r.test.hasReport) lines.push(`- test-report: pass ${r.test.passed}/${r.test.total}，fail ${r.test.failed}`)
    if (r.loop.testCompleted) lines.push(`- test_completed(${r.loop.testCompleted.round}): pass ${(r.loop.testCompleted.total ?? 0) - (r.loop.testCompleted.failed ?? 0)}/${r.loop.testCompleted.total}，fail ${r.loop.testCompleted.failed}${r.loop.testCompleted.failures?.length ? `，失败场景：${r.loop.testCompleted.failures.join('、')}` : ''}`)
    if (r.loop.completedCount > 0) lines.push(`- loop: ${r.loop.completedCount} 次 · 末次 ${r.loop.lastStatus}（turns=${r.loop.lastTurns}，repair=${r.loop.repairAttempts}${r.loop.durationMs ? `，${(r.loop.durationMs / 1000).toFixed(0)}s` : ''}）${r.loop.gwtRuns ? ` · gwt×${r.loop.gwtRuns}` : ''}${r.loop.judgePass || r.loop.judgeFail ? ` · judge pass=${r.loop.judgePass}/fail=${r.loop.judgeFail}` : ''}${r.loop.mvpDelivered ? ' · 已交付' : ' · 未交付'}`)
    if (r.flags.length) {
      lines.push('- 标记:')
      for (const f of r.flags) lines.push(`  - [${f.severity}] ${f.code}: ${f.detail}`)
    }
    lines.push('')
  }
  lines.push('---')
  lines.push('> 注：v0 启发式标记只作提示，共因/随机分类须人工校准；test-report 缺失需确认 GWT 结果落盘位置。')

  const ts = stamp()
  const base = outOverride || `offline-report-${ts}`
  const mdFile = join(root, base)
  const jsonFile = mdFile.replace(/\.md$/, '.json')
  mkdirSync(join(root, 'bench', 'reports'), { recursive: true })
  const mdPath = mdFile.startsWith(join(root, 'bench')) ? mdFile : join(root, 'bench', 'reports', `${base}.md`)
  const jsonPath = mdFile.startsWith(join(root, 'bench')) ? jsonFile : join(root, 'bench', 'reports', `${base}.json`)
  writeFileSync(mdPath, lines.join('\n'), 'utf8')
  writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), promaHome: home, rows }, null, 2), 'utf8')

  console.log(`✓ 报告已写入：\n  ${mdPath}\n  ${jsonPath}`)
  console.error(`\n风险/警告标记统计：\n${rows.map((r) => `  ${r.id.slice(0, 8)} ${r.name}: ${r.flags.map((f) => f.code).join(',') || 'clean'}`).join('\n')}`)
}

main().catch((e) => {
  console.error('scan 失败：', e)
  process.exit(1)
})

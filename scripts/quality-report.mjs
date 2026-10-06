#!/usr/bin/env node
/**
 * quality-report — Bloma 三层质量指标看板（批5 2026-10-06 质量指标地基）。
 *
 * 数据源（全磁盘真相源，零侵入）：
 * - ~/.proma/projects.json                       交付项目清单（completed 桌面单）
 * - ~/.proma/agent-workspaces/<slug>/analytics.jsonl  desktop_dispatch_run（过程层）+
 *                                                desktop_delivery_outcome（产物层）
 *
 * 口径（会话 f35363f6 turn9 讨论 → 实施计划批5）：
 * - 过程层：final_outcome 分布 / attempt_index>1 占比（返工代理）/ repair_class 分布 /
 *   turns 与时长 p50/p90（长尾看 p90，不看均值）
 * - 产物层：交付路径与模式分布 / 驱动路由全绿率 / 场景通过率 / 验收点覆盖
 *   （mapped vs passed）/ 冒烟截图在位率 / 探索降级率
 * - 演进层：占位（迭代链真实用起来才有数据——父子版本回归基线批后置）
 * - 人工介入（manual_code_edit/gate_override）：当前不可观测，如实不列
 *
 * 用法：node scripts/quality-report.mjs [--out report.md]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PROMA_HOME = process.env.PROMA_HOME ?? join(homedir(), '.proma')

// ── 工具 ──
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : '—')
const quantile = (sorted, q) => {
  if (sorted.length === 0) return null
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}
const stats = (values) => {
  if (values.length === 0) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  return { n: sorted.length, p50: Math.round(quantile(sorted, 0.5)), p90: Math.round(quantile(sorted, 0.9)) }
}
const tally = (items) => {
  const map = new Map()
  for (const item of items) map.set(String(item), (map.get(String(item)) ?? 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1])
}

// ── 数据采集 ──
function readDispatchRuns() {
  const runs = []
  const deliveries = []
  const wsRoot = join(PROMA_HOME, 'agent-workspaces')
  if (!existsSync(wsRoot)) return { runs, deliveries }
  for (const slug of readdirSync(wsRoot, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue
    const analyticsPath = join(wsRoot, slug.name, 'analytics.jsonl')
    if (!existsSync(analyticsPath)) continue
    const lines = readFileSync(analyticsPath, 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line)
        const event = entry.event ?? entry
        if (event.event_type === 'desktop_dispatch_run') runs.push({ ...event.payload, ts: entry.timestamp ?? event.timestamp })
        if (event.event_type === 'desktop_delivery_outcome') deliveries.push({ ...event.payload, ts: entry.timestamp ?? event.timestamp, project_id: event.project_id })
      } catch {
        // 坏行跳过
      }
    }
  }
  return { runs, deliveries }
}

function readCompletedProjects() {
  try {
    const parsed = JSON.parse(readFileSync(join(PROMA_HOME, 'projects.json'), 'utf8'))
    const items = Array.isArray(parsed) ? parsed : (parsed.projects ?? [])
    return items.filter((p) => p?.status === 'completed' && p?.current_stage === 'completed')
  } catch {
    return []
  }
}

// ── 聚合 ──
const { runs, deliveries } = readDispatchRuns()
const completed = readCompletedProjects()

const processSection = () => {
  const lines = ['## 一、过程质量（desktop_dispatch_run）', '']
  if (runs.length === 0) {
    lines.push('（无事件——先跑狗粮/真实单积累）', '')
    return lines
  }
  lines.push(`- 段 run 总数：${runs.length}（阶段分布：${tally(runs.map((r) => r.phase ?? '?')).map(([k, v]) => `${k}×${v}`).join('、')}）`)
  lines.push(`- 终态分布：${tally(runs.map((r) => r.final_outcome ?? '(无字段·旧事件)')).map(([k, v]) => `${k}×${v}`).join('、')}`)
  const attempted = runs.filter((r) => typeof r.attempt_index === 'number')
  if (attempted.length > 0) {
    const retried = attempted.filter((r) => r.attempt_index > 1)
    lines.push(`- 同阶段返工段：${retried.length}/${attempted.length}（${pct(retried.length, attempted.length)}）——首次全门通过率的过程侧代理`)
  }
  const repair = tally(runs.map((r) => r.repair_class).filter(Boolean))
  if (repair.length > 0) lines.push(`- 拒因修复分类：${repair.map(([k, v]) => `${k}×${v}`).join('、')}`)
  const turns = stats(runs.map((r) => r.turns).filter((v) => typeof v === 'number'))
  lines.push(`- turns：n=${turns.n} p50=${turns.p50 ?? '—'} p90=${turns.p90 ?? '—'}（p90 看长尾失控）`)
  const dur = stats(runs.map((r) => r.duration_ms).filter((v) => typeof v === 'number'))
  lines.push(`- 段时长 ms：n=${dur.n} p50=${dur.p50 ?? '—'} p90=${dur.p90 ?? '—'}`)
  lines.push('')
  return lines
}

const productSection = () => {
  const lines = ['## 二、产物质量（desktop_delivery_outcome + projects.json）', '']
  lines.push(`- 交付总数（projects.json completed）：${completed.length}`)
  if (deliveries.length === 0) {
    lines.push('- （无交付事件——旧交付或事件未启用；盘面以 projects.json 为准）', '')
    return lines
  }
  lines.push(`- 交付事件：${deliveries.length}（路径：${tally(deliveries.map((d) => d.via ?? '?')).map(([k, v]) => `${k}×${v}`).join('、')}；模式：${tally(deliveries.map((d) => d.mode ?? '?')).map(([k, v]) => `${k}×${v}`).join('、')}）`)
  const withDriver = deliveries.filter((d) => d.driver)
  if (withDriver.length > 0) {
    const routed = withDriver.filter((d) => d.driver.routing === 'pass').length
    lines.push(`- 驱动路由全绿：${routed}/${withDriver.length}（${pct(routed, withDriver.length)}）`)
    const scenariosTotal = withDriver.reduce((s, d) => s + (d.driver.scenarios_total ?? 0), 0)
    const scenariosPass = withDriver.reduce((s, d) => s + (d.driver.scenarios_pass ?? 0), 0)
    lines.push(`- 场景通过：${scenariosPass}/${scenariosTotal}（${pct(scenariosPass, scenariosTotal)}）`)
    const mapped = withDriver.reduce((s, d) => s + (d.driver.acceptance_mapped ?? 0), 0)
    const passedFids = withDriver.reduce((s, d) => s + (d.driver.acceptance_passed ?? 0), 0)
    lines.push(`- 验收点覆盖（批4 映射制）：mapped ${mapped} / passed ${passedFids}（${pct(passedFids, mapped)}）`)
  }
  const withSmoke = deliveries.filter((d) => typeof d.smoke_screenshot === 'boolean')
  if (withSmoke.length > 0) {
    const shot = withSmoke.filter((d) => d.smoke_screenshot).length
    lines.push(`- 冒烟截图在位：${shot}/${withSmoke.length}（${pct(shot, withSmoke.length)}）`)
  }
  const withExploration = deliveries.filter((d) => d.exploration)
  if (withExploration.length > 0) {
    const degraded = withExploration.filter((d) => (d.exploration.degraded ?? 0) > 0)
    lines.push(`- 探索降级单：${degraded.length}/${withExploration.length}（${pct(degraded.length, withExploration.length)}——P0=0 不等同无问题的发现④口径）`)
  }
  lines.push('')
  return lines
}

const evolutionSection = [
  '## 三、演进质量（占位）',
  '',
  '- 迭代回归率 / 限额内变更成功率 / 重建回滚成功率：迭代链真实用起来后接入',
  '  （父子版本冻结测试基线是后置批，见实施计划批5「不做挂账」）。',
  '- 人工介入（manual_code_edit / gate_override）：当前无平台观测面，如实不列',
  '  （讨论 turn9 口径——不可观测不假装可观测）。',
  '',
]

// ── 输出 ──
const window = (() => {
  const ts = [...runs, ...deliveries].map((e) => e.ts).filter(Boolean).sort()
  return ts.length > 0 ? `${ts[0]} ~ ${ts[ts.length - 1]}` : '（无事件）'
})()

const report = [
  '# Bloma 质量指标看板',
  '',
  `> 生成：${new Date().toISOString()} · 数据窗：${window} · PROMA_HOME=${PROMA_HOME}`,
  '',
  ...processSection(),
  ...productSection(),
  ...evolutionSection,
].join('\n')

const outArg = process.argv.indexOf('--out')
if (outArg > 0 && process.argv[outArg + 1]) {
  writeFileSync(process.argv[outArg + 1], report, 'utf8')
  console.log(`已写入 ${process.argv[outArg + 1]}`)
} else {
  console.log(report)
}

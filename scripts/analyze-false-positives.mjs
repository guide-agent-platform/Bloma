#!/usr/bin/env node
/**
 * analyze-false-positives.mjs — 调度系统 Analyzer 角色（纯统计，零凭据，零 LLM）
 *
 * 输入：~/.proma/bloma-grayscale-history.jsonl（含 artifacts 独立检验信号）+ 真实账本。
 * 逻辑（阶段一标记层，2026-09-07 用户决策三）：
 *   对「流水线 verdict=circuit_break_settled 且产物独立检验 HEALTHY」的样本轮：
 *   - 该轮 project 产生的 **coding/gwt/** 断言卡 → 追加快照行打 suspected_false_positive
 *     （产物经真浏览器检验可用 = 断言字面误伤；消费侧已隔离：不注入、不重放、不产晋升证据）
 *   - **unknown/outcome/** 结局卡不打标**（loop 预算耗尽是真实结局，与产物健康度无关）
 *   - 原始对照数据（断言文本 vs 产物可见文本）写入报告供阶段二同义词挖掘（LLM/人工）
 * 幂等：~/.proma/bloma-fp-processed.json 记已处理 history 行 ts；重复运行零副作用。
 * 输出：reports/false-positive-report-<UTC日期>.json + stdout 一行摘要（orchestrator 消费）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dirname, '..')
const HISTORY = join(homedir(), '.proma', 'bloma-grayscale-history.jsonl')
const LEDGER = join(homedir(), '.proma', 'bloma-experience.jsonl')
const PROCESSED = join(homedir(), '.proma', 'bloma-fp-processed.json')
const REPORTS = join(REPO, 'reports')
const nowIso = () => new Date().toISOString()
// 与产品 types.ts hashProjectRef 同算法（账本 seen_projects 存脱敏 12-hex 短哈希）
const hashProject = (uuid) => createHash('sha256').update(`bloma-project:${uuid}`, 'utf8').digest('hex').slice(0, 12)

const readJsonl = (p) => (existsSync(p) ? readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) : [])

const processed = new Set((existsSync(PROCESSED) ? readFileSync(PROCESSED, 'utf8') : '').split(/\r?\n/).filter(Boolean).map(Number))
const rows = readJsonl(HISTORY).filter((h) => !processed.has(h.ts))
const ledgerRows = readJsonl(LEDGER)
// 每 id 最新快照
const latestById = new Map()
for (const c of ledgerRows) {
  const prev = latestById.get(c.id)
  if (!prev || (c.updated_at || 0) >= (prev.updated_at || 0)) latestById.set(c.id, c)
}

const cases = []
const newlyMarked = []
for (const h of rows) {
  processed.add(h.ts)
  const healthyNames = new Set((h.artifacts || []).filter((a) => a.artifact === 'HEALTHY').map((a) => a.name))
  for (const s of h.samples || []) {
    if (s.verdict !== 'circuit_break_settled' || !healthyNames.has(s.name) || !h.temp_home) continue
    // projectId 兜底反推（用户风险②）：旧 history 行无 projectId 时，枚举该轮 temp home
    // 产物目录的全部项目短哈希做匹配（同轮多样本时打标范围=该轮 HEALTHY 样本产物集合，
    // 误伤面可控——HEALTHY 判定本就是逐产物做的）
    const gpDir = join(h.temp_home, 'agent-workspaces', 'default-software-builder', 'generated-projects')
    const matchPids = s.projectId ? [hashProject(s.projectId)] : (existsSync(gpDir) ? readdirSync(gpDir).map(hashProject) : [])
    if (matchPids.length === 0) continue
    // 该轮产物可见文本样本（供阶段二挖掘）
    let artifactText = ''
    try {
      const html = readFileSync(join(h.temp_home, 'agent-workspaces', 'default-software-builder', 'generated-projects', s.projectId, 'index.html'), 'utf8')
      artifactText = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600)
    } catch {}
    for (const c of latestById.values()) {
      if (c.kind !== 'anti_pattern' || !c.tag.startsWith('coding/gwt/')) continue
      if (!(c.seen_projects || []).some((p) => matchPids.includes(p))) continue
      if (c.body.suspected_false_positive) continue
      const m = /GWT 场景「(.+?)」/.exec(c.body.symptom)
      cases.push({ card_id: c.id, tag: c.tag, assertion: m ? m[1] : c.body.symptom.slice(0, 120), artifact_text: artifactText, sample: s.name, round_ts: h.ts })
      const marked = { ...c, body: { ...c.body, suspected_false_positive: true }, updated_at: Date.now() }
      appendFileSync(LEDGER, JSON.stringify(marked) + '\n', 'utf8')
      latestById.set(c.id, marked)
      newlyMarked.push(c.id)
    }
  }
}

mkdirSync(REPORTS, { recursive: true })
const reportPath = join(REPORTS, `false-positive-report-${nowIso().slice(0, 10)}.json`)
const prevReport = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
const report = {
  generated_at: nowIso(),
  scanned_history_rows: rows.length,
  false_positive_cases: (prevReport?.false_positive_cases || []).concat(cases),
  newly_marked: newlyMarked.length,
  ledger_total_lines: readFileSync(LEDGER, 'utf8').split(/\r?\n/).filter(Boolean).length,
}
writeFileSync(reportPath, JSON.stringify(report, null, 1), 'utf8')
writeFileSync(PROCESSED, [...processed].join('\n'), 'utf8')
console.log(`FP_ANALYZE done: rounds=${rows.length} newly_marked=${newlyMarked.length} total_cases=${report.false_positive_cases.length} report=${reportPath}`)

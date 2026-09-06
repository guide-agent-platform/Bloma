#!/usr/bin/env node
/**
 * T-3 冷启动回灌（离线脚本，不动交付链）：
 * 扫描存量 PROMA_HOME 下各项目 documents 的 learnings.jsonl（loop_outcome/repair_outcome）
 * 与 test-report.json（failure_summary），组装 anti_pattern 候选卡写入统一账本，
 * 让经验库第一天就有粮。
 *
 * 用法：
 *   node scripts/backfill-error-cards.mjs [--dry-run] [--root <PROMA_HOME>] [--limit N]
 *
 * 实现口径：
 * - 组装/脱敏/指纹/预算的**单一事实源** = main/experience/types.ts（经 esbuild 现包
 *   临时 bundle 复用，无 tsx/无第二实现，防漂移）；窗口折叠不适用于离线批（同指纹
 *   跨项目合并直接 recurrence++，等价语义见 types 治理常量注释）；
 * - 红线（用户 2026-09-07 拍板）：开发工作区（TEEm .context）的 errors.md/verdict
 *   只借分类法格式，内容**绝不入册**——本脚本只读 PROMA_HOME 下的产品运行数据；
 * - 幂等：重复运行读现有账本按 fingerprint 合并计数，不重复建行；
 * - --dry-run 只出报表不写盘。
 */
import { build } from 'esbuild'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const repoRoot = process.env.BLOMA_ROOT || process.cwd()

function resolveRoot() {
  const flagIdx = process.argv.indexOf('--root')
  if (flagIdx >= 0 && process.argv[flagIdx + 1]) return process.argv[flagIdx + 1]
  const env = (process.env.PROMA_HOME || '').trim()
  if (env && env !== 'undefined' && env !== 'null') return env
  return join(homedir(), '.proma')
}

/** esbuild 现包 types.ts（纯 node:crypto 依赖，零 electron）成临时 mjs 供 import。 */
async function loadExperienceTypes() {
  const outDir = mkdtempSync(join(tmpdir(), 'bloma-backfill-'))
  const outFile = join(outDir, 'experience-types.mjs')
  await build({
    entryPoints: [join(repoRoot, 'main', 'experience', 'types.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    logLevel: 'silent',
  })
  try {
    const mod = await import(pathToFileURL(outFile).href)
    return { mod, cleanup: () => rmSync(outDir, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(outDir, { recursive: true, force: true })
    throw error
  }
}

function iterProjectDirs(root) {
  const base = join(root, 'agent-workspaces')
  if (!existsSync(base)) return []
  const out = []
  for (const ws of readdirSync(base)) {
    const docs = join(base, ws, 'documents')
    if (!existsSync(docs)) continue
    for (const pid of readdirSync(docs)) {
      out.push({ projectId: pid, dir: join(docs, pid) })
    }
  }
  return out
}

function parseJsonl(path) {
  if (!existsSync(path)) return []
  const rows = []
  let bad = 0
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object') rows.push(v)
    } catch {
      bad++
    }
  }
  return rows
}

/** learnings(loop_outcome/repair_outcome) + test-report(failure_summary) → 原始信号。 */
function collectSignals(root) {
  const signals = []
  for (const { projectId, dir } of iterProjectDirs(root)) {
    for (const l of parseJsonl(join(dir, 'learnings.jsonl'))) {
      if (l.kind === 'loop_outcome' || l.kind === 'repair_outcome') {
        signals.push({
          projectId,
          kind: 'abnormal',
          outcomeType: /turn_limit|budget_exhausted/.test(String(l.text)) ? 'timeout' : 'unexpected_exit',
          description: String(l.text ?? '').slice(0, 300),
          timestamp: Date.parse(l.recorded_at) || Date.now(),
        })
      }
    }
    const reportPath = join(dir, 'test-report.json')
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'))
        for (const f of (report.failure_summary ?? []).slice(0, 5)) {
          signals.push({
            projectId,
            kind: 'gwt',
            scenario: String(f.scenario ?? ''),
            reason: String(f.reason ?? ''),
            timestamp: Date.now(),
          })
        }
      } catch {
        /* 脏报告跳过（读取侧兼容） */
      }
    }
  }
  return signals
}

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  const limitIdx = process.argv.indexOf('--limit')
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) || Infinity : Infinity
  const root = resolveRoot()
  const { mod: T, cleanup } = await loadExperienceTypes()
  try {
    const signals = collectSignals(root).slice(0, limit)
    const ledgerPath = join(root, 'bloma-experience.jsonl')
    // 现有账本压缩视图（last-write-wins）
    const byIdView = new Map()
    for (const line of existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n') : []) {
      if (!line.trim()) continue
      try {
        const c = JSON.parse(line)
        if (c?.id && c?.fingerprint) byIdView.set(c.id, c)
      } catch { /* 坏行跳过 */ }
    }
    const byFp = new Map()
    for (const c of byIdView.values()) {
      if (c.status !== 'retired') byFp.set(`${c.kind}:${c.fingerprint}`, c)
    }

    const now = () => Date.now()
    const newLines = []
    let merged = 0
    let skipped = 0
    for (const s of signals) {
      const projectHash = T.hashProjectRef(s.projectId)
      let card
      if (s.kind === 'gwt') {
        const symptom = `GWT 场景「${s.scenario}」未通过：${s.reason}`
        const body = {
          stage: 'coding',
          symptom,
          trigger_condition: `按场景「${s.scenario}」执行行为断言时`,
          root_cause: { stage: 'coding', description: symptom, method: 'rule', confidence: 1 },
          test_checklist: [`重验场景「${s.scenario}」的行为断言`],
          review_checklist: ['检查该断言涉及的事件绑定/状态更新/渲染路径是否真实生效'],
          severity: 2,
        }
        card = {
          id: cryptoId(), schema_version: T.EXPERIENCE_GOVERNANCE.SCHEMA_VERSION, kind: 'anti_pattern',
          tag: `coding/gwt/${T.keyFromSymptom(s.reason || s.scenario)}`, status: 'candidate',
          created_at: s.timestamp, updated_at: s.timestamp, recurrence: 1,
          source: { type: 'backfill', project_hash: projectHash, timestamp: s.timestamp },
          fingerprint: T.computeFingerprint('anti_pattern', body), body,
        }
      } else {
        const stage = 'unknown'
        const symptom = `异常结局（${s.outcomeType}）：${s.description}`
        const body = {
          stage, symptom,
          trigger_condition: '长任务执行至预算/时限边界时',
          root_cause: { stage, description: symptom, method: 'rule', confidence: 1 },
          test_checklist: ['为同类任务准备残局恢复路径（不假装交付）'],
          review_checklist: ['检查该结局是否被如实上报（无谎报完成）'],
          severity: s.outcomeType === 'timeout' ? 1 : 3,
        }
        card = {
          id: cryptoId(), schema_version: T.EXPERIENCE_GOVERNANCE.SCHEMA_VERSION, kind: 'anti_pattern',
          tag: `unknown/outcome/${s.outcomeType}`, status: 'candidate',
          created_at: s.timestamp, updated_at: s.timestamp, recurrence: 1,
          source: { type: 'backfill', project_hash: projectHash, timestamp: s.timestamp },
          fingerprint: T.computeFingerprint('anti_pattern', body), body,
        }
      }
      const key = `${card.kind}:${card.fingerprint}`
      const projHash = T.hashProjectRef(s.projectId)
      if (byFp.has(key)) {
        const existing = byFp.get(key)
        const seen = new Set(existing.seen_projects ?? [existing.source?.project_hash].filter(Boolean))
        if (seen.has(projHash)) {
          skipped++
          continue // 同项目同指纹（含重跑）：幂等跳过
        }
        seen.add(projHash)
        const bumped = { ...existing, seen_projects: [...seen], recurrence: existing.recurrence + 1, updated_at: now() }
        newLines.push(JSON.stringify(T.sanitizeCard(bumped)))
        byFp.set(key, bumped)
        merged++
        continue
      }
      card.seen_projects = [projHash]
      const clean = T.sanitizeCard(card)
      newLines.push(JSON.stringify(clean))
      byFp.set(key, clean)
    }

    const report = `[backfill] root=${root} signals=${signals.length} new_or_merged_rows=${newLines.length} (new=${newLines.length - merged} merged=${merged}) skipped_same_project=${skipped}`
    console.log(report)
    if (dryRun) {
      console.log('[backfill] dry-run：不写账本。样例前 3 条：')
      for (const line of newLines.slice(0, 3)) {
        const c = JSON.parse(line)
        console.log(`  - ${c.tag} r=${c.recurrence} ${c.body.symptom.slice(0, 80)}`)
      }
      return
    }
    if (newLines.length > 0) {
      appendFileSync(ledgerPath, newLines.join('\n') + '\n', 'utf8')
      console.log(`[backfill] 写入 ${newLines.length} 行 → ${ledgerPath}`)
    } else {
      console.log('[backfill] 无新数据（幂等）')
    }
  } finally {
    cleanup()
  }
}

function cryptoId() {
  return (globalThis.crypto?.randomUUID?.() ?? `bf-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

main().catch((error) => {
  console.error('[backfill] failed:', error)
  process.exit(1)
})

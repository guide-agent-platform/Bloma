#!/usr/bin/env node
/**
 * F 系列 W2.2（Phase 10 承接，2026-09-16）：经验账本 v1 存量隔离迁移（一次性，幂等）。
 *
 * 拍板 D1：同账本追加治理行（card_reclassified / card_quarantined / migration_completed），
 * 不建 v2 文件、不改写旧行（append-only）。
 *   - kind==='pattern'（R2 市调灵感时代产物）→ card_reclassified（灵感区：
 *     listReclassifiedInspirations() 读取口供向导「历史灵感」来源位消费）；
 *   - 其余 v1 卡（GWT/timeout/裁判/熔断/negative 种子）→ card_quarantined
 *     （root_cause=symptom 原文复制未经证实，消费面已由 isConsumable 冻结，不合成根因卡）。
 * 幂等：migration_id='v2-isolation-20260916' 的 migration_completed 行已存在则直接退出。
 * 用法：PROMA_HOME=<dir> node scripts/migrate-experience-v2.mjs [--dry-run]
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATION_ID = 'v2-isolation-20260916'
const dryRun = process.argv.includes('--dry-run')
const home = process.env.PROMA_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.proma')
const ledger = join(home, 'bloma-experience.jsonl')

if (!existsSync(ledger)) {
  console.log(`[migrate-v2] 账本不存在（${ledger}）——无存量可迁移，退出`)
  process.exit(0)
}

const lines = readFileSync(ledger, 'utf8').split('\n').filter((l) => l.trim())
const cards = []
let lifecycle = []
for (const line of lines) {
  try {
    const parsed = JSON.parse(line)
    if (parsed.record_type === 'lifecycle') lifecycle.push(parsed)
    else if (parsed.record_type === 'event') continue
    else if (typeof parsed.id === 'string' && typeof parsed.fingerprint === 'string' && parsed.body) cards.push(parsed)
  } catch {
    // 坏行跳过
  }
}

if (lifecycle.some((row) => row.migration_id === MIGRATION_ID)) {
  console.log(`[migrate-v2] migration_id=${MIGRATION_ID} 已应用——幂等退出（卡 ${cards.length} 张）`)
  process.exit(0)
}

// 同 fingerprint 多行（last-write-wins 语义）只登记一次
const seenFingerprints = new Set()
let reclassified = 0
let quarantined = 0
const out = []
for (const card of cards) {
  if (seenFingerprints.has(card.fingerprint)) continue
  seenFingerprints.add(card.fingerprint)
  if (card.kind === 'pattern') {
    reclassified += 1
    out.push({ record_type: 'lifecycle', kind: 'card_reclassified', target_fingerprint: card.fingerprint, reason: 'R2 市调灵感迁移灵感区（历史灵感来源位）；root_cause 未经证实，不进消费面', migration_id: MIGRATION_ID, timestamp: new Date().toISOString() })
  } else {
    quarantined += 1
    out.push({ record_type: 'lifecycle', kind: 'card_quarantined', target_fingerprint: card.fingerprint, reason: 'v1 采集卡隔离（root_cause=symptom 原文复制未经证实；F 系列 W2.3 消费面已冻结，事件行承接采集）', migration_id: MIGRATION_ID, timestamp: new Date().toISOString() })
  }
}
out.push({ record_type: 'lifecycle', kind: 'migration_completed', target_fingerprint: '', reason: `v1 存量隔离完成：reclassified ${reclassified} / quarantined ${quarantined}`, migration_id: MIGRATION_ID, timestamp: new Date().toISOString() })

if (dryRun) {
  console.log(`[migrate-v2][dry-run] 将写 ${out.length} 行治理行（reclassified ${reclassified} / quarantined ${quarantined}）`)
  process.exit(0)
}
appendFileSync(ledger, out.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
console.log(`[migrate-v2] 完成：reclassified ${reclassified} / quarantined ${quarantined}（治理行 ${out.length} 条，migration_id=${MIGRATION_ID}）`)

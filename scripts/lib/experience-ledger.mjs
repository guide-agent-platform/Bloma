/**
 * 离线批跑脚本共用的账本薄层（G1/G2/G3 用；纯 sidecar 语义，与运行时
 * experience-service 的合并规则一致：同 kind+fingerprint 非 retired 视为同卡，
 * seen_projects 判是否新观察——单一合并语义在 types 治理常量下实现两份薄适配，
 * 差异仅"脚本进程内无内存索引"）。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

export function promaHome(explicit) {
  if (explicit) return explicit
  const env = (process.env.PROMA_HOME ?? '').trim()
  if (env && env !== 'undefined' && env !== 'null') return env
  return join(homedir(), '.proma')
}

export function ledgerPath(root) {
  return join(root, 'bloma-experience.jsonl')
}

/** 压缩视图（同 id 后行覆盖）。 */
export function loadLedger(path) {
  const byId = new Map()
  if (!existsSync(path)) return byId
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const c = JSON.parse(line)
      if (c && c.id) byId.set(c.id, c)
    } catch {
      /* 坏行跳过 */
    }
  }
  return byId
}

/**
 * 幂等入册：同 kind+fingerprint 的活跃卡——seen_projects 已有该源 → 跳过（幂等）；
 * 新源 → 追加合并行（recurrence+1）。无同卡 → 追加新行。返回 'new'|'merged'|'skipped'。
 */
export function upsertCard(path, card) {
  const view = loadLedger(path)
  let result = 'new'
  for (const c of view.values()) {
    if (c.kind === card.kind && c.fingerprint === card.fingerprint && c.status !== 'retired') {
      const seen = new Set(c.seen_projects ?? [c.source?.project_hash].filter(Boolean))
      const src = card.source?.project_hash
      if (seen.has(src)) {
        result = 'skipped'
      } else {
        seen.add(src)
        appendFileSync(path, JSON.stringify({ ...c, seen_projects: [...seen], recurrence: c.recurrence + 1, updated_at: Date.now() }) + '\n', 'utf8')
        result = 'merged'
      }
      break
    }
  }
  if (result === 'new') {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, JSON.stringify(card) + '\n', 'utf8')
  }
  return result
}

/** sha256 hex（code_hash 用，与 types 指纹族同源算法）。 */
export function sha256(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

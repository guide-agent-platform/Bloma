import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getExperienceIndexPath } from '../../storage/config-paths'
import {
  EXPERIENCE_GOVERNANCE,
  computeFingerprint,
  experienceEnabled,
  isConsumable,
  isRetireEligibleCandidate,
  isStale,
  sanitizeCard,
  type AntiPatternBody,
  type CardEnvelope,
  type CardKind,
  type ExperienceCard,
  type VerificationMethod,
} from './types'

/**
 * 统一入册闸门（T-2，方案 2026-09-07 拍板）：anti_pattern / pattern 两 kind 同账本。
 *
 * 存储模型：**append-only 全量快照行**（每行一个完整 ExperienceCard JSON）。
 * - 状态变更（recurrence++/转正/退役/统计）不原地改写——追加新行，读取时同 id
 *   后行覆盖前行（last-write-wins）。跨进程安全：主程序与离线脚本（T-3 backfill）
 *   只会互相追加、不会读改写整文件；单进程内写经内存索引串行。
 * - 加载即压缩视图：readAllCards 只回每 id 最新行；文件膨胀由后续 compaction
 *   故事处理（v1 教学项目规模不做）。
 *
 * 治理（决策 3：常量全局定义于 types.ts，此处只引用）：
 * - 10 分钟窗口内同 fingerprint 折叠（同一轮多写点连击不重复计数）；窗口外
 *   recurrence+1——跨项目复发 ≥2 是 candidate 的消费入池资格（verified 恒可）。
 * - candidate 超 60 天未验证由 maintenancePass 自动 retire（30 天 deferred 语义见
 *   types 常量注释，v1 不引入第四状态）。
 * - selectForInjection：可消费过滤 → stale 排除（include_stale 放宽且权重×0.5）→
 *   相关性排序（tag/阶段/关键词重叠 + verified 加成 + 时效）→ **整条取舍**预算截断。
 *
 * 静默失败纪律（judge-semantic 同款）：账本 IO/解析异常一律 warn + 降级，绝不
 * 阻断生成主链路；开关 BLOMA_EXPERIENCE off 时注册 no-op、查询恒空 = 现状字节级。
 */

const LOG = '[experience]'
const DAY_MS = 86_400_000

export interface RegisterInput {
  kind: CardKind
  tag: string
  body: ExperienceCard['body']
  source: CardEnvelope['source']
}

// —— 内存索引（启动惰性加载，写操作增量维护）——
let cardsById: Map<string, ExperienceCard> | null = null

/** 测试/脚本 seam：换 PROMA_HOME 后强制重载。 */
export function resetExperienceIndexForTests(): void {
  cardsById = null
}

function ensureIndex(): Map<string, ExperienceCard> {
  if (cardsById) return cardsById
  const map = new Map<string, ExperienceCard>()
  try {
    const path = getExperienceIndexPath()
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').split('\n')
      let bad = 0
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const card = JSON.parse(line) as ExperienceCard
          if (card && typeof card.id === 'string' && typeof card.fingerprint === 'string' && card.body) {
            map.set(card.id, card) // 后行覆盖前行
          } else {
            bad++
          }
        } catch {
          bad++
        }
      }
      if (bad > 0) console.warn(`${LOG} skipped ${bad} malformed line(s) in ledger`)
    }
  } catch (error) {
    console.warn(`${LOG} ledger load failed, start empty:`, (error as Error)?.message)
  }
  cardsById = map
  return map
}

function appendCard(card: ExperienceCard): void {
  try {
    const path = getExperienceIndexPath()
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${JSON.stringify(card)}\n`, 'utf8')
    ensureIndex().set(card.id, card)
  } catch (error) {
    console.warn(`${LOG} append failed, card kept in memory only:`, (error as Error)?.message)
    ensureIndex().set(card.id, card)
  }
}

function cloneCard<C extends ExperienceCard>(card: C): C {
  return JSON.parse(JSON.stringify(card)) as C
}

/** 同指纹的可合并卡（非 retired），按 updated_at 最新优先。 */
function findSameFingerprint(fingerprint: string, kind: CardKind): ExperienceCard | undefined {
  return [...ensureIndex().values()]
    .filter((c) => c.fingerprint === fingerprint && c.kind === kind && c.status !== 'retired')
    .sort((a, b) => b.updated_at - a.updated_at)[0]
}

// =========================================================================
// 注册与状态机
// =========================================================================

/**
 * 尝试注册一张卡（必经脱敏）。开关 off → no-op 返回 null。
 * 同指纹窗口内折叠（不加行不计数）；窗口外 recurrence+1（追加新快照行）。
 */
export async function tryRegisterCard(input: RegisterInput): Promise<ExperienceCard | null> {
  if (!experienceEnabled()) return null
  try {
    const now = Date.now()
    const created = {
      id: randomUUID(),
      schema_version: EXPERIENCE_GOVERNANCE.SCHEMA_VERSION,
      kind: input.kind,
      tag: input.tag,
      status: 'candidate',
      created_at: now,
      updated_at: now,
      recurrence: 1,
      source: input.source,
      fingerprint: computeFingerprint(input.kind, input.body),
      body: input.body,
    } as unknown as ExperienceCard
    return await registerCore(sanitizeCard(created))
  } catch (error) {
    console.warn(`${LOG} register failed, skipping:`, (error as Error)?.message)
    return null
  }
}

/** 采集层门面入口（T-1）：接受组装器产出的完整候选卡，走同一去重/入册规则。 */
export async function registerCandidateCard(card: ExperienceCard): Promise<ExperienceCard | null> {
  if (!experienceEnabled()) return null
  try {
    return await registerCore(sanitizeCard(card))
  } catch (error) {
    console.warn(`${LOG} registerCandidate failed, skipping:`, (error as Error)?.message)
    return null
  }
}

/** 入册内核：指纹窗口折叠 / **跨项目** recurrence 合并（seen_projects 单一事实源，
 * 同项目重复观测不重复计数，幂等）/ 新卡落盘。 */
async function registerCore(card: ExperienceCard): Promise<ExperienceCard> {
  const now = Date.now()
  const existing = findSameFingerprint(card.fingerprint, card.kind)
  if (existing) {
    const seen = new Set(existing.seen_projects ?? [existing.source.project_hash])
    if (now - existing.updated_at < EXPERIENCE_GOVERNANCE.DEDUP_WINDOW_MS) {
      return cloneCard(existing)
    }
    if (seen.has(card.source.project_hash)) {
      // 同项目重复观察（回灌重跑/同项多轮）：不重复计数也不加行
      return cloneCard(existing)
    }
    const merged = cloneCard(existing)
    seen.add(card.source.project_hash)
    merged.seen_projects = [...seen]
    merged.recurrence += 1
    merged.updated_at = now
    appendCard(merged)
    console.log(`${LOG} recurrence merged:`, merged.id, `-> ${merged.recurrence}`)
    return merged
  }
  const fresh = cloneCard(card)
  fresh.seen_projects = [...new Set([...(fresh.seen_projects ?? []), fresh.source.project_hash])]
  appendCard(fresh)
  console.log(`${LOG} registered new card:`, fresh.id, fresh.kind, fresh.tag)
  return fresh
}

/**
 * 幂等归因写回（T-4 用户点名要求）：已存在卡只走 update——追加同 id 新快照行，
 * 压缩视图永远单卡，**绝不重新 insert**；归因结果与现值等同时直接返回不加行
 * （重复精化/回灌重跑幂等）。
 */
export async function updateCardAttribution(
  id: string,
  rootCause: AntiPatternBody['root_cause'],
): Promise<ExperienceCard | null> {
  if (!experienceEnabled()) return null
  const card = ensureIndex().get(id)
  if (!card || card.status === 'retired' || card.kind !== 'anti_pattern') return null
  const old = card.body.root_cause
  const same =
    old.stage === rootCause.stage &&
    old.method === rootCause.method &&
    old.confidence === rootCause.confidence &&
    old.description === rootCause.description
  if (same) return cloneCard(card)
  const next = cloneCard(card)
  next.body.root_cause = { ...rootCause }
  next.updated_at = Date.now()
  appendCard(next)
  console.log(`${LOG} attribution refined:`, id, `${old.stage} -> ${rootCause.stage}`)
  return next
}

/** 重放回流（T-5 状态机）：按 R-{fp8} 前缀定位卡——candidate 跑绿→promote replay_green；
 * verified 跑绿→matched（注入有效证据）；verified 跑败→false_positive（防误伤，
 * 不自动退役；真复发由人工/统计处置）。同项目重放不增 recurrence（跨项目语义）。 */
export async function reportReplayOutcomes(
  outcomes: Array<{ id: string; passed: boolean }>,
): Promise<void> {
  if (!experienceEnabled()) return
  for (const o of outcomes) {
    const card = [...ensureIndex().values()]
      .filter((c) => c.kind === 'anti_pattern' && c.fingerprint.startsWith(o.id) && c.status !== 'retired')
      .sort((a, b) => b.updated_at - a.updated_at)[0]
    if (!card) continue
    if (card.status === 'candidate' && o.passed) {
      await promoteToVerified(card.id, 'replay_green')
    } else if (card.status === 'verified') {
      await reportInjection(card.id, o.passed ? 'matched' : 'false_positive')
    }
  }
}

/** candidate→verified 只认三种证据；retired 卡不可复活（重新观察会生成新卡）。 */
export async function promoteToVerified(id: string, verifiedBy: VerificationMethod): Promise<ExperienceCard | null> {
  const card = ensureIndex().get(id)
  if (!card || card.status === 'retired') return null
  const next = cloneCard(card)
  next.status = 'verified'
  next.verified_by = verifiedBy
  next.last_verified_at = Date.now()
  next.updated_at = next.last_verified_at
  appendCard(next)
  console.log(`${LOG} promoted card to verified:`, id, verifiedBy)
  return next
}

export async function retireCard(id: string, reason?: string): Promise<void> {
  const card = ensureIndex().get(id)
  if (!card || card.status === 'retired') return
  const next = cloneCard(card)
  next.status = 'retired'
  next.updated_at = Date.now()
  appendCard(next)
  console.log(`${LOG} retired:`, id, reason ?? '')
}

/** 用户/系统标记不正确：误报计数（排序降权用）；阈值由消费端治理，v1 不自动退役。 */
export async function markIncorrect(id: string): Promise<void> {
  await bumpStats(id, 'false_positive_count')
}

/** 消费端回报：injected 每次注入计一；matched=注入后确实规避/复用；false_positive=未触发。 */
export async function reportInjection(id: string, outcome: 'injected' | 'matched' | 'false_positive'): Promise<void> {
  await bumpStats(id, outcome === 'injected' ? 'times_injected' : outcome === 'matched' ? 'times_matched' : 'false_positive_count')
}

async function bumpStats(id: string, field: 'times_injected' | 'times_matched' | 'false_positive_count'): Promise<void> {
  const card = ensureIndex().get(id)
  if (!card) return
  const next = cloneCard(card)
  next.stats = { times_injected: 0, times_matched: 0, false_positive_count: 0, ...next.stats }
  next.stats[field] += 1
  next.updated_at = Date.now()
  appendCard(next)
}

/** 周期性治理（离线脚本/维护轮调用，不挂启动路径——避免启动写风暴）：
 * candidate 超 CANDIDATE_RETIRE_DAYS 未验证 → retire。返回处理条数。 */
export async function maintenancePass(now = Date.now()): Promise<number> {
  let changed = 0
  for (const card of [...ensureIndex().values()]) {
    if (isRetireEligibleCandidate(card, now)) {
      const next = cloneCard(card)
      next.status = 'retired'
      next.updated_at = now
      appendCard(next)
      changed++
    }
  }
  if (changed > 0) console.log(`${LOG} maintenance retired ${changed} stale candidate(s)`)
  return changed
}

// =========================================================================
// 查询（消费端统一入口）
// =========================================================================

export interface InjectionQuery {
  kind?: CardKind
  tag_prefix?: string
  stage?: string
  capability?: string
  context_hint?: string
  include_stale?: boolean
  limit?: number
  budget_chars?: number
}

function keywordOverlap(hint: string | undefined, card: ExperienceCard): number {
  if (!hint) return 0
  const bag = new Set(
    hint
      .toLowerCase()
      .split(/[^\w]+/)
      .filter((w) => w.length >= 3),
  )
  if (bag.size === 0) return 0
  const text = `${card.tag} ${JSON.stringify(card.body)}`.toLowerCase()
  let hits = 0
  for (const word of bag) if (text.includes(word)) hits++
  return hits
}

function relevanceScore(card: ExperienceCard, query: InjectionQuery, now: number): number {
  let score = 0
  if (card.status === 'verified') score += 10
  score += Math.min(card.recurrence, 5)
  if (keywordOverlap(query.context_hint, card) > 0) score += 6 + keywordOverlap(query.context_hint, card)
  if (query.tag_prefix && card.tag.startsWith(query.tag_prefix)) score += 2
  // 新鲜度：每 30 天衰减 1 分（下限 0）
  score += Math.max(0, 4 - Math.floor((now - card.created_at) / (30 * DAY_MS)))
  if (card.stats) {
    score -= Math.min(5, card.stats.false_positive_count)
    if (card.stats.times_matched > 0) score += 1
  }
  if (isStale(card, now)) score *= EXPERIENCE_GOVERNANCE.STALE_WEIGHT_MULTIPLIER
  return score
}

function matchesFilters(card: ExperienceCard, query: InjectionQuery): boolean {
  if (query.tag_prefix && !card.tag.startsWith(query.tag_prefix)) return false
  if (query.stage) {
    if (card.kind !== 'anti_pattern' || card.body.stage !== query.stage) return false
  }
  if (query.capability) {
    if (card.kind !== 'pattern' || !card.body.capability.toLowerCase().includes(query.capability.toLowerCase())) return false
  }
  return true
}

/** 消费注入查询：可过滤 kind/tag 前缀/阶段/能力；预算按整条卡截断（不腰斩）。 */
export async function selectForInjection(query: InjectionQuery): Promise<ExperienceCard[]> {
  if (!experienceEnabled()) return []
  try {
    const now = Date.now()
    const limit = query.limit ?? EXPERIENCE_GOVERNANCE.DEFAULT_INJECT_LIMIT
    const budget = query.budget_chars ?? EXPERIENCE_GOVERNANCE.DEFAULT_INJECT_BUDGET_CHARS
    const candidates = [...ensureIndex().values()]
      .filter((c) => (query.kind ? c.kind === query.kind : true))
      .filter(isConsumable)
      .filter((c) => query.include_stale || !isStale(c, now))
      .filter((c) => matchesFilters(c, query))
      .sort((a, b) => relevanceScore(b, query, now) - relevanceScore(a, query, now) || b.updated_at - a.updated_at)
    const picked: ExperienceCard[] = []
    let used = 0
    for (const card of candidates) {
      const cost = cardRenderCost(card)
      if (used + cost > budget) break // 整条取舍
      picked.push(cloneCard(card))
      used += cost
      if (picked.length >= limit) break
    }
    return picked
  } catch (error) {
    console.warn(`${LOG} select failed, empty list:`, (error as Error)?.message)
    return []
  }
}

/** 注入渲染成本估算：anti 按 symptom 长度 + 标签开销；pattern 按 summary。 */
function cardRenderCost(card: ExperienceCard): number {
  const body = card.body as { symptom?: string; implementation_summary?: string }
  const core = Math.min(400, (body.symptom ?? body.implementation_summary ?? '').length)
  return core + card.tag.length + 32
}

/** 账本压缩视图（gap-report/回灌脚本/统计用）。 */
export function readAllCards(): ExperienceCard[] {
  return [...ensureIndex().values()].map(cloneCard)
}

export { isConsumable, isStale }

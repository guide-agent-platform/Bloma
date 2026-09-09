import { createHash } from 'node:crypto'

/**
 * 经验库统一账本 —— schema 与治理常量（T-0，2026-09-07 用户拍板方案）。
 *
 * 架构决策（实施计划 §0，此处为代码内摘要）：
 * - **统一账本**：anti_pattern（错误模式卡）与 pattern（正向参考卡）写入同一
 *   JSONL（~/.proma/bloma-experience.jsonl），去重/治理/TTL/查询只实现一次；
 * - **分离消费**：anti_pattern 走指导型消费（GWT 重放断言 T-5 / 裁判清单 T-6 /
 *   learnings【历史经验】段 T-1）；pattern 走素材型消费（ref-modules 物化 +
 *   模块地图索引，Agent read_file 复用或模仿，T-7/G4）；
 * - **三态生命周期**：candidate → verified → retired；消费入池条件 =
 *   `status === 'verified' || recurrence >= RECURRENCE_THRESHOLD`（首注册即落盘
 *   不丢数据，但未达阈值不参与消费——用户计划 T-2 歧义点的裁定版）；
 * - **零新依赖**（仓库依赖极少惯例）：id 用 node:crypto randomUUID（nanoid 替身）、
 *   指纹用 sha256 前 16 hex（xxhash 替身）、文件 content_hash 同为 sha256；
 * - **红线**：账本只存「做错→怎么避」「做对→怎么复用」的模式知识，不存需求/
 *   决策/约束事实——那是 prd.json 背板的事实源，照存就是第二真相源
 *   （learnings-log / memory-distiller 头注的同款教训）。
 */

// =========================================================================
// 信封层（所有卡共有）
// =========================================================================

export type CardKind = 'anti_pattern' | 'pattern'
export type CardStatus = 'candidate' | 'verified' | 'retired'
export type VerificationMethod =
  | 'replay_green' // anti_pattern：GWT 重放测试转绿
  | 'sandbox_pass' // pattern：沙箱编译试跑通过
  | 'human_review' // 人工确认

export type CardSourceType =
  | 'gwt_failure'
  | 'build_gate_failure'
  | 'semantic_findings'
  | 'abnormal_outcome'
  | 'antidegrade_judge'
  | 'backfill'
  | 'web_reference'
  | 'user_feedback'
  | 'tools_unsupported'
  | 'timeout_interrupt'

/** 治理扩展块（Phase 4 C1，2026-09-09，P2 稿 §3 C1）：适用边界+机制假设+三层验证证据+回滚条件。全可选，旧卡零迁移（读侧经 cardGovernance() 归一化）。 */
export interface CardGovernance {
  /** 适用范围：taskTypes 缺省 ['*'] 不限；modelVersions/environmentVersions 记提取时环境供迁移验证对照 */
  scope: { taskTypes: string[]; modelVersions?: string[]; environmentVersions?: string[] }
  /** 作用机制假设：为什么有效（不是「上次成功了」）；缺省由归因腿结果/能力描述派生 */
  hypothesis: string
  /** 不适用条件（负例验证的边界声明） */
  exclusions: string[]
  /** 机制/迁移/负例三层验证报告 id（C2 晋升门槛消费；缺省 [] = 未做迁移验证，fail-closed 不升 active） */
  validationReportIds: string[]
  /** 撤销/回滚条件 */
  rollbackConditions: string[]
}

/**
 * 读侧治理归一化（C1 存量兼容）：旧卡无 governance 时按同规则派生默认值，不迁移不改写。
 * hypothesis 派生：anti_pattern → root_cause.description（归因腿结果，P2 稿口径）退 symptom；
 * pattern → capability。写入侧（error-card envelope / ref-ui-source）周同一函数产新卡默认值。
 */
export function cardGovernance(card: ExperienceCard): CardGovernance {
  if (card.governance) return card.governance
  const hypothesis =
    card.kind === 'anti_pattern'
      ? (card.body.root_cause.description || card.body.symptom || '').slice(0, 200)
      : (card.body.capability || '').slice(0, 200)
  return {
    scope: { taskTypes: ['*'] },
    hypothesis,
    exclusions: [],
    validationReportIds: [],
    rollbackConditions: [],
  }
}

export interface CardEnvelope {
  /** 唯一标识：node crypto.randomUUID()（替代 nanoid(21)，零新依赖） */
  id: string
  /** schema 版本，当前 1；未来变更递增用于迁移 */
  schema_version: number
  kind: CardKind
  /**
   * 统一分类法标签（同一 taxonomy 空间，两 kind 共享）：
   * 斜杠分隔——`{命名空间}/{领域|阶段}/{主题}`。
   * anti_pattern 例 `build_gate/typescript/type_mismatch`；pattern 例 `pattern/ts/debounce`。
   */
  tag: string
  status: CardStatus
  /** 毫秒时间戳 */
  created_at: number
  updated_at: number
  /** 最后一次验证通过时间（仅 verified 有值） */
  last_verified_at?: number
  verified_by?: VerificationMethod
  /** 相同 fingerprint 跨项目复发计数 */
  recurrence: number
  source: {
    type: CardSourceType
    /** 项目标识脱敏 hash（hashProjectRef 产出，12 hex） */
    project_hash: string
    /** 相关文件路径（sanitize 后通常只剩 {path}/basename） */
    file?: string
    line?: number
    timestamp: number
    session_id?: string
  }
  /** 语义指纹：sha256(normalize(stage|symptom 或 capability|api_signature)) 前 16 hex */
  fingerprint: string
  /**
   * 已观察到的脱敏项目集（recurrence 语义的单一事实源：**跨项目**才计数，
   * 同项目重观测不重复 +1；也保证离线回灌重跑幂等）。可选字段，向后兼容旧行。
   */
  seen_projects?: string[]
  /** 消费统计（消费端回报填充） */
  stats?: {
    times_injected: number
    times_matched: number
    false_positive_count: number
  }
  /** 治理扩展（C1，可选——旧卡缺失时读侧 cardGovernance() 归一化） */
  governance?: CardGovernance
}

// =========================================================================
// anti_pattern 内容层
// =========================================================================

export type ErrorStage =
  | 'prd'
  | 'clarify'
  | 'plan_leg'
  | 'build_gate'
  | 'coding'
  | 'channel'
  | 'unknown'

export interface AntiPatternBody {
  /** 错误发生的（表面）阶段；归因后的根因阶段在 root_cause.stage */
  stage: ErrorStage
  /** 一句话症状。例 "TypeScript build fails with TS2345: argument type mismatch" */
  symptom: string
  /** 触发条件。例 "When passing a string where a number is expected in a typed function" */
  trigger_condition: string
  /** 归因结果（T-4 精化；采集层初值 = 表面阶段 + rule/1） */
  root_cause: {
    stage: string
    description: string
    method: 'rule' | 'llm'
    /** 0~1；rule 归因可为 1，llm 归因上限 LLM_ATTRIBUTION_MAX_CONFIDENCE */
    confidence: number
    possible_stages?: { stage: string; confidence: number; rule?: string }[]
    reasoning?: string
  }
  /** 可选 GWT 场景（重放验证用，T-5 可填充） */
  gwt?: { given: string; when: string; then: string }
  /** 测试检查清单：验证时应检查什么 */
  test_checklist: string[]
  /** 审查检查清单：审查时应关注什么 */
  review_checklist: string[]
  /** 1=轻微 2=中等 3=严重 */
  severity: 1 | 2 | 3
}

// =========================================================================
// pattern 内容层
// =========================================================================

export type LicenseTier = 'permissive' | 'weak_copyleft' | 'strong_copyleft' | 'unknown'

export interface PatternBody {
  /** 解决什么问题。例 "Debounce a function call to limit execution rate" */
  capability: string
  language_family: 'ts' | 'js' | 'py' | 'universal'
  framework_constraint?: string
  /** 最小可用接口签名 */
  api_signature: string
  /** 模式级描述（不是代码）*/
  implementation_summary: string
  /** 物化文件列表（相对 ref-modules/{slug}/）*/
  files: { relative_path: string; content_hash: string }[]
  /** SPDX 标识符或 "unknown" */
  license: string
  license_tier: LicenseTier
  source_url?: string
  sandbox_result: {
    build_pass: boolean
    /** v1 沙箱缺省只做编译验证（build-gate），smoke 在 SANDBOX_SMOKE 旗后——未跑即 undefined */
    smoke_test_pass?: boolean
    executed_at: number
  }
  /** 告诉 Agent 怎么复用/模仿 */
  reuse_hint: string
}

// =========================================================================
// 完整卡（可辨识联合）
// =========================================================================

export type ExperienceCard =
  | (CardEnvelope & { kind: 'anti_pattern'; body: AntiPatternBody })
  | (CardEnvelope & { kind: 'pattern'; body: PatternBody })

// =========================================================================
// 治理常量（全局唯一定义处，消费端一律引用）
// =========================================================================

export const EXPERIENCE_GOVERNANCE = {
  /** 账本 schema 版本 */
  SCHEMA_VERSION: 1,
  /** 同 fingerprint 短时窗内重复注册直接折叠（防同一轮多写点连击） */
  DEDUP_WINDOW_MS: 10 * 60 * 1000,
  /** candidate 超此天数未验证 → 视为 deferred（语义标记，不加第四状态；仍可手动转正） */
  CANDIDATE_DEFER_DAYS: 30,
  /** candidate 超此天数未验证 → 自动退役 */
  CANDIDATE_RETIRE_DAYS: 60,
  /** verified 卡超此天数未再验证 → stale（默认不注入，include_stale 可放宽；权重×0.5） */
  VERIFIED_TTL_DAYS: 90,
  /** stale 卡权重乘子 */
  STALE_WEIGHT_MULTIPLIER: 0.5,
  /** 跨项目复发 ≥ 此值才有消费入池资格（verified 之外） */
  RECURRENCE_THRESHOLD: 2,
  /** LLM 归因置信度上限（规则归因不受限） */
  LLM_ATTRIBUTION_MAX_CONFIDENCE: 0.5,
  /** 沙箱超时 */
  SANDBOX_TIMEOUT_MS: 30_000,
  /** 归因输入：loop-log 最多行数 */
  MAX_LOOP_LOG_LINES_FOR_ATTRIBUTION: 300,
  /** 归因输入：背板最多字符 */
  MAX_BACKPLATE_CHARS_FOR_ATTRIBUTION: 2000,
  /** 注入默认预算 */
  DEFAULT_INJECT_BUDGET_CHARS: 2000,
  /** 注入默认条数 */
  DEFAULT_INJECT_LIMIT: 5,
  /** 单条自由文本脱敏后长度上限 */
  SANITIZE_TEXT_LIMIT: 500,
} as const

const DAY_MS = 86_400_000

// =========================================================================
// 开关（口径对齐 BLOMA_MODULES / P3 三开关家族：缺省 off 灰度）
// =========================================================================

/** 经验库总开关：`BLOMA_EXPERIENCE=1|on|true` 启用；缺省 off = 现状字节级。 */
export function experienceEnabled(): boolean {
  const raw = process.env.BLOMA_EXPERIENCE
  if (!raw) return false
  const v = raw.trim().toLowerCase()
  return v === '1' || v === 'on' || v === 'true'
}

// =========================================================================
// 脱敏（写盘前必经；单字段失败降级为截断，绝不整卡抛错）
// =========================================================================

const HOME_PATH_RE = /(?:[A-Za-z]:[\\/])?(?:Users|home)[\\/][^\s"'`]+/gi
const URL_CREDS_RE = /\/\/[^\s/@#]+@/g
const QUERY_TOKEN_RE = /([?&](?:token|key|api_key|apikey|secret|password)=)[^&#\s'"]+/gi
const KV_SECRET_RE = /\b(api_key|apikey|secret|password|token)\b(\s*[:=]\s*)(["'`]?)[^\s"',;`]+/gi

/** 自由文本脱敏：家目录路径/URL 凭证/query token/键值 secret/超长截断。 */
export function sanitizeText(text: string): string {
  let out = text ?? ''
  try {
    out = out.replace(HOME_PATH_RE, (m) => {
      const segs = m.split(/[\\/]+/).filter(Boolean)
      const base = segs[segs.length - 1] ?? ''
      return `{path}/${base}`
    })
    out = out.replace(URL_CREDS_RE, '//{user}@')
    out = out.replace(QUERY_TOKEN_RE, '$1{redacted}')
    out = out.replace(KV_SECRET_RE, (_all, key: string, sep: string, q: string) => `${key}${sep}${q}{redacted}`)
  } catch {
    // 正则面外的脏文本：降级为直接截断，不整卡失败
  }
  if (out.length > EXPERIENCE_GOVERNANCE.SANITIZE_TEXT_LIMIT) {
    out = `${out.slice(0, EXPERIENCE_GOVERNANCE.SANITIZE_TEXT_LIMIT)}...`
  }
  return out
}

/** 深脱敏整卡：只处理自由文本字段，结构性字段（id/时间戳/枚举）原样。 */
export function sanitizeCard<C extends ExperienceCard>(card: C): C {
  const s = sanitizeText
  const out = JSON.parse(JSON.stringify(card)) as ExperienceCard
  out.source.file = out.source.file ? s(out.source.file) : out.source.file
  const body = out.body as unknown as Record<string, unknown>
  if (out.kind === 'anti_pattern') {
    body.symptom = s(String(body.symptom ?? ''))
    body.trigger_condition = s(String(body.trigger_condition ?? ''))
    const rc = (body.root_cause ?? {}) as Record<string, unknown>
    rc.description = s(String(rc.description ?? ''))
    if (typeof rc.reasoning === 'string') rc.reasoning = s(rc.reasoning)
    body.test_checklist = Array.isArray(body.test_checklist) ? (body.test_checklist as unknown[]).map((x) => s(String(x))) : []
    body.review_checklist = Array.isArray(body.review_checklist) ? (body.review_checklist as unknown[]).map((x) => s(String(x))) : []
  } else {
    body.capability = s(String(body.capability ?? ''))
    body.implementation_summary = s(String(body.implementation_summary ?? ''))
    body.reuse_hint = s(String(body.reuse_hint ?? ''))
    if (typeof out.source.session_id === 'string') out.source.session_id = s(out.source.session_id)
  }
  return out as C
}

// =========================================================================
// 归一化与指纹
// =========================================================================

/** 指纹归一：小写、去标点（保留字母/数字含 CJK 与空白）、空白折叠。 */
export function normalizeForFingerprint(text: string): string {
  return (text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

/** 语义指纹（sha256 前 16 hex，xxhash 零依赖替身）。 */
export function computeFingerprint(kind: CardKind, body: AntiPatternBody | PatternBody): string {
  let raw: string
  if (kind === 'anti_pattern') {
    const b = body as AntiPatternBody
    raw = `${b.stage}|${b.symptom}`
  } else {
    const b = body as PatternBody
    raw = `${b.capability}|${b.api_signature}`
  }
  return createHash('sha256').update(normalizeForFingerprint(raw), 'utf8').digest('hex').slice(0, 16)
}

// =========================================================================
// 时效与标识
// =========================================================================

/** verified 卡超 TTL 未再验证 → stale；candidate/retired 不判。 */
export function isStale(card: CardEnvelope, nowMs = Date.now()): boolean {
  if (card.status !== 'verified') return false
  if (typeof card.last_verified_at !== 'number') return false
  return nowMs - card.last_verified_at > EXPERIENCE_GOVERNANCE.VERIFIED_TTL_DAYS * DAY_MS
}

/**
 * SPDX → 复用分级（G2 入册与 G4 物化的单一事实源，防两处政策漂移）：
 * permissive 可携码物化；weak_copyleft/unknown 只存模式描述不物化代码；
 * strong_copyleft 拒绝入册（教学项目版权红线，用户 2026-09-07 拍板）。
 */
export function licenseTierOf(spdx: string | undefined | null): LicenseTier {
  const id = (spdx ?? '').trim()
  if (!id || id.toLowerCase() === 'unknown') return 'unknown'
  const permissive = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|ISC|0BSD|Unlicense|CC0-1\.0)$/i
  const weak = /^(LGPL-2\.1|LGPL-3\.0|MPL-2\.0)$/i
  const strong = /^(GPL-2\.0|GPL-3\.0|AGPL-3\.0|GPLv2|GPLv3)$/i
  if (permissive.test(id)) return 'permissive'
  if (weak.test(id)) return 'weak_copyleft'
  if (strong.test(id)) return 'strong_copyleft'
  return 'unknown'
}

/** candidate 超 CANDIDATE_RETIRE_DAYS 未转正 → 可自动退役（T-2 清理动作使用）。 */
export function isRetireEligibleCandidate(card: CardEnvelope, nowMs = Date.now()): boolean {
  if (card.status !== 'candidate') return false
  return nowMs - card.created_at > EXPERIENCE_GOVERNANCE.CANDIDATE_RETIRE_DAYS * DAY_MS
}

/** 项目标识脱敏：12 hex，不可反推。 */
export function hashProjectRef(projectId: string): string {
  return createHash('sha256').update(`bloma-project:${projectId}`, 'utf8').digest('hex').slice(0, 12)
}

/** 确定性 tag 关键词：小写后取前两个 ≥3 字母且非纯数字的词，snake_case；无命中回 misc。
 * （定义在 types 层供采集器与离线回灌脚本共用同一 bundle，防两处实现漂移） */
export function keyFromSymptom(text: string): string {
  const words = (text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => Array.from(w).length >= 3 && !/^\d+$/.test(w))
  const picked = words.slice(0, 2)
  return picked.length > 0 ? picked.join('_') : 'misc'
}

/** 消费入池资格：verified 恒可；candidate 需达复发阈值（首注册即落盘不丢数据）。 */
export function isConsumable(card: CardEnvelope): boolean {
  if (card.status === 'retired') return false
  if (card.status === 'verified') return true
  return card.recurrence >= EXPERIENCE_GOVERNANCE.RECURRENCE_THRESHOLD
}

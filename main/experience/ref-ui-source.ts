import { EXPERIENCE_GOVERNANCE, computeFingerprint, hashProjectRef, sanitizeCard } from './types'
import { registerCandidateCard } from './experience-service'

/**
 * G3a 市调 UI 模式入册（「做产品=做 UI」的定向收割，用户 2026-09-07 裁定）：
 * 向导市调的优质想法（label/note/source）→ **UI 类 pattern 描述卡（永不含码）**。
 *
 * - 命名空间与批跑侧互斥防撞：`pattern/ui/{slug}_{hash4}`（G2 只产 js/py/ts/universal，
 *   G3a 只占 ui 段）；哈希后缀防跨需求同题混淆；
 * - 恒 candidate：市调 snippet 未经编译/沙箱出证，晋升只走 human_review
 *   （用户在需求确认里勾选采纳 = 人工背书的入口，v2 接线；G4 消费端只吃
 *   verified+build_pass，故本通道卡入册后不污染物化，纯账本积累）；
 * - 与 G2 的 web_reference 区分：source.type='user_feedback'（用户渠道语义），
 *   不冒充批跑出证；
 * - 开关同族：BLOMA_EXPERIENCE=1 才写（off 零副作用，C-2 纪律）；fire-and-forget。
 */

export interface UIModeIdea {
  label: string
  note?: string
  source?: string
}

function slugifyLabel(label: string): string {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28)
  return ascii || 'mode'
}

function shortHash(text: string): string {
  return computeFingerprint('anti_pattern', { stage: 'unknown', symptom: text } as never).slice(0, 4)
}

/** 一条想法 → UI 描述卡经统一闸门入册；返回 card id。失败静默 null。 */
export async function registerUiModeCard(input: {
  idea: UIModeIdea
  demand: string
  projectId: string
  sessionId?: string
}): Promise<string | null> {
  try {
    const label = String(input.idea?.label ?? '').trim()
    if (!label) return null
    const key = `${label}|${String(input.idea.note ?? '').trim()}|${String(input.idea.source ?? '').trim()}`
    const slug = `${slugifyLabel(label)}_${shortHash(key)}`
    const body = {
      capability: `UI 做法：${label}`,
      language_family: 'universal' as const,
      framework_constraint: 'ui-pattern',
      api_signature: '',
      implementation_summary: String(input.idea.note ?? '').slice(0, 200),
      files: [],
      license: 'unknown',
      license_tier: 'unknown' as const,
      source_url: input.idea.source,
      sandbox_result: { build_pass: false, executed_at: 0 },
      reuse_hint: `源自向导市调，用户需求「${String(input.demand ?? '').slice(0, 60)}」的市面参照`,
    }
    const now = Date.now()
    const card = sanitizeCard({
      id: globalThis.crypto?.randomUUID?.() ?? `ui-${now}-${Math.random().toString(36).slice(2)}`,
      schema_version: EXPERIENCE_GOVERNANCE.SCHEMA_VERSION,
      kind: 'pattern' as const,
      tag: `pattern/ui/${slug}`,
      status: 'candidate' as const,
      created_at: now,
      updated_at: now,
      recurrence: 1,
      source: {
        type: 'user_feedback' as const,
        project_hash: hashProjectRef(input.projectId),
        timestamp: now,
        session_id: input.sessionId,
      },
      fingerprint: computeFingerprint('pattern', body),
      body,
      seen_projects: [hashProjectRef(input.projectId)],
    })
    const registered = await registerCandidateCard(card)
    return registered?.id ?? null
  } catch (error) {
    console.warn('[experience] ui mode card failed:', (error as Error)?.message)
    return null
  }
}

/**
 * 需求确认弹窗发 idea 的同时把全部想法投喂入册（candidate，不阻塞 UI）。
 * 返回入册条数（决策日志用）。开关 off → 0 且零副作用。
 */
export async function ingestResearchIdeasAsCandidates(input: {
  ideas: UIModeIdea[]
  demand: string
  projectId: string
  sessionId?: string
}): Promise<number> {
  try {
    if (!process.env.BLOMA_EXPERIENCE || !['1', 'on', 'true'].includes(process.env.BLOMA_EXPERIENCE.trim().toLowerCase())) return 0
    let count = 0
    for (const idea of input.ideas.slice(0, 5)) {
      if ((await registerUiModeCard({ ...input, idea })) !== null) count++
    }
    if (count > 0) console.log(`[experience] ui mode cards registered: ${count}`)
    return count
  } catch (error) {
    console.warn('[experience] ui mode ingest failed:', (error as Error)?.message)
    return 0
  }
}

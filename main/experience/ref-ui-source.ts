import { EXPERIENCE_GOVERNANCE, computeFingerprint, hashProjectRef, sanitizeCard } from './types'
import { registerCandidateCard } from './experience-service'

/**
 * G3a 市调 UI 模式入册（「做产品=做 UI」的定向收割，用户 2026-09-07 裁定）：
 * 向导市调的优质想法（label/note/source）→ **UI 类 pattern 描述卡（永不含码）**。
 *
 * 【G3b 冻结占位（2026-09-07 用户清单第 5 步裁定）】extractor IPC 四层链接线 +
 * UI 展示参考卡——保留产品功能定位（本模块供给链的展示端），暂不接线；
 * 若未来确认产品不向用户展示参考卡再出移除补丁。本卡侧（G3a）已可用，不受影响。
 *
 * - 命名空间与批跑侧互斥防撞：`pattern/ui/{slug}_{hash4}`（G2 只产 js/py/ts/universal，
 *   G3a 只占 ui 段）；哈希后缀防跨需求同题混淆；
 * - 恒 candidate：市调 snippet 未经编译/沙箱出证，晋升只走 human_review
 *   （用户在需求确认里勾选采纳 = 人工背书的入口，v2 接线；G4 消费端只吃
 *   verified+build_pass，故本通道卡入册后不污染物化，纯账本积累）；
 * - 与 G2 的 web_reference 区分：source.type='user_feedback'（用户渠道语义），
 *   不冒充批跑出证；
 * - 恒写入（2026-10-01 开关收敛第二刀 EXPERIENCE 转正删除）；fire-and-forget。
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

// ---------------------------------------------------------------------------
// P2b（2026-09-11 狗粮 94f449c6 污染复盘）：词典/百科类结果不入册 UI 模式卡。
// 当晚项目名「纵版雷霆战机」首字被市调搜出百度百科/新华字典词条，4 张
// 「UI 做法：纵（汉语文字）_百度百科」垃圾 candidate 卡入账——市调搜索把项目名
// 词汇当查询词命中词典页，入册侧必须自行判断拒收（上游搜索词清洗另行挂账）。
// ---------------------------------------------------------------------------

/** 标题尾缀的百科后缀（搜索结果页标题常规形态：主题_百度百科）。 */
const ENCYCLOPEDIA_SUFFIX_RE = /_(百度百科|维基百科|搜狗百科|快百科|头条百科|萌娘百科)$/i
/** 括注里的词典学美名（「纵（汉语文字）」形态）。 */
const DICTIONARY_PAREN_RE = /[（(](汉语文字|汉字|词语|多音字|方言|姓氏|汉字词组|汉语词汇)[）)]/
/** 词典/百科域名（source 命中即拒收；狗粮 94f449c6 实测形态全量登记）。 */
const DICTIONARY_DOMAINS = [
  'baike.baidu.com',
  'zh.wikipedia.org',
  'baike.sogou.com',
  'dict.baidu.com',
  'zidian.gushiwen.cn',
  'zidian.gushici.net',
  'www.guoxuedashi.net',
  'xh.5156edu.com',
  'cd.hwxnet.com',
  'zdic.net',
  'hanyuguoxue.com',
]
/** 通用词典站域名模式（zidian./cidian./baike. 前缀站，防清单追不全）。 */
const DICTIONARY_DOMAIN_RE = /(^|\.)(zidian|cidian|baike|guoxue)\./i
/** 标题里的词典学内容标记（「纵怎么读_纵的拼音 - 新华字典」形态，域名缺失时兑底）。 */
const DICTIONARY_CONTENT_RE = /(怎么读|新华字典|汉语词典|汉典|康熙字典|说文解字|多音字)|拼音.{0,8}部首|部首.{0,8}拼音/

/** 词典/百科类「UI 想法」识别：真 UI 模式卡不会以单字为名、不会引词典释义。 */
export function looksLikeDictionaryJunk(idea: { label: string; note?: string; source?: string }): boolean {
  const label = String(idea.label ?? '').trim()
  const source = String(idea.source ?? '')
  if (!label) return true
  if (ENCYCLOPEDIA_SUFFIX_RE.test(label)) return true
  if (DICTIONARY_PAREN_RE.test(label)) return true
  const lowerSource = source.toLowerCase()
  if (DICTIONARY_DOMAINS.some((domain) => lowerSource.includes(domain))) return true
  if (DICTIONARY_DOMAIN_RE.test(lowerSource)) return true
  if (DICTIONARY_CONTENT_RE.test(label)) return true
  // 剥掉括注/分隔符后只剩单个汉字的「模式名」不可能承载 UI 做法（「纵」字案形态）；
  // 保留两字词（如「抽奖」）不误杀
  const stripped = label.replace(/[（(][^）)]*[）)]/g, '').replace(/[_\-|/·、，,。:：]+/g, '').trim()
  if (/^[\u4e00-\u9fff]$/.test(stripped)) return true
  return false
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
    // P2b：词典/百科垃圾拒收（狗粮 94f449c6「纵」字案）——不入账不计数
    if (looksLikeDictionaryJunk(input.idea)) {
      console.warn(`[experience] ui mode card rejected (dictionary junk): ${label.slice(0, 40)}`)
      return null
    }
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
 * 返回入册条数（决策日志用）。
 */
export async function ingestResearchIdeasAsCandidates(input: {
  ideas: UIModeIdea[]
  demand: string
  projectId: string
  sessionId?: string
}): Promise<number> {
  try {
    let count = 0
    for (const idea of input.ideas.slice(0, 5)) {
      // P2b：入册前过滤（与 registerUiModeCard 双保险——批量入口也能统计到干净条数）
      if (looksLikeDictionaryJunk(idea)) continue
      if ((await registerUiModeCard({ ...input, idea })) !== null) count++
    }
    if (count > 0) console.log(`[experience] ui mode cards registered: ${count}`)
    return count
  } catch (error) {
    console.warn('[experience] ui mode ingest failed:', (error as Error)?.message)
    return 0
  }
}

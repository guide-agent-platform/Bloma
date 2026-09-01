import type { SDKQuery } from './orchestrator'
import {
  hasForbiddenResponse,
  isCompoundTrigger,
  parseEarsAssertion,
  renderForbiddenTermsForPrompt,
  renderResponseVocabularyForPrompt,
  renderTriggerVocabularyForPrompt,
} from './ears-vocabulary'
import type { SketchRequirement } from './sketch-engine'
import { requirementPriority } from './sketch-engine'
import { categoryTemperature } from './model-resolution'
import type { MessageContentBlock } from '../shared/types'

/**
 * RequirementEarsifier — P0 行为断言 EARS 化改写（2026-09-02 周计划 §5 P3，方案 §4.3）。
 *
 * quick 的唯一新增 LLM 步骤：PRD 用户确认后、草图前，把 P0 项的 behavior_assertions
 * 句式升级为 EARS（WHEN/WHILE/IF 前缀 + 保留「触发→效果」中轴），提升 GWT 可派生率
 * 与探针覆盖率（§7 实验指标）。语义不变、只改措辞形态——「触发→效果」中轴与
 * parseBehaviorAssertion 兼容链由 ears-vocabulary 测试锁定（第四处口径）。
 *
 * 三层守卫（复用 requirement-enricher 模式，方案纪律；失败回退原 assertions 不阻塞）：
 * - ①格式守卫：EARS 良构（中轴两侧非空）+ 单 trigger 纪律（无复合连接）+ 禁词表未命中；
 * - ②语义保持守卫（反幻觉核心，对应 enricher 接地守卫）：改写不是编新——改写产物
 *   与原断言的 2-gram 重叠率 ≥ SEMANTIC_OVERLAP_MIN，杜绝借改写夹带新功能实体；
 * - ③数量守卫：每项改写后断言数 ≤ 原数 + 1（不许借改写扩容）；只动
 *   behavior_assertions，description/story/priority/id 原样保留（F-001 锚点不变式）。
 *
 * 词表三处同源（陷阱 22 前置规避）：prompt 中的 trigger/response/禁词清单由
 * ears-vocabulary 渲染函数产出——与 GWT 派生、judge 校验 import 同一常量。
 */

export interface EarsifyInput {
  project_id: string
  session_id: string
  /** 全量冻结功能项（内部只挑 P0 项处理；非 P0 原样返回） */
  requirements: SketchRequirement[]
  query: SDKQuery
  env: Record<string, string>
  signal?: AbortSignal
  /** 渠道能力上限；缺省 2048（改写输出小，无需线性扩容） */
  maxTokens?: number
}

export interface EarsifyStats {
  /** 通过全守卫、实际替换的断言条数 */
  earsified: number
  /** ①格式/②语义/③数量守卫丢弃的断言条数 */
  dropped: number
  /** 参与改写的 P0 项数 */
  p0Items: number
}

export interface EarsifyResult {
  /** P0 项断言被 EARS 化替换后的全量清单；失败回退时 === 输入 */
  requirements: SketchRequirement[]
  stats: EarsifyStats
}

const DEFAULT_MAX_TOKENS = 2048
/** 生成尝试次数上限（对齐 enricher 的 MAX_GENERATION_ATTEMPTS=2：首试+一次反馈重试）。 */
const MAX_ATTEMPTS = 2
/** ②语义保持阈值：双度量任一达标（字符集重合对重排宽容、对换内容敏感，实测区分度 0.5+ vs 0.25-）。 */
const SEMANTIC_OVERLAP_MIN = 0.5
/** ③数量守卫：改写后断言数上限 = 原数 + 1。 */
const MAX_ASSERTIONS_DELTA = 1

export const EARSIFY_SYSTEM_PROMPT = `你是「Bloma 需求断言改写师」。把已冻结的行为断言改写成 EARS 结构化句式——只改句式形态，不改语义内容。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输出结构：
{"requirements":[{"id":"F-001","behavior_assertions":["WHEN <触发> → <效果>"]}]}

改写规则：
- 三种句式按语义选择：事件动作用 WHEN；持续状态/空态用 WHILE（如「列表为空时」）；异常/非法输入用 IF。
- 目标形态保留「→」中轴：左触发右效果。WHEN 例：「WHEN 点击保存按钮 → 列表新增一条记录」。
- 触发段只许一个动作，禁止「和/或/并且/然后」复合（需要两个动作=拆成两条断言）。
- 触发动词从词表选用：${renderTriggerVocabularyForPrompt()}
- 效果措辞落到可断言终态，从词表选用：${renderResponseVocabularyForPrompt()}
- 禁止不可测措辞：${renderForbiddenTermsForPrompt()}（命中即无效）。
- 只改措辞形态，不得增删语义内容：原断言说「保存后列表多一条」不得改成「保存后跳转首页」。
- description/story 不可改写；requirements 与输入 P0 项一一对应（同 id 同数量），不得新增/删除/改名。

【示例】
输入：F-001: 番茄钟（断言：点击开始后计时启动；计时中点暂停会停下）
输出：{"requirements":[{"id":"F-001","behavior_assertions":["WHEN 点击开始按钮 → 计时启动","WHEN 点击暂停按钮 → 计时停止"]}]}

只输出 JSON。`

/** 格式错误恢复重试反馈（不修补内容，只要求重输出合法 JSON）。 */
const RETRY_FEEDBACK = '你上一次的输出无法解析为有效 JSON。请重新只输出一个 JSON 对象（{"requirements":[{"id":"F-001","behavior_assertions":["WHEN 触发 → 效果"]}]}），确保括号引号完整闭合，requirements 与输入一一对应。'

/** ②语义保持：双度量重叠率 = max(字符集重合, 2-gram 重合)。
 * 中文短断言改写措辞重排天然降低 2-gram 重叠，单度量误杀（实测「计时中点暂停会停下」→
 * 「WHEN 点击暂停按钮 → 计时停止」仅 0.25）；字符集重合对重排宽容、对换内容仍敏感
 * （实测夹带新功能例 0.125）。任一度量达标即过，阈值 SEMANTIC_OVERLAP_MIN。 */
export function semanticOverlap(original: string, rewritten: string): number {
  const a1 = charSet(normalizeForOverlap(original))
  const b1 = charSet(normalizeForOverlap(rewritten))
  const charScore = a1.size === 0 ? 0 : [...a1].filter((ch) => b1.has(ch)).length / a1.size
  const a2 = bigrams(normalizeForOverlap(original))
  const b2 = bigrams(normalizeForOverlap(rewritten))
  let gramHit = 0
  for (const gram of a2) if (b2.has(gram)) gramHit += 1
  const gramScore = a2.size === 0 ? 0 : gramHit / a2.size
  return Math.max(charScore, gramScore)
}

function normalizeForOverlap(text: string): string {
  return text.replace(/[\s\p{P}+=→]/gu, '').replace(/^(?:WHEN|WHILE|IF|当|如果|处于)/i, '')
}

function charSet(text: string): Set<string> {
  return new Set(text.split(''))
}

function bigrams(text: string): Set<string> {
  const grams = new Set<string>()
  for (let i = 0; i < text.length - 1; i += 1) grams.add(text.slice(i, i + 2))
  return grams
}

/**
 * EARS 化主入口：LLM 改写 P0 断言 + 三层守卫过滤。
 * 任何失败（无 query/env、LLM 异常、解析失败、守卫全灭）→ 原样返回输入（不阻塞主线）。
 */
export async function earsifyRequirements(input: EarsifyInput): Promise<EarsifyResult> {
  const stats: EarsifyStats = { earsified: 0, dropped: 0, p0Items: 0 }
  const p0Items = input.requirements.filter((item) => requirementPriority(item) === 'P0')
  stats.p0Items = p0Items.length
  // 幂等短路：无 P0 项、query/env 缺失（空对象同样视为不可用），或全部 P0 断言已良构 EARS → 不发请求
  const rewritable = p0Items.filter((item) => !assertionsAllEarsWellFormed(item))
  if (rewritable.length === 0 || !input.query || !input.env || Object.keys(input.env).length === 0) {
    return { requirements: input.requirements, stats }
  }

  try {
    const raw = await runLlm(input, rewritable)
    if (input.signal?.aborted) return { requirements: input.requirements, stats }
    const parsed = parseRewrite(raw)
    if (!parsed) return { requirements: input.requirements, stats }
    return mergeRewrite(input.requirements, parsed, stats)
  } catch {
    return { requirements: input.requirements, stats }
  }
}

/** 全部断言已良构 EARS（无需改写）的判定：幂等短路，避免重复确认浪费请求。
 * 「已 EARS 化」要求**显式前缀**（WHEN/WHILE/IF）——无前缀的存量「触发→效果」
 * 断言虽兼容解析为 when，但缺少句式区分度（WHILE→Given/IF→异常映射不可用），
 * 仍需改写（中轴家族「后/时」会让存量断言 wellFormed=true，不能只看良构）。 */
function assertionsAllEarsWellFormed(item: SketchRequirement): boolean {
  const assertions = (item.behavior_assertions ?? []).filter((value) => value.trim().length > 0)
  if (assertions.length === 0) return false
  return assertions.every((value) => {
    const ears = parseEarsAssertion(value)
    return ears.explicitPrefix && ears.wellFormed && !ears.compoundTrigger && !ears.forbiddenResponse
  })
}

async function runLlm(input: EarsifyInput, items: SketchRequirement[]): Promise<string> {
  const prompt = buildPrompt(items)
  let lastAccumulated = ''
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const history =
      attempt === 0
        ? [{ role: 'system' as const, content: EARSIFY_SYSTEM_PROMPT }]
        : [
            { role: 'system' as const, content: EARSIFY_SYSTEM_PROMPT },
            { role: 'user' as const, content: prompt },
            { role: 'assistant' as const, content: lastAccumulated },
          ]
    const stream = input.query(attempt === 0 ? prompt : RETRY_FEEDBACK, {
      env: input.env,
      signal: input.signal ?? new AbortController().signal,
      sessionId: input.session_id,
      history,
      maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      // 判定/提取类要稳、可复现（与 enricher 同温度口径）
      temperature: categoryTemperature('prd'),
    })
    let accumulated = ''
    for await (const sdkMessage of stream) {
      if (sdkMessage.type !== 'assistant' || !sdkMessage.message) continue
      const text = extractText(sdkMessage.message.content)
      if (text) accumulated += text
    }
    const parsed = parseRewrite(accumulated)
    if (parsed) return accumulated
    lastAccumulated = accumulated
  }
  throw new Error('EARSIFY_PARSE_FAILED')
}

function buildPrompt(items: SketchRequirement[]): string {
  const list = items
    .map((item) => {
      const assertions = (item.behavior_assertions ?? []).join('；') || '（无既有断言，按 description 派生一条）'
      return `- ${item.id}: ${item.description}\n  既有断言：${assertions}`
    })
    .join('\n')
  return [`请把下面 P0 功能项的行为断言改写为 EARS 句式（只改措辞形态，不改语义）：`, ``, list].join('\n')
}

interface RewrittenItem {
  id: string
  behavior_assertions: string[]
}

function parseRewrite(text: string): RewrittenItem[] | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  if (!Array.isArray(parsed.requirements)) return null
  const items = parsed.requirements
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .filter((item) => typeof item.id === 'string' && item.id.trim().length > 0)
    .map((item) => ({
      id: (item.id as string).trim(),
      behavior_assertions: Array.isArray(item.behavior_assertions)
        ? item.behavior_assertions.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        : [],
    }))
    .filter((item) => item.behavior_assertions.length > 0)
  return items.length > 0 ? items : null
}

/**
 * 合并改写结果（三层守卫在此执行）：
 * - 只按 id 匹配 P0 项；非 P0 项与未匹配项原样返回；
 * - ①每条断言 EARS 良构 + 非 compound + 无禁词；②与原断言语义重叠达标
 *   （新断言须与**任一**原断言重叠达标——改写是逐条对应而非保序）；
 * - ③改写后断言数 ≤ 原数 + 1；守卫后 0 条存活 → 该项保留原断言（不写空）。
 */
export function mergeRewrite(
  frozen: SketchRequirement[],
  rewritten: RewrittenItem[],
  stats: EarsifyStats,
): EarsifyResult {
  const byId = new Map(rewritten.map((item) => [item.id, item]))
  const requirements = frozen.map((item) => {
    if (requirementPriority(item) !== 'P0') return item
    const candidate = byId.get(item.id)
    if (!candidate) return item
    const originals = (item.behavior_assertions ?? []).filter((value) => value.trim().length > 0)
    // ③数量守卫：超容断言截断（超出部分计 dropped）
    let candidates = candidate.behavior_assertions
    if (candidates.length > originals.length + MAX_ASSERTIONS_DELTA) {
      stats.dropped += candidates.length - (originals.length + MAX_ASSERTIONS_DELTA)
      candidates = candidates.slice(0, originals.length + MAX_ASSERTIONS_DELTA)
    }
    const survived: string[] = []
    for (const assertion of candidates) {
      const ears = parseEarsAssertion(assertion)
      // ①格式守卫：显式前缀（目标形态）+ 良构 + 单 trigger + 无禁词
      if (!ears.explicitPrefix || !ears.wellFormed || ears.compoundTrigger || ears.forbiddenResponse) {
        stats.dropped += 1
        continue
      }
      // ②语义保持守卫：与任一原断言重叠达标（原断言为空 = enricher 未跑过，此时
      // 无「改写」基准——语义锚退化为该项 description 的重叠，防完全脱缰编造）
      const anchorOk =
        originals.length > 0
          ? originals.some((original) => semanticOverlap(original, assertion) >= SEMANTIC_OVERLAP_MIN)
          : semanticOverlap(item.description, assertion) >= SEMANTIC_OVERLAP_MIN * 0.75
      if (!anchorOk) {
        stats.dropped += 1
        continue
      }
      survived.push(assertion.trim())
    }
    // 全灭 → 保留原断言（缺省兜底语义：不写入空数组）
    if (survived.length === 0) return item
    stats.earsified += survived.length
    return { ...item, behavior_assertions: survived }
  })
  return { requirements, stats }
}

function extractText(blocks: MessageContentBlock[]): string {
  return blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
}

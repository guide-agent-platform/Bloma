import type { SDKQuery } from '../orchestration/orchestrator'
import { loadPromptOverride } from '../agent/prompting/prompt-config'
import type { SketchRequirement } from "../model/prd-backplane";
import { isPlaceholderAssertion } from "../model/prd-backplane";
import { parseBehaviorAssertion } from '../verification/behavior-assertions'
import { categoryTemperature } from '../platform/llm/model-resolution'
import { readConversation } from './prd-engine-llm'
import { callLlmForJson } from '../kernel/llm-call'
import { sanitizeClarificationRequests, type EnrichmentClarificationRequest } from './clarification'

/**
 * RequirementEnricher — 功能项加厚（2026-08-18 设计「功能项加厚：行为断言 LLM 提取」）。
 *
 * 澄清阶段产出的功能项只有薄形态（`{id, description}`，`guide-agent-service` 的
 * schema/parse 只留 id+description），而密背板格式层（story + 行为断言 + priority）
 * 的生产能力此前只挂在修改门（normalizer），首轮澄清不产——导致 PRD 背板单薄、
 * MVP 提示词/GWT 骨架/裁判门禁拿不到真实完成标尺。
 *
 * 本模块在 `resolvePrdBackplane`（sketch_confirmed，需求已冻结）与 `generatePrdLlm`
 * 并行跑一道「功能项加厚」LLM 提取，把薄项补成 story + 行为断言 + 优先级。
 * 只填缺省字段、绝不改写已有字段（保住 F-001 主题锚点与用户已确认的纠错项）；
 * 任何失败（无对话/无 query/非 JSON/校验不过/重试耗尽）返回 `null` 由调用方兜底，
 * 行为与现状完全一致。
 *
 * 反幻觉（调研 2025 共识：验收标准生成是已验证高价值用例，gap-filling 是头号
 * 合成幻觉）：每条断言必须附 `source` 用户原话引用，三层确定性守卫在并入前过滤：
 * ①格式守卫（解析不出触发/效果 = 对 judge 无探针价值，宁缺勿滥）
 * ②接地守卫（source 归一化后必须作为子串出现在 user 轮次/该项 description，否则
 *   视为潜在 gap-filling 丢弃）
 * ③优先级规则（已有值保留；F-001 缺省恒 P0；非 F-001 项 LLM 标 P0 但断言全灭 →
 *   不写入 priority，读取侧缺省 P2、本轮不进 P0 硬门禁，降级不粘滞）
 *
 * 归属与可见性：`readConversation` 为 `prd-engine-llm` 私有函数，随本设计改为导出
 * （行为不变）；`parseBehaviorAssertion` 已在 document-engine / gwt-service 跨模块
 * 使用，此处直接复用。
 */

export interface EnrichRequirementsInput {
  material_text?: string
  session_id: string
  /** 已冻结功能项（薄/厚混合）：只对无 behavior_assertions 的项加厚（净效果——LLM 侧仍全量一一对应输出以保形状稳定，由合并层按「只填缺省」实现此契约） */
  requirements: SketchRequirement[]
  query: SDKQuery
  env: Record<string, string>
  signal?: AbortSignal
  /** 渠道能力上限（channel.max_tokens ?? 640000，§3.3 传入）；enricher 预算 = min(该上限, 4096 + 项数×600)，绝不请求超过渠道上限 */
  maxTokens?: number
}

/** 中间形态：behavior_assertions 为 LLM 原始 `{assertion, source}` 对象数组，source 保留到合并层供守卫②接地校验（校验后丢弃，不回写 prd.json）。 */
export interface EnrichedSketchRequirement {
  id: string
  story?: string
  behavior_assertions?: Array<{ assertion: string; source: string }>
  priority?: string
}

/** mergeEnrichment 的分类统计：断言丢弃数（①格式/②接地）与优先级抑制数（③）。纯返回值，无日志副作用；决策日志由调用侧落盘。 */
export interface EnrichmentStats {
  /** ①格式守卫丢弃的断言数（parseBehaviorAssertion 解析不出触发/效果 → presenceFallback） */
  formatDropped: number
  /** ②接地守卫丢弃的断言数（source 归一化后未命中 user 轮次/该项 description，或长度 <4） */
  groundingDropped: number
  /** ③优先级抑制数（非 F-001 项 LLM 标 P0 但断言全灭 → 不写入 priority，读取侧缺省 P2） */
  prioritySuppressed: number
}

const DEFAULT_MAX_TOKENS = 640000
/** 生成尝试次数上限：首试 + 至多一次恢复重试（对齐 mvp-engine-llm 的 MAX_GENERATION_ATTEMPTS=2）。 */
export const MAX_GENERATION_ATTEMPTS = 2
/** 加厚输出预算基准（设计 §3.1）：4096 + 项数×600 线性放大，长清单自动扩容避免截断。 */
const BUDGET_BASE = 4096
const BUDGET_PER_ITEM = 600

export const DEFAULT_SYSTEM_PROMPT = `你是「Bloma 向导 · 需求加厚腿」。把已冻结但过薄的软件功能项，补成可执行的行为契约。只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。

输入：功能项清单（只做语义补全，不改写 id/description/顺序）+ 用户对话原文。

输出结构：
{"requirements":[
  {"id":"F-001",
   "story":"作为<角色>，我想<功能>，以便<价值>",
   "behavior_assertions":[
     {"assertion":"<触发>→<效果>","source":"支持该断言的用户原话（逐字引用，≤30 字符）"}
   ],
   "priority":"P0"}
],
"clarification_requests":[{"for":"F-001","question":"一句话问题","options":[{"id":"opt-a","label":"具体选项A"},{"id":"opt-b","label":"具体选项B"}]}]}

规则：
- 只加厚，不改写：description 是用户/向导冻结的「要做什么」，不得重写；story 是对它的故事化转述。
- 断言必须「触发→效果」、可执行可断言（示例：「点击保存按钮→列表新增一条记录」「按右方向键→车辆 x 坐标增加」）。禁止人工验收类表述（「用户手动测试」「能正常工作」）。
- 每条断言必须附一条 source：能从【用户对话】或该功能项 description 里逐字找到的原话。找不到支撑原话的断言直接删掉，不要编。
- 反编造（禁止补齐式幻觉 gap-filling）：每条断言的 source 必须能从【用户对话】或该项 description 里逐字找到原话（接地守卫②据此硬验引用存在性，无逐字原话即丢弃）；断言本身可将 source 所述意图操作化为可探针的触发→效果（「点击…控件」「…文本变化」等 UI 实现措辞属允许的操作化，不算编造），但不得借「紧邻常识可推出」补出 source/description 之外用户未提及的新功能实体/新场景。无把握宁可不写。每条功能项 0~3 条断言。
- 追问纪律（clarification_requests，可远项）：仅当存在**不问清就无法写出关键断言**的信息缺口（如「能切换音色」但不知切换方式/数量/入口）时，输出该数组，最多 1 条（一次只问一个最关键的问题）；该问题必须附 2~3 个互斥的具体选项（options，每个选项是用户可直接点选的具体答案）；能不问就不问——追问会打断用户，只值得为影响成品形态的缺口发问。无缺口不输出该字段。
- 已答不重问：用户对话里已经说过的信息（含上一轮追问的答案）不得再问；用户只给了方向性回答（如“每天早上”）时，具体值（如“9 点”）按行业常见默认并在断言里体现该默认，不再追问。
- 时间/数量/入口这类参数，只要能写出可执行断言就不要追问具体取值；缺口拿不准时宁可不问、按默认写断言并在 source 里引用户原话。
- priority：P0 核心必做 / P1 重要 / P2 锦上添花。
- requirements 与输入功能项一一对应（同 id、同数量），不得新增/删除/改名。

【示例】
功能项：
- F-001: 帮我做一个电子音乐合成器
用户对话：
用户：帮我做一个电子音乐合成器，我是玩音乐的人，想自己调出各种声音
助手：好的，先确认一个关键点：你主要想在电脑上弹奏，还是做音色设计？
用户：主要是弹奏，能有不同的音色切换就行
输出：
{"requirements":[{"id":"F-001","story":"作为音乐爱好者，我想在电脑上弹奏并切换音色合成电子音乐，以便自由创作声音","behavior_assertions":[{"assertion":"点击音色切换控件→当前音色名称文本变化","source":"能有不同的音色切换就行"}],"priority":"P0"}],"clarification_requests":[{"for":"F-001","question":"音色切换用什么交互？","options":[{"id":"dropdown","label":"下拉列表选择"},{"id":"buttons","label":"按钮组切换"},{"id":"keyboard","label":"键盘快捷键"}]}]}

【示例（不追问）】用户已给出足够信息（“每天自动生成、推送到手机上”）时，不再问具体时刻，直接把“每日定时生成并推送”写成断言：
{"requirements":[{"id":"F-001","story":"作为用户，我想让应用每天自动生成当日总结并推送，以便无需手动回顾","behavior_assertions":[{"assertion":"每天到达定时点→系统自动生成当日总结并推送","source":"每天自动生成，推送到手机上"}],"priority":"P0"}]}

只输出 JSON。`

/** 格式错误（非截断）恢复重试的反馈提示：只要求重输出合法 JSON，不修补内容。 */
const RETRY_FEEDBACK_PROMPT =
  '你上一次的输出无法被解析为有效 JSON。请重新只输出一个 JSON 对象' +
  '（{"requirements":[{"id":"F-001","story":"...","behavior_assertions":[{"assertion":"触发→效果","source":"用户原话"}],"priority":"P0"}]}），' +
  '不要任何 markdown 代码围栏、不要任何解释文字，确保所有括号与引号完整闭合，requirements 与输入功能项一一对应。'

/**
 * 功能项加厚：LLM 从对话把薄功能项补成 story + 行为断言 + 优先级。
 *
 * 解析与重试（共享同一总预算 = MAX_GENERATION_ATTEMPTS=2；2026-09-03 R2 尾巴：调用
 * 循环已下沉 kernel/llm-call 标准件）：首轮输出失败时按失败类型选重试策略——截断 →
 * truncationRetry 在渠道上限内升 maxTokens 后全新重生成；JSON 解析失败 → 带 parse
 * error 回灌重试。重试轮无论以何种原因再次失败 → 预算耗尽、不再重试，返回 `null`
 * 走既有降级（不存在第 3 次调用）。
 *
 * maxTokens：预算 = min(渠道上限, 4096 + 项数×600)，绝不请求超过渠道上限；预算已
 * 触渠道上限仍截断（渠道硬限）→ 升 maxTokens 不可行，直接返回 `null`。不做任何内容级修补。
 *
 * 追问通路（② 2026-09-03）：可选 onClarification 回调——模型在本轮输出中主动声明
 * 的信息缺口（K-2：触发权在模型判定，非守卫丢弃计数；K-6：追问与加厚不互斥，本轮
 * 可用断言照常返回）。仅在解析成功（返回非 null）时回调；requests 已过确定性清洗
 * （for 在冻结 id 集/去重/≤2 条）。回调时机在返回前，调用方可据此挂起 PRD 收敛链。
 */
export async function enrichRequirementsLlm(
  input: EnrichRequirementsInput,
  onClarification?: (requests: EnrichmentClarificationRequest[]) => void,
): Promise<EnrichedSketchRequirement[] | null> {
  const conversation = [readConversation(input.session_id), input.material_text].filter(Boolean).join('\n\n')
  if (!conversation.trim()) return null
  if (!input.query || !input.env) return null

  // 渠道能力上限（调用侧 §3.3 传入 channel.max_tokens ?? 640000）
  const channelCap = input.maxTokens ?? DEFAULT_MAX_TOKENS
  const initialBudget = Math.min(channelCap, BUDGET_BASE + input.requirements.length * BUDGET_PER_ITEM)

  // 追问请求（跨重试轮以最后一轮成功 parse 的为准；失败轮的残留不回调）
  let clarification: EnrichmentClarificationRequest[] = []
  const frozenIds = new Set(input.requirements.map((item) => item.id))
  const parsed = await callLlmForJson({
    systemPrompt: loadPromptOverride('enricher-system') ?? DEFAULT_SYSTEM_PROMPT,
    prompt: buildPrompt(input.requirements, conversation),
    query: input.query,
    env: input.env,
    sessionId: input.session_id,
    maxTokens: initialBudget,
    // §7.7 类别温度：判定/提取要稳、可复现（0.1）
    temperature: categoryTemperature('prd'),
    attempts: MAX_GENERATION_ATTEMPTS,
    retryFeedback: RETRY_FEEDBACK_PROMPT,
    truncationRetry: { cap: channelCap },
    signal: input.signal,
    parse: (text) => {
      const result = parseEnrichedJson(text)
      if (!result) return undefined
      clarification = sanitizeClarificationRequests(result.clarification_requests, frozenIds)
      return sanitizeEnriched(result.requirements) ?? undefined
    },
  })
  if (parsed && clarification.length > 0) onClarification?.(clarification)
  return parsed
}

interface ParsedEnrichedItem {
  id: string
  story?: string
  behavior_assertions?: Array<{ assertion: string; source: string }>
  priority?: 'P0' | 'P1' | 'P2'
}

interface ParsedEnriched {
  requirements: ParsedEnrichedItem[]
  /** 模型主动声明的信息缺口（原始形态，未经 sanitizeClarificationRequests 清洗） */
  clarification_requests: unknown
}

function parseEnrichedJson(text: string): ParsedEnriched | undefined {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return undefined
  }
  if (!Array.isArray(parsed.requirements)) return undefined
  const items = parsed.requirements
    .filter(isRecord)
    .filter((item): item is Record<string, unknown> & { id: string } => typeof item.id === 'string' && item.id.trim().length > 0)
    .map((item): ParsedEnrichedItem => ({
      id: item.id.trim(),
      story: typeof item.story === 'string' && item.story.trim() ? item.story.trim() : undefined,
      behavior_assertions: parseAssertions(item.behavior_assertions),
      priority: isValidPriority(item.priority) ? item.priority : undefined,
    }))
  return { requirements: items, clarification_requests: parsed.clarification_requests }
}

/** 解析断言数组：{assertion, source} 结构，逐条清洗；无 source 的保留空串由接地守卫②丢弃。 */
function parseAssertions(raw: unknown): Array<{ assertion: string; source: string }> | undefined {
  if (!Array.isArray(raw)) return undefined
  const assertions = raw
    .filter(isRecord)
    .filter((entry): entry is Record<string, unknown> & { assertion: string } => typeof entry.assertion === 'string' && entry.assertion.trim().length > 0)
    .map((entry) => ({
      assertion: entry.assertion.trim(),
      source: typeof entry.source === 'string' ? entry.source.trim() : '',
    }))
  return assertions.length > 0 ? assertions : undefined
}

/** 结构校验：id 集合去重后非空即有效（id 与冻结清单的对应由 mergeEnrichment 的权威 id 集处理）。 */
function sanitizeEnriched(parsed: ParsedEnrichedItem[]): EnrichedSketchRequirement[] | null {
  if (parsed.length === 0) return null
  return parsed.map((item) => ({
    id: item.id,
    ...(item.story ? { story: item.story } : {}),
    ...(item.behavior_assertions?.length ? { behavior_assertions: item.behavior_assertions } : {}),
    ...(item.priority ? { priority: item.priority } : {}),
  }))
}

function buildPrompt(requirements: SketchRequirement[], conversation: string): string {
  const list = requirements.length
    ? requirements.map((item) => `- ${item.id}: ${item.description}`).join('\n')
    : '- F-001: 一个可运行、可交互的功能页面'
  return [
    `请把下面这些已冻结的功能项加厚为可执行的行为契约。`,
    ``,
    `【功能项清单（只做语义补全，不改写 id/description/顺序）】`,
    list,
    ``,
    `【用户对话原文】`,
    conversation,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// 守卫（确定性，纯函数，独立可测）
// ---------------------------------------------------------------------------

export interface GuardedAssertions {
  /** 经①②存活的行为断言（仅 assertion 文本，source 校验后丢弃） */
  survived: string[]
  /** ①格式守卫丢弃数 */
  formatDropped: number
  /** ②接地守卫丢弃数 */
  groundingDropped: number
}

/**
 * 行为断言守卫（①格式 + ②接地）。
 *
 * ①格式守卫：parseBehaviorAssertion(assertion).presenceFallback === true 的断言丢弃
 *   ——词表解析不出触发/效果 = 对 judge 无探针价值，宁缺勿滥。这与「纠错路径对 user
 *   原话待评估不失败」刻意不同——纠错项是用户亲手写的要保留，这里是模型生成的可再生
 *   内容，精度优先。
 * ②接地守卫（反幻觉核心）：source 归一化（去空白/引号）后必须作为子串出现在任一
 *   user 轮次或该项 description 里，且长度 ≥4 字符；否则丢弃。模型无法引用 → 断言
 *   无从溯源 → 视为潜在 gap-filling。（本守卫是「引用存在性」确定性过滤，拦截无任何
 *   用户原话支撑的断言；断言语义是否被引文支持属语义判定，由自检 judge 兜底。）
 */
export function guardBehaviorAssertions(
  assertions: Array<{ assertion: string; source: string }>,
  userTexts: string[],
  description: string,
): GuardedAssertions {
  const survived: string[] = []
  let formatDropped = 0
  let groundingDropped = 0
  for (const entry of assertions) {
    if (parseBehaviorAssertion(entry.assertion).presenceFallback) {
      formatDropped += 1
      continue
    }
    if (!groundingPasses(entry.source, userTexts, description)) {
      groundingDropped += 1
      continue
    }
    survived.push(entry.assertion)
  }
  return { survived, formatDropped, groundingDropped }
}

/** 接地命中判定：source 归一化后 ≥4 字符，且作为子串出现在 user 轮次/该项 description 里。 */
function groundingPasses(source: string, userTexts: string[], description: string): boolean {
  const normalizedSource = normalizeQuoteWhitespace(source)
  if (normalizedSource.length < 4) return false
  return [description, ...userTexts].some((text) => normalizeQuoteWhitespace(text).includes(normalizedSource))
}

/** 去空白与各类引号（「去空白/引号」的归一化，两侧同口径）。 */
function normalizeQuoteWhitespace(text: string): string {
  return text.replace(/[\s"'“”‘’「」『』]/g, '')
}

// ---------------------------------------------------------------------------
// 合并（mergeEnrichment）：以冻结清单为权威 id 集，只填缺省字段
// ---------------------------------------------------------------------------

/**
 * 合并加厚结果到冻结清单。
 *
 * 合并语义（设计 §3.2）：
 * - 冻结清单为权威 id 集（不新增不删除冻结项；prd.json 有而冻结无的项丢弃，冻结有而
 *   prd.json 无的项照常加厚）；
 * - 对每个冻结项，先并入上轮 prd.json 对应项的既有字段（既有 story/behavior_assertions/
 *   priority 成为「已有」），再只填缺失字段——story 缺才补、behavior_assertions 缺才补
 *   （且补后过①②）、priority 缺才补（过③）；
 * - 既有断言的「已有」判定：并入前先剔除模板回退物化的默认存在性断言
 *   （DEFAULT_BEHAVIOR_ASSERTION，格式守卫①必弃）——仅含该默认断言的项按「缺」处理、
 *   仍可加厚并入（既有数据的迁移/重判路径）；normalizer 纠错/迭代写入的真实断言不受
 *   影响、原样并入；
 * - 转换点与 source 丢弃点：enriched 的 behavior_assertions 为 {assertion, source} 对象
 *   数组——先过①②得存活断言集，仅取 assertion 文本写入 string[]，source 在②校验后即
 *   丢弃不回写 prd.json；behavior_assertions 仅当存活断言数 ≥1 才写入（全灭视为「缺」，
 *   不写入、保留薄形态、重跑仍可再加厚）；priority 按③计算（全灭 + LLM 标 P0 → 不写入）；
 * - `enriched` 为 `null`（失败路径）→ 直接返回合并底（等价于不合并），不得抛错；
 *   mergeEnrichment 自身任何异常 → 返回合并底清单，不得向外抛。
 *
 * @param frozen 冻结功能项（权威 id 集；llm 失败回退 template 时取原始 requirements）
 * @param enriched 加厚结果（可为 null = 失败路径）
 * @param existingRequirements 上轮 prd.json 对应项的既有字段（首轮无 prd.json 时为薄冻结项）
 * @param userTexts 接地守卫②的用户原话（user 轮次逐条；readConversation 按「用户：」前缀切分后仅取 user 片段）
 */
export function mergeEnrichment(
  frozen: SketchRequirement[],
  enriched: EnrichedSketchRequirement[] | null,
  existingRequirements: SketchRequirement[],
  userTexts: string[] = [],
): { requirements: SketchRequirement[]; stats: EnrichmentStats } {
  const stats: EnrichmentStats = { formatDropped: 0, groundingDropped: 0, prioritySuppressed: 0 }
  const fallback = (): { requirements: SketchRequirement[]; stats: EnrichmentStats } => {
    const existingById = new Map(existingRequirements.map((item) => [item.id, item]))
    return { requirements: frozen.map((item) => mergeExistingFields(item, existingById.get(item.id))), stats }
  }
  try {
    if (!enriched) return fallback()
    const existingById = new Map(existingRequirements.map((item) => [item.id, item]))
    const enrichedById = new Map(enriched.map((item) => [item.id, item]))
    const requirements = frozen.map((item) =>
      mergeItem(item, existingById.get(item.id), enrichedById.get(item.id), userTexts, stats),
    )
    return { requirements, stats }
  } catch {
    return fallback()
  }
}

/** 合并底：冻结项 + 上轮 prd.json 既有字段（行为断言剔除默认存在性断言后判定「已有」）。
 *  方向修正（全链路审查 P1-5，2026-10-01）：冻结清单已带的厚字段优先，existing 只补
 *  缺失——旧方向 existing 无条件覆盖，会把用户刚在审查卡/追问/确认卡里亲答的修订
 *  （story/断言/priority，经 applyNormalization 写入冻结清单）落盘即回滚成盘上旧值。 */
function mergeExistingFields(item: SketchRequirement, existing: SketchRequirement | undefined): SketchRequirement {
  if (!existing || existing.description !== item.description) return { ...item }
  const base: SketchRequirement = { ...item }
  if (!base.story?.trim() && existing.story?.trim()) base.story = existing.story
  const existingAssertions = stripDefaultAssertions(existing.behavior_assertions)
  if ((base.behavior_assertions ?? []).length === 0 && existingAssertions.length > 0) base.behavior_assertions = existingAssertions
  if (!isValidPriority(base.priority) && isValidPriority(existing.priority)) base.priority = existing.priority
  return base
}

/**
 * 单冻结项合并：并入既有字段后，只填缺失字段（story / behavior_assertions / priority）。
 * stats 为本项守卫造成的丢弃/抑制增量。
 */
function mergeItem(
  item: SketchRequirement,
  existing: SketchRequirement | undefined,
  enrichedItem: EnrichedSketchRequirement | undefined,
  userTexts: string[],
  stats: EnrichmentStats,
): SketchRequirement {
  const base = mergeExistingFields(item, existing)
  if (!enrichedItem) return base

  // story 缺才补（不设确定性守卫：§3.1 prompt 约束为对 description 的故事化转述）
  if (!base.story?.trim() && enrichedItem.story?.trim()) base.story = enrichedItem.story.trim()

  // behavior_assertions 缺才补（且补后过①②）
  const hasExistingAssertions = (base.behavior_assertions ?? []).length > 0
  let survivedAssertions: string[] | undefined
  if (!hasExistingAssertions && enrichedItem.behavior_assertions?.length) {
    const guard = guardBehaviorAssertions(enrichedItem.behavior_assertions, userTexts, item.description)
    stats.formatDropped += guard.formatDropped
    stats.groundingDropped += guard.groundingDropped
    survivedAssertions = guard.survived
  }
  // 断言全灭 = 无既有断言 + （无加厚断言或加厚断言①+②后全灭）
  const assertionsAllDead = !hasExistingAssertions && (!enrichedItem.behavior_assertions?.length || (survivedAssertions?.length ?? 0) === 0)

  // priority 缺才补（过③）
  if (!base.priority) {
    if (item.id === 'F-001') {
      // F-001 缺省恒 P0（主题锚点不变式）；F-001 已存在非 P0 priority 由上方「已有」保留
      base.priority = 'P0'
    } else if (enrichedItem.priority) {
      if (enrichedItem.priority === 'P0' && assertionsAllDead) {
        // LLM 标 P0 但断言全灭 → 不写入 priority（读取侧缺省 P2，本轮不进 P0 硬门禁；
        // 下轮断言经①②存活且 LLM 再判 P0 可写入——降级不粘滞、可自愈）
        stats.prioritySuppressed += 1
      } else if (isValidPriority(enrichedItem.priority)) {
        base.priority = enrichedItem.priority
      }
    }
    // 无 LLM priority → 不写入，读取侧缺省 P2
  }

  // 断言写入（仅当 ≥1 存活；全灭不写入该字段、保留薄形态）
  if (!hasExistingAssertions && survivedAssertions && survivedAssertions.length > 0) {
    base.behavior_assertions = survivedAssertions
  }
  return base
}

/** 剔除占位断言（P1-6：默认存在性断言及其变体——「可见且可交互」类泛化表述）后返回真实断言。
 *  从「仅剔 DEFAULT_BEHAVIOR_ASSERTION 完全相等」升级为「识别占位断言变体」（isPlaceholderAssertion），
 *  杜绝模型换词偷懒（「功能在页面可见」「能正常使用」等）绕过格式守卫①。 */
function stripDefaultAssertions(assertions: string[] | undefined): string[] {
  if (!assertions) return []
  return assertions.map((value) => value.trim()).filter((value) => value.length > 0 && !isPlaceholderAssertion(value))
}

function isValidPriority(value: unknown): value is 'P0' | 'P1' | 'P2' {
  return value === 'P0' || value === 'P1' || value === 'P2'
}

/** 把 readConversation 返回的全文对话切分为 user 轮次文本（「用户：」前缀片段，不含前缀）。 */
export function extractUserTexts(conversation: string): string[] {
  const prefix = '用户：'
  return conversation
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length).trim())
    .filter((text) => text.length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

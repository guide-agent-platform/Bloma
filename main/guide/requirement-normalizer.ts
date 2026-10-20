import type { SDKQuery } from '../orchestration/orchestrator'
import type { ThinkingLevel } from '../../shared/reasoning-profile'
import { loadPromptOverride } from '../agent/prompting/prompt-config'
import type { SketchRequirement } from "../model/prd-backplane";
import { requirementAssertions } from "../model/prd-backplane";
import { categoryTemperature } from '../platform/llm/model-resolution'
import { recordDecision } from '../project/decision-log'
import { callLlmForJson } from '../kernel/llm-call'

/**
 * RequirementNormalizer — 向导群·需求归一化腿（2026-09-03 ③归一化归位：prompt 家族化为
 * 向导分身，与 prd-engine-llm 需求工程腿同族——独立子代理式调用、干净上下文、低温
 * 确定性；槽位 id normalizer-system 不变，外置覆盖零迁移）。修改诉求并入需求清单
 * 前的归一化（2026-08-16 复测 43b47a47 发现：口语碎片原样追加污染 PRD 背板——
 * 「重新生成」被 acceptance 解释成功能、产品里长出「重新生成」按钮；「车的运行方向不对」
 * 作为独立功能项只能生成最小满足版）。
 *
 * 归一化三件事（模型判定，确定性守卫）：
 * 1. 故事化 + 行为化（§5.2）：产出升级为密背板格式层——story（作为<角色>，我想<功能>，
 *    以便<价值>）+ behavior_assertions（可执行、可断言）+ priority（P0/P1/P2）；
 * 2. revise / append / skip / out_of_scope 四向判定（§5.3）：修正已有项 revise（F-001
 *    主题锚点禁重写 story、行为修正以追加断言并入）、全新能力 append、操作指令 skip
 *    （记录进 assumptions 不进功能项）、范围声明 out_of_scope（并入全局范围外）；
 * 3. 断言边界：只固化可从用户输入直接推出或紧邻常识默认的内容；超出输入的常识补全
 *    记入 assumptions（输出字段），不固化进行为权威。
 *
 * 优雅降级：无 env / 模型失败 / 非 JSON / 校验不过 → 回退调用方现状（原样追加清洗原文，
 * 读取侧 helper 兜底默认断言与 P2），绝不阻断生成链路（与 prd-engine-llm 同策略）。
 */

export interface NormalizeRequirementUpdateInput {
  session_id: string
  /** 当前冻结需求清单（含 F-001 主题锚点） */
  existing: SketchRequirement[]
  /** 已经过规则清洗（refineModificationDescription）的修改描述 */
  modification: string
  /** 用户已声明约束（T4-L1：project.constraints，历轮生效；与约束冲突的新功能判 out_of_scope） */
  constraints?: string[]
  query: SDKQuery
  env: Record<string, string> | undefined
  signal?: AbortSignal
  maxTokens?: number
  /** 推理档位（reasoning-profile 2026-08-27）：归一化判定类任务可显式传入；缺省 off = 现状 */
  thinkingLevel?: ThinkingLevel
  /** 渠道 providerType（omit 黑名单判断；不传 = 不做 omit） */
  providerType?: string
}

export type RequirementNormalizationAction = 'revise' | 'append' | 'skip' | 'out_of_scope'

export interface RequirementNormalizationDecision {
  action: RequirementNormalizationAction
  /** 实际入库的功能项描述（skip 时为空串；out_of_scope 时是范围声明本身） */
  description: string
  /** 故事化描述（§3.1）：缺省回退 description */
  story?: string
  /** 行为断言（§3.1）：可执行、可断言；缺省由读取侧兜底默认断言 */
  behavior_assertions?: string[]
  /** P0/P1/P2；缺省 P2（不触发 P0 门禁） */
  priority?: 'P0' | 'P1' | 'P2'
  /** 单条范围排除（revise 并入目标项的 scope_notes） */
  scope_notes?: string
  /** 超出输入的常识补全（记入 assumptions，不固化进行为断言） */
  assumptions?: string[]
  /** revise 目标功能项 id（action=revise 且守卫通过时存在） */
  reviseId?: string
  /** action=out_of_scope 时的范围声明（调用方并入 project.scope_exclusions） */
  outOfScope?: string
  /** R0.5（2026-09-19 狗粮 7601e5ae）：范围声明被反转守卫拦下时如实留痕（action 已降级 skip） */
  guard_note?: string
  /** 决策来源：llm=模型归一化；fallback=规则清洗原文原样追加（改动前现状） */
  via: 'llm' | 'fallback'
}

/** 单条功能项描述上限：防模型把整段对话塞进清单 */
const MAX_DESCRIPTION_LENGTH = 300
const DEFAULT_MAX_TOKENS = 640000

export const DEFAULT_SYSTEM_PROMPT = `你是「Bloma 向导 · 需求归一化腿」（向导群内的独立工程子代理：干净上下文、低温确定性产出，只做归一化判定不改写对话）。用户对已生成项目提出了一条修改诉求，你要把它整理为「故事化功能项」并决定如何并入已有功能项清单。

判定规则（四选一）：
- revise：这条诉求是对某个已有功能项的修正、细化或纠错（如「车的运行方向不对」是修正控制类功能项）。重写该功能项的故事化描述并**追加**行为断言，给出 revise_id；
- append：清单里没有对应的全新功能/能力。产出一条新的故事化功能项；
- skip：操作指令或无信息量的话（如「重新生成」「再来一次」「不对」），不是功能需求，不应进入需求清单；
- out_of_scope：范围声明（如「不要排行榜」「别做登录」），用户明确不要的东西，记为范围排除。

产出格式（密背板格式层）：
- story：故事化描述，形如「作为<角色>，我想<功能>，以便<价值>」；
- description：与 story 同义的一行简洁陈述句（「产品应该是什么样」，去掉口语/否定引导/对操作本身的引用，反面表述转正面：「方向不对」→「方向与操作一致」）；
- behavior_assertions：行为断言数组，每条**可执行、可断言**（给具体断言而非「能正常工作」，如「按右方向键→车辆 x 坐标增加」「点击保存按钮→列表新增一条记录」）。禁止写「用户手动测试」「用户确认可见效果」这类人工验收；
- priority：P0（核心必做）/ P1（重要）/ P2（锦上添花），由诉求对产品核心体验的影响决定；
- 断言边界：只固化可从用户输入直接推出或紧邻常识默认的内容；超出输入的常识补全（如默认键位）记入 assumptions 数组，不写进行为断言；
- 严格基于用户诉求改写，不臆造用户没提的功能。

只输出一个 JSON 对象，不要任何多余文字，不要 markdown 代码块围栏。四种形态示例：
{"action":"revise","revise_id":"F-003","story":"作为玩家，我想用方向键控制赛车移动，以便获得驾驶操控感","description":"用户可通过方向键控制赛车移动，行进方向与按键语义一致","behavior_assertions":["按右方向键→车辆 x 坐标增加","按左方向键→车辆 x 坐标减小"],"priority":"P0","assumptions":["按空格键→车辆速度归零（常识补全默认，非用户显式要求）"]}
{"action":"append","story":"作为用户，我想查看历史记录，以便回顾之前的操作","description":"提供历史记录列表，展示最近 20 条操作","behavior_assertions":["完成一次操作→历史列表新增一条记录"],"priority":"P1"}
{"action":"skip","reason":"操作指令"}
{"action":"out_of_scope","description":"不做排行榜功能"}`

export async function normalizeRequirementUpdate(
  input: NormalizeRequirementUpdateInput,
): Promise<RequirementNormalizationDecision> {
  if (!input.env) return fallback(input.modification)
  // 2026-09-03 R2 尾巴：调用已迁 kernel/llm-call 标准件；attempts=1 保持单试现状
  // （无带反馈重试——归一化失败回退规则清洗原文，重试收益低于延迟成本）。
  const decision = await callLlmForJson({
    systemPrompt: loadPromptOverride('normalizer-system') ?? DEFAULT_SYSTEM_PROMPT,
    prompt: buildPrompt(input.existing, input.modification, input.constraints),
    query: input.query,
    env: input.env,
    sessionId: input.session_id,
    maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
    // §7.7 类别温度：归一化判定要稳、可复现（0.1）
    temperature: categoryTemperature('prd'),
    attempts: 1,
    signal: input.signal,
    // 推理档位试点：判定/校验类任务启用（仅 deepseek-v4* / glm 系 profile 生效，其余自动落回现状）
    thinkingLevel: input.thinkingLevel,
    providerType: input.providerType,
    parse: (text) => {
      const parsed = parseDecision(text)
      return parsed ? (sanitize(parsed, input.existing) ?? undefined) : undefined
    },
  })
  const resolved = decision ?? fallback(input.modification)
  // R0.5：out_of_scope 语义反转守卫——正向祈使诉求被归一化为否定式范围声明（狗粮实锤：
  // 「把数据存到服务端」→「不做服务端存储，流水数据仅保存在本机」，与诉求方向相反且
  // 与 interface_spec 自相矛盾，还永久入库污染背板）。拦下后降级 skip（清单原样；
  // 局部迭代仍按诉求原文跑——狗粮实证该路径模型能如实回报「已实现」，用户侧无害）。
  if (resolved.action === 'out_of_scope' && resolved.outOfScope && isScopeInversion(input.modification, resolved.outOfScope)) {
    return {
      action: 'skip',
      description: '',
      via: 'llm',
      guard_note: `范围声明「${resolved.outOfScope}」与正向诉求方向相反（疑似把诉求反转成了否定式排除），已拒绝入库；按原清单处理，修改诉求原文交给局部迭代`,
    }
  }
  return resolved
}

/**
 * 把归一化决策应用到需求清单。nextId 由调用方传入（id 生成归 programming-orchestrator，
 * 本模块保持叶子依赖、不反向 import 造成运行时环）。fallback 决策即改动前现状：原样追加。
 *
 * revise 语义（§5.3）：
 * - 目标为 F-001 主题锚点：**禁重写 story 主题**——description/story 原样保留，
 *   行为修正以追加断言 + 合并 scope_notes 并入 F-001，不漂移锚点；
 * - 其余目标：重写 description/story，追加断言（去重），priority 取决策值兜底原值。
 */
export function applyNormalization(
  existing: SketchRequirement[],
  decision: RequirementNormalizationDecision,
  nextId: string,
  source: string = 'auto',
): SketchRequirement[] {
  if (decision.action === 'revise' && decision.reviseId) {
    const target = existing.find((item) => item.id === decision.reviseId)
    if (!target) return appendItem(existing, decision, nextId, source)
    if (target.id === 'F-001') {
      // F-001 例外：主题锚点不动，行为修正并入
      return existing.map((item) =>
        item.id === 'F-001'
          ? {
              ...item,
              capabilities: undefined,
              behavior_assertions: dedupe([...requirementAssertions(item), ...(decision.behavior_assertions ?? [])]),
              ...(decision.scope_notes ? { scope_notes: mergeScopeNotes(item.scope_notes, decision.scope_notes) } : {}),
            }
          : item,
      )
    }
    return existing.map((item) =>
      item.id === decision.reviseId
        ? {
            ...item,
            capabilities: undefined,
            description: decision.description,
            story: decision.story ?? decision.description,
            behavior_assertions: dedupe([...requirementAssertions(item), ...(decision.behavior_assertions ?? [])]),
            priority: decision.priority ?? item.priority,
            ...(decision.scope_notes ? { scope_notes: mergeScopeNotes(item.scope_notes, decision.scope_notes) } : {}),
          }
        : item,
    )
  }
  if (decision.action === 'append') {
    return appendItem(existing, decision, nextId, source)
  }
  // skip（操作指令）与 out_of_scope（范围声明由调用方持久化到 scope_exclusions）：清单原样
  return existing
}

function appendItem(
  existing: SketchRequirement[],
  decision: RequirementNormalizationDecision,
  nextId: string,
  source: string,
): SketchRequirement[] {
  const item: SketchRequirement = {
    id: nextId,
    description: decision.description,
    ...(decision.story ? { story: decision.story } : {}),
    ...(decision.behavior_assertions?.length ? { behavior_assertions: decision.behavior_assertions } : {}),
    ...(decision.priority ? { priority: decision.priority } : {}),
    ...(decision.scope_notes ? { scope_notes: decision.scope_notes } : {}),
    source,
  }
  return [...existing, item]
}

/**
 * 归一化决策落 T2 决策日志（仅 via=llm 时调用——fallback 是改动前现状，无需审计行）。
 * stage 标注入库点：sketch_ready（草图阶段修改意见）/ iteration（ready 后修改迭代）。
 */
export function recordRequirementNormalization(
  input: { project_id: string; session_id: string },
  stage: 'sketch_ready' | 'iteration',
  modification: string,
  decision: RequirementNormalizationDecision,
): void {
  const actionCopy =
    decision.action === 'revise'
      ? decision.reviseId === 'F-001'
        ? `主题锚点 F-001 保持不动，行为修正以追加断言并入（${(decision.behavior_assertions ?? []).join('；')}）`
        : `修订 ${decision.reviseId}，重写故事「${decision.story ?? decision.description}」并追加断言`
      : decision.action === 'append'
        ? `改写为新功能项「${decision.story ?? decision.description}」追加（${(decision.behavior_assertions ?? []).join('；')}）`
        : decision.action === 'out_of_scope'
          ? `判定为范围声明「${decision.outOfScope ?? decision.description}」并入范围外，不入功能项`
          : '判定为操作指令不入需求清单，按原清单重新生成'
  const guardSuffix = decision.guard_note ? `（${decision.guard_note}）` : ''
  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'requirement_normalized',
      title: '修改诉求归一化入库',
      why: `修改诉求「${modification}」→ ${actionCopy}${guardSuffix}`,
      detail: {
        stage,
        action: decision.action,
        revise_id: decision.reviseId,
        description: decision.description,
        story: decision.story,
        behavior_assertions: decision.behavior_assertions,
        priority: decision.priority,
        out_of_scope: decision.outOfScope,
        assumptions: decision.assumptions,
      },
    },
  })
}

function fallback(modification: string): RequirementNormalizationDecision {
  return { action: 'append', description: modification, via: 'fallback' }
}

/** R0.5（2026-09-19 狗粮 7601e5ae）：out_of_scope 反转守卫判定（纯函数，导出供测试）。
 *  正向诉求：含添加/变更类动词且无否定标记；否定式范围声明：含否定词或「仅/只」开头。
 *  两者同时成立 = 归一化把用户要的东西写成了不要的东西 → 拒绝入库。 */
const AFFIRMATIVE_REQUEST_RE = /(把|将|增加|添加|加上|改成|改为|换成|需要|要有|想要|希望|支持|提供|保存到|存到|放到|导出|接入|接上|启用|打开|开启)/
const NEGATION_RE = /(不要|不想|不用|无需|不含|不包括|不涉及|不需要|别做|别加|别用|禁止|不做|去掉|移除|删掉|取消|关闭|关掉)/

export function isScopeInversion(modification: string, outOfScope: string): boolean {
  const mod = modification.trim()
  const scope = outOfScope.trim()
  if (!mod || !scope) return false
  const modAffirmative = AFFIRMATIVE_REQUEST_RE.test(mod) && !NEGATION_RE.test(mod)
  const scopeNegative = NEGATION_RE.test(scope) || /^(仅|只)/.test(scope)
  return modAffirmative && scopeNegative
}

/** 审查答案路由（2026-09-19 狗粮 a602709f 实证修复）：定位含功能项 id 的复合形式
 *  （「F-001 / requirements 全表」「F-002 / F-006」）与全等 id 同等对待，返回命中的
 *  功能项 id（无则 undefined 走章节类旁路）。旧版全等匹配把复合定位全部漏进「补充
 *  说明」user 轮，吸收依赖 PRD 重跑时模型自读——狗粮实锤用户亲答「要，关掉还在」
 *  在 Defender 失败+轮次熔断路径上蒸发（PRD 无留存项、GWT 无留存断言、产物 data/
 *  从未创建）。 */
export function resolveRoutedRequirementId(location: string, requirementIds: Set<string>): string | undefined {
  if (requirementIds.has(location)) return location
  const mentioned = [...location.matchAll(/F-\d+/g)].map((m) => m[0])
  return mentioned.find((id) => requirementIds.has(id))
}

interface ParsedDecision {
  action: RequirementNormalizationAction
  description: string
  story?: string
  behaviorAssertions?: string[]
  priority?: 'P0' | 'P1' | 'P2'
  scopeNotes?: string
  assumptions?: string[]
  reviseId?: string
  outOfScope?: string
}

/**
 * 确定性守卫：描述非空且不超长；revise 目标必须存在（不存在 → 退化为 append，改写仍有价值）；
 * F-001 的 revise 保留为 revise（applyNormalization 里执行「主题不动、断言并入」例外规则）；
 * out_of_scope 必须带范围声明文本，否则退化为 skip（宁可不入库，不错误排除）。
 */
function sanitize(parsed: ParsedDecision, existing: SketchRequirement[]): RequirementNormalizationDecision | undefined {
  if (parsed.action === 'skip') return { action: 'skip', description: '', via: 'llm' }
  if (parsed.action === 'out_of_scope') {
    const scope = (parsed.outOfScope ?? parsed.description).trim()
    if (!scope || scope.length > MAX_DESCRIPTION_LENGTH) return { action: 'skip', description: '', via: 'llm' }
    return { action: 'out_of_scope', description: scope, outOfScope: scope, via: 'llm' }
  }
  const description = parsed.description.trim()
  if (!description || description.length > MAX_DESCRIPTION_LENGTH) return undefined
  const behaviorAssertions = (parsed.behaviorAssertions ?? []).map((value) => value.trim()).filter(Boolean)
  if (parsed.action === 'revise') {
    const target = existing.find((item) => item.id === parsed.reviseId)
    if (target) {
      return {
        action: 'revise',
        description,
        reviseId: target.id,
        ...(parsed.story?.trim() ? { story: parsed.story.trim() } : {}),
        ...(behaviorAssertions.length ? { behavior_assertions: behaviorAssertions } : {}),
        ...(parsed.priority ? { priority: parsed.priority } : {}),
        ...(parsed.scopeNotes?.trim() ? { scope_notes: parsed.scopeNotes.trim() } : {}),
        ...(parsed.assumptions?.length ? { assumptions: parsed.assumptions } : {}),
        via: 'llm',
      }
    }
    return { action: 'append', description, ...(behaviorAssertions.length ? { behavior_assertions: behaviorAssertions } : {}), via: 'llm' }
  }
  return {
    action: 'append',
    description,
    ...(parsed.story?.trim() ? { story: parsed.story.trim() } : {}),
    ...(behaviorAssertions.length ? { behavior_assertions: behaviorAssertions } : {}),
    ...(parsed.priority ? { priority: parsed.priority } : {}),
    ...(parsed.scopeNotes?.trim() ? { scope_notes: parsed.scopeNotes.trim() } : {}),
    via: 'llm',
  }
}

function parseDecision(text: string): ParsedDecision | undefined {
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

  const action = parsed.action
  if (action !== 'revise' && action !== 'append' && action !== 'skip' && action !== 'out_of_scope') return undefined
  // skip/out_of_scope 形态可不带 description（skip 无功能语义；out_of_scope 用 out_of_scope 字段），revise/append 必须带
  const description =
    typeof parsed.description === 'string' ? parsed.description : action === 'skip' || action === 'out_of_scope' ? '' : undefined
  if (description === undefined) return undefined
  const reviseId = typeof parsed.revise_id === 'string' ? parsed.revise_id : typeof parsed.reviseId === 'string' ? parsed.reviseId : undefined
  const priority = parsed.priority === 'P0' || parsed.priority === 'P1' || parsed.priority === 'P2' ? parsed.priority : undefined
  const stringArray = (value: unknown): string[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const items = value.filter((v): v is string => typeof v === 'string')
    return items.length ? items : undefined
  }
  return {
    action,
    description,
    reviseId,
    priority,
    story: typeof parsed.story === 'string' ? parsed.story : undefined,
    behaviorAssertions: stringArray(parsed.behavior_assertions),
    scopeNotes: typeof parsed.scope_notes === 'string' ? parsed.scope_notes : undefined,
    assumptions: stringArray(parsed.assumptions),
    outOfScope: typeof parsed.out_of_scope === 'string' ? parsed.out_of_scope : undefined,
  }
}

function buildPrompt(existing: SketchRequirement[], modification: string, constraints?: string[]): string {
  const list = existing.length
    ? existing.map((item) => {
        const assertions = item.behavior_assertions?.length ? `（已有断言：${item.behavior_assertions.join('；')}）` : ''
        return `- ${item.id}: ${item.description}${assertions}`
      }).join('\n')
    : '- （无已确认功能项）'
  const constraintSection =
    constraints && constraints.length
      ? [
          '',
          '【用户已声明的约束（历轮有效，优先级最高）】',
          ...constraints.map((constraint) => `- ${constraint}`),
          '与上述约束冲突的修改诉求（如约束「不含登录」却要求加登录）判 out_of_scope，理由注明与约束冲突。',
        ]
      : []
  return [
    '请把下面这条修改诉求整理为故事化功能项，并决定它如何并入已有功能项清单。',
    '',
    '【已有功能项】',
    list,
    ...constraintSection,
    '',
    '【用户的修改诉求（已经过初步清洗）】',
    modification,
  ].join('\n')
}

/** 断言合并去重（保序：目标项已有断言在前，追加新断言）。 */
function dedupe(assertions: string[]): string[] {
  return [...new Set(assertions.map((value) => value.trim()).filter(Boolean))]
}

/** scope_notes 合并：两段拼接，去重相同文本。 */
function mergeScopeNotes(existing: string | undefined, addition: string): string {
  if (!existing?.trim()) return addition
  if (existing.includes(addition)) return existing
  return `${existing}；${addition}`
}

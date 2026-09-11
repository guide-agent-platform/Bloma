/**
 * PRD 背板契约层（2026-09-03 模块化 R1：自 sketch-engine.ts 迁出）。
 *
 * PrdBackplane 是全系统唯一需求事实源：guide（工程腿产出）/ review（内审对照）/
 * coding（loop 锚定）/ iteration（意图判定）四群共用。本模块不 import 任何引擎——
 * 依赖倒置：谁都认识契约，契约不认识任何引擎（换调用壳/换派遣不碰契约）。
 *
 * 兼容：sketch-engine.ts 对本模块全量 re-export，既有 import 零改动；
 * 新代码请直接 from './model/prd-backplane'。
 */
import type { ConstraintLevel, ProjectMode, TemplateType } from '../../shared/types'

/** 章节标识（章节 schema 的 id 集；schema 定义在 prd-sections.ts，类型真相源在此随背板维护）。 */
export type PrdSectionId =
  | 'positioning'
  | 'prd_document'
  | 'requirements'
  | 'pages'
  | 'assertions'
  | 'gwt'
  | 'out_of_scope'
  | 'constraints'
  | 'assumptions'
  | 'personas'
  | 'glossary'
  | 'data_model'
  | 'interface_spec'
  | 'gdd'

/** 章节级 provenance（方案 §3.1：升格现有功能项级 origin，标注每章数据来源供内审 F 维对照）。 */
export type SectionProvenance = 'user_quote' | 'clarified' | 'guide_inferred' | 'llm_generated'

/** 页面清单（方案 §3.1：quick 限 ≤3；升格自 max_pages 逻辑，草图引擎消费）。 */
export interface PrdPage {
  name: string
  purpose?: string
}

/** 术语表条目（longterm；LLM 提取 + 纠错回流，全 prompt 注入点统一术语）。 */
export interface GlossaryEntry {
  term: string
  definition: string
}

/** 数据模型（longterm；loop/judge 对照）。 */
export interface DataModelSpec {
  entities: Array<{ name: string; attributes?: string[] }>
  relations: string[]
}

/** 接口规格（longterm 标准级起；loop/judge 消费）。 */
export interface InterfaceEndpoint {
  endpoint: string
  method?: string
  request?: string
  response?: string
}

// ---------------------------------------------------------------------------
// Phase 2 M1（2026-09-09，P1 稿 §3 M1）：能力契约块 CAP（Capability Contract）
// 防蒸馏的三方交汇点（咨询 A 能力条款 / 咨询 B 能力契约块 / 一致性治理 core_capabilities）：
// 「智能部分真正做什么、输入输出依赖什么、什么不算完成」以结构化字段随背板冻结，
// 编程锚定/裁判判定/PRD 确认卡三处消费同一份。开关 BLOMA_CAP_CONTRACT 缺省 off=字节级现状。
// ---------------------------------------------------------------------------

/** 能力条款来源（供裁判/内审区分已确认与假设）。 */
export type AiCapabilitySource = 'user_explicit' | 'confirmed_derived' | 'pending_assumption'

/** 能力契约块单条（P1 稿 M1 schema，字段名与 prd.json 存储一致）。 */
export interface AiCapability {
  /** 条款编号：CAP-01 递增（与 F-00x 功能项编号同风格） */
  capability_id: string
  /** 该能力承担什么任务（不可用「智能处理」类标签词代替） */
  task: string
  /** 关键处理：该能力依赖什么、靠什么成立 */
  keyProcessing: string
  /** 输入输出依赖：输入=…；输出=…；输入变化→输出如何相应变化 */
  ioDependency: string
  /** 哪些实现不算完成（禁止的降级替代） */
  forbiddenSubstitutions: string[]
  /** 验收证据（行为级、可观察） */
  evidence: string[]
  /** 来源：user_explicit=用户原话 / confirmed_derived=已确认需求派生 / pending_assumption=假设 */
  source: AiCapabilitySource
}

/** BLOMA_CAP_CONTRACT 开关（缺省 off=字节级现状：无 CAP 产出/派生/注入；
 * 与 BLOMA_REF_LIBRARY 同口径，off 时即使背板存量有 CAP 也零注入）。 */
export function capContractEnabled(): boolean {
  const raw = (process.env.BLOMA_CAP_CONTRACT ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

// ---------------------------------------------------------------------------
// Phase 7 U1（2026-09-10，E1 咨询 H2 / P7 实施稿 §2）：key_tasks 关键任务块。
// 用户语言的交付标尺——「这一版做完什么才算交付」。PRD 确认卡展示；
// delivery_status（P7-2 H1）按 must_deliver 任务判定；与一致性治理「主任务」
// 表述同源（后续 prompt 文字引用 key_tasks 不再另写一套）。
// 开关 BLOMA_KEY_TASKS 缺省 off=字节级现状（不产出不注入，旧 prd.json 零迁移）。
// ---------------------------------------------------------------------------

/** 关键任务单条（字段名与 prd.json 存储一致）。 */
export interface KeyTask {
  /** 任务编号：KT-01 递增（定稿时统一重编号） */
  task_id: string
  /** 用户语言一句话任务（如「记一笔账，月底能看到这个月花了多少」；非技术术语） */
  label: string
  /** 关联功能项（F-xxx；P0 项必须落入某任务——定稿不变式，漏了自动补） */
  feature_ids: string[]
  /** 必须交付：true 时该任务未通过 → 整版不可称 verified（P7-2 delivery_status 消费） */
  must_deliver: boolean
}

/** BLOMA_KEY_TASKS 开关：缺省 off（prd.json 无 key_tasks 键、确认卡零注入）。 */
export function keyTasksEnabled(): boolean {
  const raw = (process.env.BLOMA_KEY_TASKS ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 背板关键任务读取：过滤缺 label 的残条；缺省 []。 */
export function backplaneKeyTasks(backplane: PrdBackplane): KeyTask[] {
  return (backplane.key_tasks ?? []).filter((task) => task.label.trim().length > 0)
}

/**
 * 关键任务定稿（挂载前清洗，供工程腿 buildBackplaneFromParsed 与单测直测）：
 * ①LLM 产出先过功能项白名单（feature_ids ∩ requirements；悬空任务=无有效关联项
 *   即弃条，不给下游留空承诺）；②未覆盖的 P0 项各自追加派生任务（label=故事
 *   截断、must_deliver=true）——「P0 必落任务」不变式；③task_id 统一重编号
 * KT-01..（追加后不跳号）；④总量截 6（LLM ≤4 + 补齐，宁全勿缺但防滥用）。
 */
export function finalizeKeyTasks(parsed: KeyTask[], requirements: SketchRequirement[]): KeyTask[] {
  const validIds = new Set(requirements.map((item) => item.id))
  const merged: KeyTask[] = []
  for (const task of parsed.slice(0, 4)) {
    const ids = [...new Set(task.feature_ids.filter((id) => validIds.has(id)))].slice(0, 6)
    if (!task.label.trim() || ids.length === 0) continue
    merged.push({ label: task.label.trim().slice(0, 80), feature_ids: ids, must_deliver: task.must_deliver, task_id: '' })
    if (merged.length >= 6) break
  }
  const covered = new Set(merged.flatMap((task) => task.feature_ids))
  for (const item of requirements) {
    if (merged.length >= 6) break
    if (requirementPriority(item) !== 'P0' || covered.has(item.id)) continue
    merged.push({
      task_id: '',
      label: requirementStory(item).replace(/\s+/g, ' ').trim().slice(0, 60) || item.description.slice(0, 60),
      feature_ids: [item.id],
      must_deliver: true,
    })
  }
  return merged.map((task, index) => ({ ...task, task_id: `KT-${String(index + 1).padStart(2, '0')}` }))
}

// ---------------------------------------------------------------------------
// Phase 3 B3（2026-09-09，P1 稿 §3 M3）：round_anchor 三字段。
// 修复轮/迭代轮的本轮范围锚——只限定本轮，不改全局契约；防止「最近错误/修复建议/
// 自己先前的计划」被当成需求变更。开关 BLOMA_ROUND_ANCHOR 缺省 off=字节级现状
// （P1 稿原定不设开关，因当前落地顺序为代码先行、A/B 后置，为保 p1 A/B 单因子
// 纯净性改设开关——偏差已登记开关矩阵 §5）。
// ---------------------------------------------------------------------------

/** 本轮锚三字段（P1 稿 M3 schema）。 */
export interface RoundAnchorSpec {
  /** 本轮不得破坏的能力 */
  must_preserve: string[]
  /** 本轮不许做（不顺手的重构/换库/改需求） */
  out_of_scope: string[]
  /** 怎么算修好/做完（行为级） */
  completion_evidence: string[]
}

/** BLOMA_ROUND_ANCHOR 开关：缺省 off（修复/迭代轮 prompt 与现状字节一致）。 */
export function roundAnchorEnabled(): boolean {
  const raw = (process.env.BLOMA_ROUND_ANCHOR ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

/** 渲染本轮锚段；空 spec 返回空串（零注入）。 */
export function renderRoundAnchorBlock(spec: RoundAnchorSpec): string {
  const list = (title: string, entries: string[]): string =>
    entries.filter(Boolean).length > 0 ? `  ${title}：${entries.filter(Boolean).join('；')}` : ''
  const lines = [
    '【本轮锚（round_anchor）】只限定本轮范围，不改全局契约；最近错误、修复建议或你先前的计划不自动构成需求变更：',
    list('必须保留（本轮不得破坏）', spec.must_preserve),
    list('本轮不许做', spec.out_of_scope),
    list('完成证据（怎么算修好，行为级）', spec.completion_evidence),
  ].filter(Boolean)
  return lines.length > 1 ? lines.join('\n') : ''
}

const p0Items = (backplane: PrdBackplane): SketchRequirement[] =>
  backplane.requirements.filter((item) => requirementPriority(item) === 'P0')

/** 修复轮本轮锚（确定性派生）：必须保留=P0 能力；完成证据=失败断言原文+全量重验。 */
export function buildRepairRoundAnchor(backplane: PrdBackplane, failedAssertions: string[]): RoundAnchorSpec {
  return {
    must_preserve: p0Items(backplane).map((item) => `${item.id} ${requirementStory(item)}`),
    out_of_scope: [
      '不在失败清单内的功能不做改动',
      '不顺手重构、换库、调目录结构或改需求语义',
      ...backplane.out_of_scope.slice(0, 3),
    ],
    completion_evidence: [...failedAssertions.filter(Boolean).slice(0, 6), '全部 P0 断言重验通过（run_gwt_tests 全量）'],
  }
}

/** 迭代轮本轮锚（确定性派生）：聚焦项之外保持现状；完成证据=聚焦项断言+其余不回退。 */
export function buildIterationRoundAnchor(backplane: PrdBackplane, focus: string[]): RoundAnchorSpec {
  const focusSet = new Set(focus)
  const p0 = p0Items(backplane)
  const others = p0.filter((item) => !focusSet.has(item.id))
  const focused = p0.filter((item) => focusSet.has(item.id))
  return {
    must_preserve: others.length > 0 ? others.map((item) => `${item.id} ${requirementStory(item)}`) : ['全部 P0 功能项断言保持通过'],
    out_of_scope: [
      '聚焦项之外的功能不做改动（保持现状勿重做）',
      '不顺手重构、换库或扩大改动面',
      ...backplane.out_of_scope.slice(0, 3),
    ],
    completion_evidence: [
      ...focused.flatMap((item) => requirementAssertions(item).slice(0, 2)),
      '其余 P0 断言不回退（run_gwt_tests 全量）',
    ],
  }
}

/** 背板能力条款读取：过滤缺 task 的残条款；缺省 []。 */
export function backplaneAiCapabilities(backplane: PrdBackplane): AiCapability[] {
  return (backplane.ai_capabilities ?? []).filter((cap) => cap.task.trim().length > 0)
}

/**
 * AI 能力信号词（deriveAiCapabilities 触发判据）。与 bench/harness/metrics.mjs 的
 * AI_INTENT_RE 同源，但 ascii 「ai」收紧为词边界匹配（防 email/main/train 等
 * 含 ai 子串的英文词误触发——bench 侧度量历史项目保持原样，不动）。
 * 改动本表时同步评估 bench 侧口径（陷阱 22 纪律）。
 */
export const AI_CAPABILITY_SIGNAL_RE = /\bai\b|智能|语音|总结|整理|自动生成|自动汇总|大模型/i

/**
 * 确定性派生最小 CAP（LLM 漏报兜底，仿 deriveInterfaceSpec）：功能项命中 AI 信号
 * 而开关开启时，为每条命中项派生一条最小能力契约（确定性模板，不编内容——只把
 * 「该能力的智能性不可被降级替代」开成硬条款）。纯展示/纯 CRUD 零派生。
 * 上限 3 条（派生是兜底不是主力，宁缺毋滥）。
 */
export function deriveAiCapabilities(requirements: SketchRequirement[]): AiCapability[] | undefined {
  const signaled = requirements
    .filter((item) => AI_CAPABILITY_SIGNAL_RE.test(`${item.description} ${item.story ?? ''}`))
    .slice(0, 3)
  if (signaled.length === 0) return undefined
  return signaled.map((item, index) => ({
    capability_id: `CAP-${String(index + 1).padStart(2, '0')}`,
    task: item.description,
    keyProcessing: '由真实模型调用完成该任务（非固定模板、非关键词匹配）',
    ioDependency: '输入=用户内容；输出=随输入变化的智能结果；同类输入应产生一致形态的输出',
    forbiddenSubstitutions: ['固定模板/写死结果冒充智能', '仅关键词匹配冒充理解', '把该能力降级为普通增删改查'],
    evidence: ['修改关键输入后输出随之变化', '模型不可用时明确报错或降级提示，不假装成功'],
    source: 'confirmed_derived',
  }))
}

/**
 * 能力契约渲染段（三处消费同源：loop 背板锚定 / 裁判 prompt / PRD 确认卡）。
 * 精简引用口径（P1 稿 §6 风险项：不把全表注成每轮冗余，完整字段已在背板/prd.json）。
 * 空数组 → 空串（零注入，off=字节级现状）。
 */
export function renderCapSection(caps: AiCapability[]): string {
  if (caps.length === 0) return ''
  const lines = caps.map((cap) => {
    const parts = [
      `- ${cap.capability_id}｜任务：${cap.task}`,
      `  关键处理：${cap.keyProcessing}`,
      `  输入输出：${cap.ioDependency}`,
      `  不算完成：${cap.forbiddenSubstitutions.filter(Boolean).join('；') || '（未声明）'}`,
      `  验收证据：${cap.evidence.filter(Boolean).join('；') || '（未声明）'}`,
    ]
    return parts.join('\n')
  })
  return [
    '【能力契约（CAP，什么不算完成）】以下能力是需求核心，禁止任何降级替代；实现与判定均按「验收证据」口径执行：',
    ...lines,
  ].join('\n')
}

/** 模板元信息（注入点①写入；所有注入点路由依据）。level 缺省随类型（personal_tool=loose，其余 standard）。 */
export interface TemplateMeta {
  type: TemplateType
  level: ConstraintLevel
  version: number
}

/** 模板包内容版本（template_meta.version 的当前值；模板结构变更时 +1）。 */
export const TEMPLATE_META_VERSION = 1

/**
 * 功能项（密背板格式层，2026-08-17 设计 §3.1）。
 *
 * description 保持为「一行可读描述」——存量数据/展示/兜底都以它为准；
 * story / behavior_assertions / priority 是密背板新增的可选厚字段，
 * 读取侧一律经 `requirementStory` / `requirementAssertions` / `requirementPriority`
 * 取值（缺省回退），旧数据（只有 id+description）无需迁移即可参与新管线。
 */
export interface SketchRequirement {
  id: string
  description: string
  /** 故事化描述：作为<角色>，我想<功能>，以便<价值>；缺省回退 description */
  story?: string
  /** 行为断言：可执行、可断言的行为清单（GWT 派生 / 裁判门禁 / MVP 完成标尺） */
  behavior_assertions?: string[]
  /** P0/P1/P2：P0 必须有断言覆盖并进行为门禁；缺省 F-001=P0、其余 P2 */
  priority?: 'P0' | 'P1' | 'P2'
  /** 单条范围排除（可空）：该项明确不做的事 */
  scope_notes?: string
  /** 来源：clarify | correction | iteration | auto */
  source?: string
  /** 提出者（向导补充可见，2026-08-27）：user=用户原话/点选；guide=向导 agent 自主补充。
   * 仅向导 confirm_requirements/generate_sketch 输出携带，需求确认弹窗据此标「向导补充」徽标。 */
  origin?: 'user' | 'guide'
  /**
   * 执行状态（judge 语义审查回写，2026-08-26 活背板）：未判定时缺省（渲染为未勾选）。
   * 迭代全量重生成时随 prd.json 重写自然清除——新产物未判定即无状态，语义自洽。
   */
  status?: RequirementStatus
  /** 状态备注（裁判证据 evidence，≤160 字） */
  status_note?: string
}

/** 功能项执行状态：与 judge-semantic 的逐项判定字面量保持一致。 */
export type RequirementStatus = 'implemented' | 'partial' | 'missing' | 'deviated' | 'unverified'

/** 执行状态中文标签（PRD 渲染 / loop 项目锚共用）。 */
export function requirementStatusLabel(status: RequirementStatus): string {
  switch (status) {
    case 'implemented':
      return '已实现'
    case 'partial':
      return '部分实现'
    case 'missing':
      return '未实现'
    case 'deviated':
      return '做偏'
    default:
      return '无法验证'
  }
}

/** 行为断言缺省兜底（§10 兼容：旧项无断言时保证 GWT 仍有可派生场景） */
export const DEFAULT_BEHAVIOR_ASSERTION = '该功能项在产物中可见且可交互'

/** 故事化描述读取：story 优先、description 兜底（§10 兼容）。 */
export function requirementStory(item: SketchRequirement): string {
  const story = item.story?.trim()
  return story ? story : item.description
}

/** 行为断言读取：过滤空串；缺失时回退默认断言（§10 兼容）。 */
export function requirementAssertions(item: SketchRequirement): string[] {
  const assertions = (item.behavior_assertions ?? []).map((value) => value.trim()).filter(Boolean)
  return assertions.length > 0 ? assertions : [DEFAULT_BEHAVIOR_ASSERTION]
}

/** 优先级读取：缺省 F-001（主题锚点）= P0、其余 P2（不触发 P0 门禁，保守兼容）。 */
export function requirementPriority(item: SketchRequirement): 'P0' | 'P1' | 'P2' {
  return item.priority ?? (item.id === 'F-001' ? 'P0' : 'P2')
}

// ---------------------------------------------------------------------------
// P3 迭代分级锚定（2026-09-04）：renderBackplaneAnchor + focusAnchorEnabled
// ---------------------------------------------------------------------------

/** 分级锚定总开关：BLOMA_FOCUS_ANCHOR——'0'=强制关；'1'=强制开；未设按模式缺省
 * longterm=on / quick=off（D7 连锁：quick 延迟敏感不分级，防漂移锦优先）。 */
export function focusAnchorEnabled(mode: ProjectMode): boolean {
  const raw = (process.env.BLOMA_FOCUS_ANCHOR ?? '').trim().toLowerCase()
  if (raw === '0' || raw === 'off' || raw === 'false') return false
  if (raw === '1' || raw === 'on' || raw === 'true') return true
  return mode === 'longterm'
}

/** 单条功能项的全文渲染（现状口径：故事+断言+范围排除+执行状态）——与 2026-09-04 前
 * buildAgentLoopSystemPrompt 内联渲染逐字同源；抽至模型层供分级与全量两路共用。 */
function renderRequirementFull(item: SketchRequirement): string {
  const assertions = requirementAssertions(item)
    .map((assertion) => `    - ${assertion}`)
    .join('\n')
  return (
    `- [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}` +
    (assertions ? `\n  行为断言：\n${assertions}` : '') +
    (item.scope_notes ? `\n  范围排除：${item.scope_notes}` : '') +
    (item.status ? `\n  执行状态：${requirementStatusLabel(item.status)}` : '')
  )
}

/** 未聚焦项的一行摘要（D3：只减细节不减锚——id+故事+优先级+断言计数保留，
 * loop 知道「还有这些东西」可主动自取；断言细节折叠，探针执行面不受影响）。 */
function renderRequirementSummary(item: SketchRequirement): string {
  const assertionCount = requirementAssertions(item).length
  const statusSuffix = item.status ? `，${requirementStatusLabel(item.status)}` : ''
  return `- [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}（断言 ${assertionCount} 条${statusSuffix}）——本轮未聚焦：保持现状勿重做，细节可 read prd.json 自取`
}

/**
 * 背板功能项清单渲染（P3 分级锚定，R1 口径：背板渲染归模型层）：
 *
 * - focus 为空/undefined：全量全文渲染——与既有 buildAgentLoopSystemPrompt 内联渲染
 *   逐字一致（字节级等价现状，回归锁锁定）；
 * - focus 非空：命中项全文（描述+断言+优先级），其余项一行摘要（id+故事+优先级+断言
 *   计数）——只减细节不减锚（D3）；P0 断言只裁注入不裁探针执行面（run_gwt_tests 仍跑全量）。
 */
// 完整程序阶段 2.5（2026-09-06 计算器案）：数据留存信号词——LLM 漏报 interface_spec
// 时的确定性兜底触发（历史/保存/持久/刷新或重开后仍在/清空/收藏/回顾/记录）。
const PERSISTENCE_SIGNAL_RE = /历史|保存|持久|刷新|重开|清空|收藏|回顾|记录/

/**
 * 确定性派生最小后端契约：功能项命中数据留存信号而 LLM 未产出 interface_spec 时，
 * 派生通用 records 资源端点（GET 列表 + POST 新增）——保证 server/routes 渠道被
 * 强制走通（终验存活检查 + 修复回流兜底），资源命名交由 loop 对齐业务。
 * 无信号 → undefined（纯展示产物零注入）。
 */
export function deriveInterfaceSpec(requirements: SketchRequirement[]): InterfaceEndpoint[] | undefined {
  const hasSignal = requirements.some((item) => PERSISTENCE_SIGNAL_RE.test(`${item.description} ${item.story ?? ''}`))
  if (!hasSignal) return undefined
  return [
    { endpoint: '/api/records', method: 'GET', request: '无', response: '{records:[…]}（业务资源，实现于 server/routes/，数据落 data/）' },
    { endpoint: '/api/records', method: 'POST', request: '{…业务字段}', response: '{ok:true,…}' },
  ]
}

export function renderBackplaneAnchor(backplane: PrdBackplane, focus?: string[]): string {
  const focusSet = focus && focus.length > 0 ? new Set(focus) : undefined
  const requirementsPart = backplane.requirements
    .map((item) => (focusSet ? (focusSet.has(item.id) ? renderRequirementFull(item) : renderRequirementSummary(item)) : renderRequirementFull(item)))
    .join('\n')
  // 完整程序阶段 2（2026-09-06）：后端 API 契约随锚定注入——前后端真相源，loop 每轮
  // 可见（聚焦模式不裁剪：契约是全局约束，条目少）。无 interface_spec（纯展示/旧背板）零注入。
  const endpoints = backplaneInterfaceSpec(backplane)
  if (endpoints.length === 0) return withCapSection(requirementsPart, backplane)
  const contract = endpoints
    .map((ep) => {
      const request = ep.request && ep.request !== '无' ? `；请求：${ep.request}` : ''
      return `- ${ep.method ?? 'GET'} ${ep.endpoint} → 响应：${ep.response ?? 'JSON'}${request}`
    })
    .join('\n')
  // A2（P0-A，2026-09-11 审计案 35c1a633）：路由模块契约显影——CJS 格式条款进锚。
  // 此前契约只写在 static-server.js 注释里（主 loop 从未读过），模型按前端同款 ESM
  // 写路由 → require SyntaxError 被 loadRoutes 静默吞掉 → 404。条款随契约段每轮可见。
  const moduleFormatClause =
    '路由文件模块格式（static-server 以 CommonJS require 加载，禁用 ESM import/export）：每个 server/routes/<资源>.js 写 `module.exports = { \'METHOD /path\': async (req, res, ctx) => {...} }`，键格式为 \'方法 路径\'，文件名即 /api/ 前缀（records.js → /api/records/*，样例见骨架 server/routes/_example.js）；数据用 ctx.readData/ctx.writeData 落 data/。'
  return withCapSection(
    `${requirementsPart}\n\n【后端 API 契约（interface_spec，前后端真相源）】按此实现 server/routes/ 下的路由并保持一致：\n${contract}\n${moduleFormatClause}`,
    backplane,
  )
}

/** Phase 2 M1：CAP 段随背板锚定常驻注入（每轮 system 内重建，竹节/keep-recent 压缩
 * 只动历史轮次动不到常驻锚——「压缩不得删 CAP」由结构保证）。开关 off 或无 CAP 零注入。 */
function withCapSection(anchor: string, backplane: PrdBackplane): string {
  if (!capContractEnabled()) return anchor
  const section = renderCapSection(backplaneAiCapabilities(backplane))
  return section ? `${anchor}\n\n${section}` : anchor
}

// ---------------------------------------------------------------------------
// 2026-09-02 P1 扩展字段读取侧兜底（旧 prd.json 零迁移；读取方一律经这些函数取值）
// ---------------------------------------------------------------------------

/** 页面清单读取：背板有 pages 用之（quick 限 ≤3，多出的截断；longterm 不截）；
 * 缺省从 requirements 前 3 项派生（名称=功能描述截断，用途=空）——旧背板兼容路径，
 * 草图引擎的 max_pages 语义由此升格承接。 */
export function backplanePages(backplane: PrdBackplane, mode: 'quick' | 'longterm' = 'quick'): PrdPage[] {
  if (backplane.pages && backplane.pages.length > 0) {
    const list = backplane.pages.filter((page) => page.name.trim().length > 0)
    return mode === 'quick' ? list.slice(0, 3) : list
  }
  return backplane.requirements.slice(0, 3).map((item) => ({
    name: item.description.replace(/\s+/g, ' ').trim().slice(0, 20) || item.id,
    purpose: '',
  }))
}

/** 术语表读取：缺省 []（非 longterm 必填章，缺省不阻断）。 */
export function backplaneGlossary(backplane: PrdBackplane): GlossaryEntry[] {
  return (backplane.glossary ?? []).filter((entry) => entry.term.trim() && entry.definition.trim())
}

/** 目标用户读取：缺省 []。 */
export function backplanePersonas(backplane: PrdBackplane): string[] {
  return (backplane.personas ?? []).map((p) => p.trim()).filter(Boolean)
}

/** 接口规格读取：缺省 []。 */
export function backplaneInterfaceSpec(backplane: PrdBackplane): InterfaceEndpoint[] {
  return (backplane.interface_spec ?? []).filter((ep) => ep.endpoint.trim().length > 0)
}

/** 类型→缺省硬约束等级（PRD 12.3：Web 全栈/桌面工具=standard，个人小工具=loose，AI 应用二期按 standard 预留）。 */
export function defaultConstraintLevel(type: TemplateType): ConstraintLevel {
  return type === 'personal_tool' ? 'loose' : 'standard'
}

/** 模板元信息读取：背板缺省时按项目 template_type 兜底构造（不回写；写入由注入点①负责）。 */
export function backplaneTemplateMeta(metaSource: Pick<PrdBackplane, 'template_meta'>, projectTemplateType: TemplateType): TemplateMeta {
  if (metaSource.template_meta) return metaSource.template_meta
  return { type: projectTemplateType, level: defaultConstraintLevel(projectTemplateType), version: TEMPLATE_META_VERSION }
}

/** 章节 provenance 读取：缺省 {}（未标注章节视为未声明，内审如实呈现不臆断）。 */
export function backplaneSectionProvenance(backplane: PrdBackplane): Partial<Record<PrdSectionId, SectionProvenance>> {
  return backplane.section_provenance ?? {}
}

/** 全局 UX 契约（§4.2）：本轮用户确认过的草图（仅「用户确认 + 非模板回退」时存在）。 */
export interface UxContract {
  /** 草图文件相对路径（相对 documents/{project_id}/，如 sketch.html） */
  sketch_rel_path: string
  /** 用户确认时间 */
  confirmed_at: string
}

/** MVP 生成护栏（§3.2）：MUST DO / MUST NOT DO，可被 normalizer/评审追加。 */
export interface GenerationGuardrails {
  must_do: string[]
  must_not_do: string[]
}

/**
 * PRD 背板——快消型的唯一需求事实源。
 *
 * 由 DocumentEngine 在检查点产出并冻结，供三类下游复用同一份锚点：
 * - MVP 生成（mvp-engine-llm 读定位/功能项/范围外，防"货不对板"）；
 * - GWT 派生（按 acceptance 生成场景）；
 * - 裁判校验 / 意图识别（按功能项与产物对照判定"是否货不对板"）。
 *
 * F-001 固定为"主题锚点"（用户最初想做什么），澄清/纠错/迭代只追加后续项、不覆盖主题。
 */
export interface PrdBackplane {
  project_id: string
  name: string
  /** 产品定位一句话（主题锚点，取自 F-001 描述） */
  positioning: string
  /** 核心功能项：F-001 为主题，其余为澄清/纠错/迭代追加项 */
  requirements: SketchRequirement[]
  /** 功能项 id → 验收要点（行为断言迁入 requirements 后逐步废弃；保持兼容） */
  acceptance: Record<string, string>
  /** 本轮明确不做的事（防模型擅自扩功能；含 normalizer 判定的范围声明） */
  out_of_scope: string[]
  /**
   * 用户声明的约束（T4-L1：「不含登录」「必须离线可用」，排除与要求类皆可）：
   * 来自 project.constraints（澄清门/修改门确定性提取），随背板常驻注入
   * 生成/归一化/意图分流——首轮约束 >30 轮仍生效的结构性保证。
   */
  constraints?: string[]
  /** 后台决策假设（assumptions，供 decisions 回溯） */
  assumptions: string[]
  /** 全局 UX 契约（§4.2）：仅「用户确认 + 非模板回退」的草图才登记 */
  ux_contract?: UxContract
  /** MVP 生成护栏（§3.2）：MUST DO / MUST NOT DO */
  generation_guardrails?: GenerationGuardrails
  /** 冻结时间（mvp_before_generation 时落盘；草案阶段为 undefined） */
  frozen_at?: string
  /** 用户阅读确认时间（PRD 确认卡「确认无误」时落盘，2026-08-26）——迭代争议仲裁锚点 */
  user_confirmed_at?: string

  // ---- 以下为 2026-09-02 周计划 §5 P1 扩展字段（方案 §3.1）：全可选 + 读取侧兜底，
  // 旧 prd.json 零迁移（沿用 requirementStory 模式，陷阱 19/42 经验）；
  // 不动 requirements/behavior_assertions/out_of_scope/constraints/generation_guardrails
  // 的字段语义（内审闭环锚，方案 §3.2 纪律）。 ----

  /** 页面清单（两模式全量；quick 限 ≤3）。缺省时读取侧从 requirements 前 3 项派生（兼容旧背板）。 */
  pages?: PrdPage[]
  /** 术语表（longterm）。缺省 []。 */
  glossary?: GlossaryEntry[]
  /** 目标用户（longterm；12.4 标准级「目标用户」行）。缺省 []。 */
  personas?: string[]
  /** 数据模型（longterm）。缺省 undefined（选填章节）。 */
  data_model?: DataModelSpec
  /** 接口规格（longterm 标准级起；12.4「API Spec」行）。缺省 []。 */
  interface_spec?: InterfaceEndpoint[]
  /** 模板元信息（两模式全量；注入点① choosing_mode 判定写入）。缺省按项目 template_type 兜底。 */
  template_meta?: TemplateMeta
  /** 章节级 provenance（每章节生成时标注；内审 F 维对照源）。缺省 {}（未标注章节视为未声明）。 */
  section_provenance?: Partial<Record<PrdSectionId, SectionProvenance>>
  /**
   * 完整长文本 PRD 全文（2026-09-03 需求工程链归向导：工程腿与结构化字段同调用产出的
   * 用户确认版文档，导师意见「PRD 齐备并真正约束工程」的落地形态）。
   * 消费链路：PRD 确认卡主展示对象 + MVP loop 背板锚定段全文常驻注入。
   * 缺省 undefined（旧 prd.json 零迁移）；读取/降级侧经 buildPrdDocumentFallback
   * 机械拼装兜底（确定性投影，不编内容——OpenSpec 纪律）。
   */
  prd_document?: string
  /**
   * 轻量 GDD（游戏设计文档，P1-7，2026-09-04）：game 类型的玩法真相源——IP 复刻/游戏类
   * 需求的机制拆解/核心循环/数值基准，PRD 从 GDD 切片、不发明机制。
   * 仅 game 类型生成（非 game 缺省 undefined）；缺省无 GDD（旧 prd.json 零迁移）。
   */
  gdd?: GameDesignDoc
  /**
   * 能力契约块（Phase 2 M1，2026-09-09）：AI/智能类能力的硬条款——任务/关键处理/
   * 输入输出依赖/禁止降级替代/验收证据/来源。向导工程腿产出或 deriveAiCapabilities
   * 确定性派生；loop 锚定、裁判判定、PRD 确认卡三处消费（BLOMA_CAP_CONTRACT 缺省 off
   * =本字段不产出不注入，旧 prd.json 零迁移）。
   */
  ai_capabilities?: AiCapability[]
  /**
   * 关键任务块（Phase 7 U1 H2，2026-09-10）：用户语言的交付标尺——这一版做完
   * 什么才算交付。工程腿产出（LLM 优先 + finalizeKeyTasks P0 补齐）随背板冻结；
   * PRD 确认卡展示、delivery_status 计算（P7-2）消费（BLOMA_KEY_TASKS 缺省 off
   * =不产出，旧 prd.json 零迁移）。
   */
  key_tasks?: KeyTask[]
}

/**
 * 轻量 GDD 四要素（P1-7）：核心幻想（玩什么）+ 设计支柱（凭什么好玩）+ 核心循环
 * （怎么玩）+ 数值基准（数值真相源）。由向导工程腿对 game 类型从对话提炼。
 */
export interface GameDesignDoc {
  /** 核心幻想：玩家扮演什么、体验什么（一句话）。 */
  core_fantasy: string
  /** 设计支柱：支撑核心幻想的 2-3 条原则。 */
  pillars: string[]
  /** 核心循环：主玩法循环的阶段序列（如 探索→战斗→收集→升级）。 */
  core_loop: string[]
  /** 数值基准：关键数值/范围（生命值/得分/关卡数/道具池范围等）。 */
  numbers: string[]
}

/**
 * 长文本 PRD 机械拼装兜底（2026-09-03）：工程腿 document 缺失/降级时由结构化字段
 * 确定性拼装。供 prd-engine-llm 解析降级与 document-engine 确定性模板两路共用，
 * 单一拼装口径；只投影既有事实，绝不生成新内容。
 */
export function buildPrdDocumentFallback(input: {
  positioning: string
  requirements: SketchRequirement[]
  acceptance?: Record<string, string>
  out_of_scope: string[]
  assumptions: string[]
  constraints?: string[]
}): string {
  const lines: string[] = [
    `# PRD：${input.positioning}`,
    '',
    '（编者注：本文件由结构化背板机械拼装生成（LLM 长文本生成不可用时的确定性兜底），内容与 prd.json 同源。）',
    '',
    '## 一、产品定位',
    input.positioning,
    '',
    '## 二、用户故事与功能需求详述',
  ]
  for (const item of input.requirements) {
    lines.push(`### [${item.id}]（${requirementPriority(item)}）${requirementStory(item)}`)
    const acceptance = input.acceptance?.[item.id]?.trim()
    if (acceptance) lines.push(`验收要点：${acceptance}`)
    for (const assertion of requirementAssertions(item)) lines.push(`- ${assertion}`)
    lines.push('')
  }
  lines.push('## 三、用户约束', ...(input.constraints?.length ? input.constraints.map((entry) => `- ${entry}`) : ['- 无特殊约束']), '')
  lines.push('## 四、范围外', ...(input.out_of_scope.length ? input.out_of_scope.map((entry) => `- ${entry}`) : ['- 本轮无明确排除项']), '')
  lines.push('## 五、后台假设', ...(input.assumptions.length ? input.assumptions.map((entry) => `- ${entry}`) : ['- 无']))
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 2026-09-04 P1-4/P1-5/P1-6：prd_document 清洗与同源校正、占位断言识别
// ---------------------------------------------------------------------------

/**
 * 占位断言识别（P1-6）：模型偷懒写「该功能项在产物中可见且可交互」这类等于没断言的
 * 存在性泛化表述。判据：命中泛化词族（可见/可交互/可访问/能正常…），且整条不含任何
 * 触发→效果结构（→/点击/按/输入/选择/双击…）——真正的行为断言一定带触发与效果。
 * enricher 剔除（stripDefaultAssertions 升级）+ GWT 派生拦截两处共用同一判据。
 */
export function isPlaceholderAssertion(assertion: string): boolean {
  const text = assertion.trim()
  if (!text) return true
  if (text === DEFAULT_BEHAVIOR_ASSERTION) return true
  const hasGenericPresence = /(可见|可交互|可访问|能正常|可使用|可用|可操作|能运行|正常显示|正常使用|已实现|功能入口|入口存在)/.test(text)
  const hasBehaviorAxis = /(→|后|当|则|点击|按|输入|键入|选择|双击|切换|拖动|滚动|新增|隐藏|显示|消失|出现|变化|更新)/.test(text)
  return hasGenericPresence && !hasBehaviorAxis
}

/**
 * prd_document 换行双重转义还原（P1-4）。
 * 模型把 prompt 要求的 `\n` 又转义一次输出 `\\n`，JSON.parse 后落盘的是字面「反斜杠+n」
 * （非真换行），prd_document 全文变单行、确认卡与 loop 锚注入拿到不可读文本。
 * 只还原字面两字符序列（反斜杠+n），不误伤 JSON.parse 后已是真换行的正常输出。
 */
export function normalizePrdDocumentNewlines(document: string): string {
  return document.replace(/\\n/g, '\n')
}

/**
 * document 与结构化字段的 priority 同源校正（P1-5）。
 * LLM 在 document 功能详述节里自标 P0/P1，与 requirements 冻结字段的 priority（缺省
 * F-001=P0、其余 P2）不一致——下游两套口径。此处按结构化字段覆盖 document 里
 * `[F-xxx]（P0/P1/P2）` 标题标注，使优先级与背板真相源一致。
 */
export function reconcilePrdDocumentPriorities(document: string, requirements: SketchRequirement[]): string {
  const priorityById = new Map(requirements.map((item) => [item.id, requirementPriority(item)]))
  return document.replace(/(\[F-\d+\])\s*[（(](P[0-2])[）)]/g, (match, idPart: string, current: string) => {
    const id = idPart.replace(/[\[\]]/g, '')
    const target = priorityById.get(id)
    if (!target || target === current) return match
    return `${idPart}（${target}）`
  })
}

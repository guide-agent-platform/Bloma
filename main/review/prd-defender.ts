/**
 * PRD 内审 Defender（修订者）子系统——AC-Lite 内审闭环的核心新增件，2026-09-01。
 *
 * 方法论来源：2026-08-30 组会决议 4（补齐内审角色）+ 设计稿《内审机制最小设计》§3.1。
 * 现状（743c138）审查「只攻不守」：issues 甩给用户决策卡，生成者从不自改——
 * 裁判≠内审（周老师原话）、用户替模型打工。Defender 把「自查自改」的环闭上：
 * 攻击轮发现 blocking/major 后，先由修订者子 agent 按约束改出 PRD 草稿，
 * 复核轮通过才上用户过目卡（用户看到的是「已内审 + 残留问题知情」）。
 *
 * 物理边界（铁律用工具面与代码双保险，不信提示词）：
 * - 工具面：research 只读 + 唯一写权限 write_prd_draft——只写**内存草稿副本**，
 *   不碰盘上 requirement_confirmed 检查点（修订稿必须重走用户过目门，
 *   user_confirmed_at 不继承——对齐陷阱 19/42）。
 * - 产物校验（validateDefenderDraft，代码级、不信任模型自报）：
 *   ① 背板 schema（必填形状 + requirements 项形状）；
 *   ② F-001 主题锚点 description 逐字不变；
 *   ③ 原 id 集不可减（已确认清单不可删项）；
 *   ④ 新增 id ⊆ {nextRequirementId(原)}（max+1 语义，至多补一个闭环项，不猜号）；
 *   ⑤ 每条 issue 必须有处置（fixed/rejected + 说明）；
 *   ⑥ user_confirmed_at 等确认状态字段强制剥除（不继承）。
 *   违规即 Defender 轮失败 → 内审视为未收敛 → 走用户知情决策卡。
 */

/**
 * PRD 内审 Defender（修订者）子系统——AC-Lite 内审闭环的核心新增件，2026-09-01。
 *
 * 方法论来源：2026-08-30 组会决议 4（补齐内审角色）+ 设计稿《内审机制最小设计》§3.1。
 * 现状（743c138）审查「只攻不守」：issues 甩给用户决策卡，生成者从不自改——
 * 裁判≠内审（周老师原话）、用户替模型打工。Defender 把「自查自改」的环闭上：
 * 攻击轮发现 blocking/major 后，先由修订者子 agent 按约束改出 PRD 草稿，
 * 复核轮通过才上用户过目卡（用户看到的是「已内审 + 残留问题知情」）。
 *
 * 物理边界（铁律用工具面与代码双保险，不信提示词）：
 * - 工具面：research 只读 + 唯一写权限 write_prd_draft——只写**内存草稿副本**，
 *   不碰盘上 requirement_confirmed 检查点（修订稿必须重走用户过目门，
 *   user_confirmed_at 不继承——对齐陷阱 19/42）。
 * - 产物校验（validateDefenderDraft，代码级、不信任模型自报）：
 *   ① 背板 schema（必填形状 + requirements 项形状）；
 *   ② F-001 主题锚点 description 逐字不变；
 *   ③ 原 id 集不可减（已确认清单不可删项）；
 *   ④ 新增 id ⊆ {nextRequirementId(原)}（max+1 语义，至多补一个闭环项，不猜号）；
 *   ⑤ 每条 issue 必须有处置（fixed/rejected + 说明）；
 *   ⑥ user_confirmed_at 等确认状态字段强制剥除（不继承）。
 *   违规即 Defender 轮失败 → 内审视为未收敛 → 走用户知情决策卡。
 */
import type { PrdBackplane, SketchRequirement } from "../model/prd-backplane";
import { nextRequirementId } from "../model/requirement-utils";
import type { PrdReviewIssue } from './prd-review'
import { reconcileAcceptanceRevision } from '../project/requirement-contract'
import { buildPrdDocumentFallback } from '../model/prd-backplane'
import { parseOrganizedRequirements, projectRequirementsModel, validateRequirementsModel } from '../model/requirements-model'

// =========================================================================
// Defender system prompt
// =========================================================================

export const DEFENDER_SYSTEM_PROMPT = [
  '你是文档修订者（Defender）——PRD 内审闭环的修复角色。攻击者（Attacker）刚对一份 PRD 完成了六维攻击审查，你要在铁律约束内修订 PRD、逐条处置问题。',
  '',
  // P5 术语纪律（2026-09-04）：与 loop/裁判同源词表，措辞按修订者角色微调；
  // 只约束叙述用词，JSON 契约字段名零变更
  '【术语纪律】处置说明与修订文案使用以下规范词，禁止同义漂移（不得混用右侧同义词）：' +
  '功能项（非"需求点/feature"）、断言（非"验收点"）、场景（非"用例/test case"）、' +
  '探针（非"测试脚本/自动化测试"）、骨架（非"模板项目/脚手架"）、背板（非"PRD 文档/需求文档"）、' +
  '修复轮（非"重试/返工"）。JSON 字段与枚举值不变，只约束文字表述。',
  '',
  '【铁律（违反即整轮作废）】',
  '- 旧版（无 requirements_model）F-001 是主题锚点，不改 description；新版 F-001 是独立能力，目标在 requirements_model.goal，编号不得换义或按位置重排',
  '- 已有功能项一个都不能删（id 不许消失）；description 只许澄清措辞、不许偷换语义；id 不许重复（重复会使校验歧义，整稿作废）',
  '- 旧版新增功能至多一个，用 next_id；新版允许补齐用户已经要求的多项能力，从 next_id 连续递增，并同步流程、规则、场景和来源覆盖，不能扩用户范围',
  '- assumptions 可修订，但新增假设须公开，不得伪装成用户约束。requirements_model 的 sources 原文不可改；acceptance/document 由宿主生成，不另写一套',
  '- 不新增用户没说过的功能、不扩范围（out_of_scope 只许加不许减）',
  '- constraints（用户约束）原样保留：不许删也不许新增——约束只能来自用户原话，修订者无权代用户声明',
  '- 不虚构用户原话：拿不准就保留原文，在处置说明里写 rejected',
  '- 修订完成后必须调用 write_prd_draft 提交完整修订背板与逐条处置，只在文本里描述改动不算交付',
  '',
  '【处置口径】每条 issue 二选一：',
  '- fixed：改了什么、改在哪个字段（须可在修订背板中指认）',
  '- rejected：为什么不改（如审查误报、与用户原话冲突），留给复核轮仲裁',
  '',
  '【输出】先逐条给出处置结论（人话），最后调用 write_prd_draft（参数：backplane=修订后完整背板 JSON，dispositions=逐条处置数组）。',
].join('\n')

// =========================================================================
// 类型
// =========================================================================

/** 每条攻击 issue 的处置（Defender 自报，复核轮仲裁）。 */
export interface DefenderDisposition {
  issue_index: number
  action: 'fixed' | 'rejected'
  note: string
}

/** Defender 轮产物：修订背板草稿 + 逐条处置（已过代码级校验）。 */
export interface DefenderDraft {
  backplane: PrdBackplane
  dispositions: DefenderDisposition[]
  write_report?: { accepted_fields: string[]; rejected_fields: string[] }
}

export type DefenderOutcome =
  | { ok: true; draft: DefenderDraft }
  | { ok: false; failure: 'no_draft' | 'invalid' | 'aborted' | 'delegation_failed'; violations?: string[] }

/** Defender 轮失败原因（内审元数据留痕用）。 */
export type DefenderFailure = Extract<DefenderOutcome, { ok: false }>['failure']

// =========================================================================
// write_prd_draft 工具（唯一写权限：内存草稿副本）
// =========================================================================

/**
 * 构造 Defender 的唯一写工具。草稿进闭包变量（内存副本），绝不写盘——
 * requirement_confirmed 检查点上的 prd.json 不被触碰，修订稿重走用户过目门。
 */
export function buildWritePrdDraftTool(onDraft: (draft: DefenderDraft) => void, original?: PrdBackplane): {
  tool: import('../agent/loop/agent-loop').AgentLoopTool
  hasDraft: () => boolean
} {
  let submitted = false
  return {
    hasDraft: () => submitted,
    tool: {
      name: 'write_prd_draft',
      description:
        '提交修订后的完整 PRD 背板草稿与逐条处置（这是你唯一的写权限：只进草稿副本，不直接生效；' +
        '系统会做代码级校验，违规整轮作废）。参数：backplane（修订后完整背板 JSON 对象）、' +
        'dispositions（每条 issue 的处置数组：issue_index 从 1 起、action=fixed|rejected、note=说明）。',
      input_schema: {
        type: 'object',
        properties: {
          backplane: { type: 'object', description: '修订后完整背板 JSON（保持原字段结构）' },
          dispositions: {
            type: 'array',
            description: '逐条处置：与任务给出的 issues 清单一一对应',
            items: {
              type: 'object',
              properties: {
                issue_index: { type: 'number', description: 'issue 序号（从 1 起）' },
                action: { type: 'string', enum: ['fixed', 'rejected'] },
                note: { type: 'string', description: '改了什么/为什么不改（≤120 字）' },
              },
              required: ['issue_index', 'action', 'note'],
            },
          },
        },
        required: ['backplane', 'dispositions'],
      },
      execute: async (toolInput) => {
        if (submitted) {
          return { output: '草稿已提交过，无需重复提交。请直接输出处置总结收尾。', isError: true }
        }
        const backplane = toolInput.backplane
        const dispositions = toolInput.dispositions
        if (!backplane || typeof backplane !== 'object' || !Array.isArray(dispositions)) {
          return { output: '参数不完整：需要 backplane 对象与 dispositions 数组。', isError: true }
        }
        const validated = original ? validateDefenderDraft(original, backplane) : undefined
        if (validated && !validated.ok) return { output: `草稿未接收：${validated.violations.join('；')}。请修订后重新提交。`, isError: true }
        submitted = true
        onDraft({ backplane: validated?.ok ? validated.draft.backplane : backplane as unknown as PrdBackplane, dispositions: parseDispositions(dispositions),
          ...(validated?.ok ? { write_report: validated.draft.write_report } : {}) })
        return {
          output: `草稿已接收（内存副本，未写盘，仍须复核与确认）。${validated?.ok ? `字段处理：${JSON.stringify(validated.draft.write_report)}` : '系统将继续校验结构。'}请输出逐条处置总结收尾。`,
        }
      },
    },
  }
}

function parseDispositions(raw: unknown[]): DefenderDisposition[] {
  const out: DefenderDisposition[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const action = record.action === 'fixed' || record.action === 'rejected' ? record.action : undefined
    const index = Number(record.issue_index)
    if (!action || !Number.isFinite(index)) continue
    out.push({ issue_index: index, action, note: String(record.note ?? '').slice(0, 160) })
  }
  return out
}

// =========================================================================
// 代码级校验（不信任模型）
// =========================================================================

/** 修订背板强制剥除的字段：用户行为事实与冻结语义不继承（陷阱 19/42 口径；frozen_at 防 Defender 伪造冻结）。 */
const NON_INHERITABLE_FIELDS = ['user_confirmed_at', 'sketch_confirmed_at', 'frozen_at'] as const

/**
 * PrdBackplane 全部合法顶层字段（与 sketch-engine.ts 类型同步维护）。
 * Defender 修订稿白名单构造的依据：未知键一律拒收，受保护字段只继承 original。
 */
const BACKPLANE_KNOWN_FIELDS = new Set([
  'project_id', 'name', 'positioning', 'requirements', 'acceptance', 'acceptance_bindings',
  'out_of_scope', 'constraints', 'assumptions', 'ux_contract', 'generation_guardrails',
  'frozen_at', 'user_confirmed_at', 'sketch_confirmed_at',
  'pages', 'glossary', 'personas', 'data_model', 'interface_spec', 'template_meta', 'section_provenance',
  'prd_document', 'gdd', 'shape', 'ux', 'ai_capabilities', 'key_tasks',
  'requirements_model',
])

export function validateDefenderDraft(original: PrdBackplane, raw: unknown): { ok: true; draft: DefenderDraft } | { ok: false; violations: string[] } {
  const violations: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, violations: ['背板必须是 JSON 对象'] }
  }
  const draft = raw as Record<string, unknown>
  const hasModel = Boolean(original.requirements_model)

  // ① schema：必填形状（name/positioning 非空串、requirements 非空数组、每项 id+description）
  if (typeof draft.name !== 'string' || !draft.name.trim()) violations.push('name 缺失或为空')
  if (typeof draft.positioning !== 'string' || !draft.positioning.trim()) violations.push('positioning 缺失或为空')
  const requirements = draft.requirements
  if (!Array.isArray(requirements) || requirements.length === 0) {
    violations.push('requirements 缺失或为空数组')
  } else {
    for (const [index, item] of requirements.entries()) {
      if (!item || typeof item !== 'object') {
        violations.push(`requirements[${index}] 不是对象`)
        continue
      }
      const record = item as Record<string, unknown>
      if (typeof record.id !== 'string' || !/^F-\d+$/.test(record.id)) violations.push(`requirements[${index}].id 非法（须 F-xxx）`)
      if (typeof record.description !== 'string' || !record.description.trim()) violations.push(`requirements[${index}].description 为空`)
      if (record.behavior_assertions !== undefined && (!Array.isArray(record.behavior_assertions) || record.behavior_assertions.some(value => typeof value !== 'string'))) violations.push(`requirements[${index}].behavior_assertions 必须是字符串数组`)
      if (record.story !== undefined && typeof record.story !== 'string') violations.push(`requirements[${index}].story 必须是字符串`)
      if (record.scope_notes !== undefined && typeof record.scope_notes !== 'string') violations.push(`requirements[${index}].scope_notes 必须是字符串`)
      if (record.priority !== undefined && !['P0', 'P1', 'P2'].includes(record.priority as string)) violations.push(`requirements[${index}].priority 非法`)
    }
  }

  const originalIds = new Set((original.requirements ?? []).map((item) => item.id))
  const draftItems: SketchRequirement[] = Array.isArray(requirements) ? (requirements as SketchRequirement[]) : []
  const draftIds = draftItems.map((item) => item?.id)
  for (const field of ['assumptions', 'constraints', 'out_of_scope']) {
    if (draft[field] !== undefined && (!Array.isArray(draft[field]) || (draft[field] as unknown[]).some(value => typeof value !== 'string'))) violations.push(`${field} 必须是字符串数组`)
  }
  if (hasModel) {
    const model = draft.requirements_model ?? original.requirements_model
    violations.push(...validateRequirementsModel(model, draftItems))
    if (JSON.stringify((model as PrdBackplane['requirements_model'])?.sources) !== JSON.stringify(original.requirements_model?.sources)) violations.push('requirements_model.sources 原始来源不可改写')
  }

  // ①′ id 唯一性：重复 id 使锚点/删项/新增三道校验全部歧义（结构性穿透），一律拒收
  const duplicateIds = [...new Set(draftIds.filter((id, index) => draftIds.indexOf(id) !== index))]
  if (duplicateIds.length > 0) {
    violations.push(`功能项 id 重复（${duplicateIds.join(', ')}）：锚点/删项/新增语义无法判定，整稿拒收`)
  }

  // ② F-001 主题锚点不变（id 存在 + description 逐字一致）
  const anchorOriginal = (original.requirements ?? []).find((item) => item.id === 'F-001')
  const anchorDraft = draftItems.find((item) => item.id === 'F-001')
  if (!hasModel && (!anchorOriginal || !anchorDraft)) {
    violations.push('F-001 主题锚点缺失')
  } else if (!hasModel && anchorOriginal && anchorDraft && anchorOriginal.description !== anchorDraft.description) {
    violations.push(`F-001 主题锚点 description 被改动（原：「${anchorOriginal.description.slice(0, 60)}」）`)
  }

  // ③ 原 id 不可删（已确认清单不可减）
  for (const id of originalIds) {
    if (!draftIds.includes(id)) violations.push(`已有功能项 ${id} 被删除（已确认清单不可减）`)
  }

  // ③′ constraints 不许替用户新增（与 out_of_scope「只许加」对称的反向保护：
  //    约束只能来自用户原话（澄清门/修改门提取），伪造约束会结构性限制后续所有生成）
  const draftConstraintList = Array.isArray(draft.constraints)
    ? (draft.constraints as unknown[]).map((item) => String(item).trim())
    : []
  const originalConstraintSet = new Set((original.constraints ?? []).map((item) => item.trim()))
  const forgedConstraints = [...new Set(draftConstraintList.filter((item) => item && !originalConstraintSet.has(item)))]
  if (forgedConstraints.length > 0) {
    violations.push(`constraints 新增了用户未声明的约束（${forgedConstraints.join('；')}）：约束只能来自用户原话`)
  }

  // ③″ 顶层未知键一律拒收（防伪造任意元数据渗透下游：渲染/落盘全量 stringify 不过滤）
  const unknownKeys = Object.keys(draft).filter((key) => !BACKPLANE_KNOWN_FIELDS.has(key))
  if (unknownKeys.length > 0) {
    violations.push(`背板含未知字段（${unknownKeys.join(', ')}）：修订稿只允许背板合法字段`)
  }

  // ④ 新增 id ⊆ {nextRequirementId(原)}（max+1 语义、单一新增，不猜号）
  const allowedNewId = nextRequirementId(original.requirements ?? [])
  const newIds = draftIds.filter((id) => !originalIds.has(id))
  const nextNumber = Number(allowedNewId.slice(2))
  const validNewIds = hasModel
    ? newIds.every((id, index) => id === `F-${String(nextNumber + index).padStart(3, '0')}`)
    : newIds.length <= 1 && (!newIds.length || newIds[0] === allowedNewId)
  if (!validNewIds) {
    violations.push(`新增功能项 id 非法（${newIds.join(', ') || '无'}）：仅允许新增 ${allowedNewId} 一个项`)
  }

  // ⑤ dispositions 完整性（在 runDefenderRevision 层校验 issue 覆盖，此处只定形）
  if (violations.length > 0) return { ok: false, violations }

  // ⑥ 确认状态字段强制剥除（不继承）；执行状态同样重置（新草稿未判定）
  for (const field of NON_INHERITABLE_FIELDS) delete draft[field]
  for (const item of draftItems) {
    delete (item as Partial<SketchRequirement>).status
    delete (item as Partial<SketchRequirement>).status_note
  }

  // 白名单构造：以 original 为权威底稿展开，只允许 Defender 改写其修订域字段。
  // generation_guardrails/ux_contract/frozen_at/acceptance/assumptions/P1 扩展字段一律
  // 继承 original（draft 携带的伪造值在构造中被丢弃——落盘链全量 stringify 不过滤，
  // 伪造护栏会直接操纵后续 MVP 生成）；user_confirmed_at 剥除语义不变（重走确认门）。
  const cleaned: PrdBackplane = {
    ...original,
    name: typeof draft.name === 'string' && draft.name.trim() ? draft.name : original.name,
    positioning: typeof draft.positioning === 'string' && draft.positioning.trim() ? draft.positioning : original.positioning,
    requirements: draftItems,
    assumptions: Array.isArray(draft.assumptions) ? draft.assumptions as string[] : original.assumptions,
    ...(hasModel ? { requirements_model: (draft.requirements_model ?? original.requirements_model) as PrdBackplane['requirements_model'] } : {}),
    // 修订轮不改这两类声明域的语义：out_of_scope 只许加不许减、约束不许删不许伪造新增
    out_of_scope: mergeOutofScope(original.out_of_scope ?? [], (draft.out_of_scope as string[]) ?? []),
    constraints: mergeConstraints(original.constraints ?? [], (draft.constraints as string[]) ?? []),
  }
  delete cleaned.user_confirmed_at
  delete cleaned.frozen_at
  if (hasModel) {
    const organized = parseOrganizedRequirements(cleaned, original.requirements_model!.sources)
    if (!organized) return { ok: false, violations: ['修订后的需求模型与验收场景无效'] }
    cleaned.requirements = organized.requirements
    cleaned.requirements_model = organized.model
  }
  let reconciled = reconcileAcceptanceRevision(original, cleaned)
  if (hasModel) {
    // A changed business scenario is a changed acceptance contract even when the feature description is stable.
    reconciled = reconcileAcceptanceRevision({ ...original, acceptance: {}, acceptance_bindings: {} }, cleaned)
    reconciled = projectRequirementsModel(reconciled)
  } else reconciled.prd_document = buildPrdDocumentFallback(reconciled)
  const accepted_fields = ['name', 'positioning', 'requirements', 'assumptions', 'out_of_scope', 'constraints', ...(hasModel ? ['requirements_model'] : [])]
  const rejected_fields = Object.keys(draft).filter(field => !accepted_fields.includes(field) && JSON.stringify(draft[field]) !== JSON.stringify((original as unknown as Record<string, unknown>)[field]))
  return { ok: true, draft: { backplane: reconciled, dispositions: [], write_report: { accepted_fields, rejected_fields } } }
}

/** out_of_scope 白名单合并：只允许追加（防「偷偷把不做的事又拿回来做」）。 */
function mergeOutofScope(original: string[], draft: string[]): string[] {
  const seen = new Set(original.map((item) => item.trim()))
  return [...original, ...draft.filter((item) => {
    const key = item.trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })]
}

/** 用户声明的约束不许删（T4-L1：结构性保证，删了就是违规修订）。 */
function mergeConstraints(original: string[], draft: string[]): string[] {
  const draftSet = new Set(draft.map((item) => item.trim()))
  const dropped = original.filter((item) => item.trim() && !draftSet.has(item.trim()))
  return dropped.length > 0 ? original : draft
}

/** dispositions 覆盖校验：每条 serious issue（blocking/major）必须有处置。 */
export function validateDispositionCoverage(
  dispositions: DefenderDisposition[],
  seriousIssues: PrdReviewIssue[],
): { ok: true } | { ok: false; violations: string[] } {
  if (seriousIssues.length === 0) return { ok: true }
  const covered = new Set(dispositions.filter((item) => item.action === 'fixed' || item.action === 'rejected').map((item) => item.issue_index))
  const missing: number[] = []
  seriousIssues.forEach((_, index) => {
    if (!covered.has(index + 1)) missing.push(index + 1)
  })
  if (missing.length > 0) {
    return { ok: false, violations: [`issues 未逐条处置：缺第 ${missing.join(', ')} 条的处置说明`] }
  }
  return { ok: true }
}

// =========================================================================
// Defender 任务体
// =========================================================================

export function buildDefenderTask(opts: {
  backplane: PrdBackplane
  issues: PrdReviewIssue[]
  confirmedRequirements: Array<{ id: string; description: string }>
  conversationExcerpt?: string
  /** 裁决口径过滤后的 serious 列表（D1/mode 开关）；缺省时按 blocking/major 过滤（兼容旧调用）。 */
  seriousOverride?: PrdReviewIssue[]
}): string {
  const { backplane, issues, confirmedRequirements } = opts
  const serious = opts.seriousOverride ?? issues.filter((issue) => issue.severity === 'blocking' || issue.severity === 'major')
  const nextId = nextRequirementId(backplane.requirements ?? [])
  const lines: string[] = [
    '【原 PRD 背板 JSON（修订底稿）】',
    JSON.stringify(
      backplane,
      null,
      2,
    ),
    '',
    '【用户确认的需求清单（不可删改语义，只许澄清措辞）】',
    confirmedRequirements.length
      ? confirmedRequirements.map((item) => `- ${item.id}: ${item.description}`).join('\n')
      : '- （无已确认清单）',
    '',
    `【攻击轮发现的 blocking/major 问题（逐条处置，序号即 issue_index）】`,
    serious.length
      ? serious.map((issue, index) => `${index + 1}. [${issue.dimension}/${issue.severity}] ${issue.claim}（位置：${issue.location || '未标注'}；证据：${issue.evidence.join('；') || '无'}）`).join('\n')
      : '- （无——正常情况下不会进入修订轮）',
    '',
    `【next_id（唯一允许的新增功能项 id）】${nextId}`,
  ]
  if (opts.conversationExcerpt) {
    lines.push('', opts.conversationExcerpt)
  }
  lines.push(
    '',
    '现在按铁律修订背板：先想清楚每条 issue 怎么处置（fixed/rejected），然后调用 write_prd_draft 提交完整修订背板与 dispositions，最后输出逐条处置总结。',
  )
  return lines.join('\n')
}

import type { PrdBackplane, SketchRequirement } from './prd-backplane'

/** Sources belong to the host; the model may reference them but may not invent user statements. */
export interface RequirementSource { id: string; text: string }
export interface RequirementsModel {
  version: 1
  goal: string
  target_users: string[]
  sources: RequirementSource[]
  entities: Array<{ id: string; name: string; description: string; attributes: string[] }>
  relations: Array<{ from: string; to: string; description: string }>
  workflows: Array<{ id: string; name: string; steps: string[]; feature_ids: string[] }>
  rules: Array<{ id: string; statement: string; feature_ids: string[]; source_ids: string[]; origin: 'user' | 'assumption' }>
  scenarios: Array<{
    id: string; feature_id: string; kind: 'normal' | 'boundary' | 'exception'
    given?: string; when?: string; then?: string; not_applicable?: string; rule_ids: string[]
  }>
  coverage: Array<{
    source_id: string; feature_ids: string[]; rule_ids: string[]
    disposition: 'included' | 'context' | 'out_of_scope' | 'superseded'; reason: string
  }>
  open_questions: string[]
}

export class PrdStructureError extends Error {
  constructor(public readonly issues: string[]) {
    super(`需求结构尚未就绪：${issues.join('；')}`)
    this.name = 'PrdStructureError'
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const texts = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : []

/** Strict validation: do not trim away malformed rows and make an incomplete model appear complete. */
export function validateRequirementsModel(raw: unknown, features: SketchRequirement[]): string[] {
  const issues: string[] = []
  if (!record(raw)) return ['requirements_model 缺失或不是对象']
  if (raw.version !== 1 || !text(raw.goal) || !texts(raw.target_users) || !raw.target_users.length) issues.push('目标、目标用户或模型版本缺失')
  const fields = ['sources', 'entities', 'relations', 'workflows', 'rules', 'scenarios', 'coverage', 'open_questions']
  for (const field of fields) if (!Array.isArray(raw[field])) issues.push(`${field} 必须是数组`)
  if (!texts(raw.open_questions)) issues.push('open_questions 必须是文本数组')
  const featureIds = new Set<string>()
  for (const feature of features) {
    if (!record(feature) || !/^F-\d{3,}$/.test(feature.id) || !text(feature.description)) { issues.push('功能项 id 或描述无效'); continue }
    if (featureIds.has(feature.id)) issues.push(`功能项重复：${feature.id}`)
    featureIds.add(feature.id)
    if (!['P0', 'P1', 'P2'].includes(feature.priority ?? '')) issues.push(`${feature.id} 未声明优先级`)
  }
  if (!featureIds.size) issues.push('功能清单为空')
  const rows = (field: string, prefix: string): Record<string, unknown>[] => {
    const seen = new Set<string>()
    return list(raw[field]).flatMap(value => {
      if (!record(value) || !text(value.id) || !new RegExp(`^${prefix}-\\d{3,}$`).test(value.id)) { issues.push(`${field} 条目或编号无效`); return [] }
      if (seen.has(value.id)) issues.push(`${field} 编号重复：${value.id}`)
      seen.add(value.id)
      return [value]
    })
  }
  const sources = rows('sources', 'S')
  for (const source of sources) if (!text(source.text)) issues.push(`${source.id} 来源原文为空`)
  const sourceIds = new Set(sources.map(row => row.id as string))
  const entities = rows('entities', 'O')
  for (const entity of entities) if (!text(entity.name) || !text(entity.description) || !texts(entity.attributes)) issues.push(`${entity.id} 对象定义无效`)
  const entityIds = new Set(entities.map(row => row.id as string))
  for (const relation of list(raw.relations)) {
    if (!record(relation) || !entityIds.has(relation.from as string) || !entityIds.has(relation.to as string) || !text(relation.description)) issues.push('对象关系引用无效')
  }
  const refs = (value: unknown, allowed: Set<string>, label: string, nonempty = false): void => {
    if (!texts(value) || (nonempty && !value.length)) { issues.push(`${label} 引用列表无效`); return }
    if (new Set(value).size !== value.length) issues.push(`${label} 引用重复`)
    for (const id of value) if (!allowed.has(id)) issues.push(`${label} 引用不存在：${id}`)
  }
  const workflows = rows('workflows', 'W')
  if (!workflows.length) issues.push('缺少完整使用流程')
  for (const flow of workflows) {
    if (!text(flow.name) || !texts(flow.steps) || !flow.steps.length) issues.push(`${flow.id} 流程步骤无效`)
    refs(flow.feature_ids, featureIds, `${flow.id} 功能`, true)
  }
  const rules = rows('rules', 'BR')
  const ruleIds = new Set(rules.map(row => row.id as string))
  for (const rule of rules) {
    if (!text(rule.statement) || !['user', 'assumption'].includes(rule.origin as string)) issues.push(`${rule.id} 业务规则无效`)
    refs(rule.feature_ids, featureIds, `${rule.id} 功能`, true)
    refs(rule.source_ids, sourceIds, `${rule.id} 来源`, rule.origin === 'user')
  }
  const scenarios = rows('scenarios', 'AC')
  for (const scenario of scenarios) {
    if (!featureIds.has(scenario.feature_id as string) || !['normal', 'boundary', 'exception'].includes(scenario.kind as string)) issues.push(`${scenario.id} 功能或场景类型无效`)
    refs(scenario.rule_ids, ruleIds, `${scenario.id} 规则`)
    if (scenario.not_applicable !== undefined) {
      if (scenario.kind === 'normal' || !text(scenario.not_applicable) || scenario.not_applicable.trim().length < 20) issues.push(`${scenario.id} 普通路径不可豁免，其他豁免须具体说明`)
      if (list(scenario.rule_ids).length) issues.push(`${scenario.id} 豁免场景不能证明规则已覆盖`)
    } else if (![scenario.given, scenario.when, scenario.then].every(text)) issues.push(`${scenario.id} 缺少可观察的 given/when/then`)
    for (const ruleId of list(scenario.rule_ids)) {
      const rule = rules.find(row => row.id === ruleId)
      if (rule && !list(rule.feature_ids).includes(scenario.feature_id)) issues.push(`${scenario.id} 规则未关联该功能`)
    }
  }
  for (const id of featureIds) {
    if (!workflows.some(flow => list(flow.feature_ids).includes(id))) issues.push(`${id} 未接入使用流程`)
    for (const kind of ['normal', 'boundary', 'exception']) if (!scenarios.some(row => row.feature_id === id && row.kind === kind)) issues.push(`${id} 缺少 ${kind} 验收场景或明确豁免`)
  }
  for (const rule of rules) for (const id of list(rule.feature_ids)) {
    if (!scenarios.some(row => row.feature_id === id && row.not_applicable === undefined && list(row.rule_ids).includes(rule.id))) issues.push(`${rule.id} 未在关联功能 ${id} 的验收中覆盖`)
  }
  const covered = new Set<string>()
  for (const row of list(raw.coverage)) {
    if (!record(row)) { issues.push('来源覆盖条目无效'); continue }
    const id = row.source_id as string
    if (!sourceIds.has(id) || covered.has(id)) issues.push(`来源覆盖未知或重复：${id}`)
    covered.add(id)
    refs(row.feature_ids, featureIds, `${id} 功能覆盖`)
    refs(row.rule_ids, ruleIds, `${id} 规则覆盖`)
    if (!['included', 'context', 'out_of_scope', 'superseded'].includes(row.disposition as string) || !text(row.reason)) issues.push(`${id} 未说明来源处理方式`)
    if (row.disposition === 'included' && !list(row.feature_ids).length && !list(row.rule_ids).length) issues.push(`${id} 纳入需求却未关联功能或规则`)
  }
  for (const id of sourceIds) if (!covered.has(id)) issues.push(`原始来源未说明处理方式：${id}`)
  return [...new Set(issues)]
}

/** Attach host sources before validating model output; matching references is not a claim of semantic coverage. */
export function parseOrganizedRequirements(raw: unknown, sources: RequirementSource[], onIssues?: (issues: string[]) => void): { requirements: SketchRequirement[]; model: RequirementsModel } | undefined {
  if (!record(raw) || !Array.isArray(raw.requirements) || !record(raw.requirements_model)) { onIssues?.(['必须产出 requirements 和 requirements_model']); return undefined }
  const requirements: SketchRequirement[] = []
  for (const value of raw.requirements) {
    if (!record(value) || !text(value.id) || !text(value.description)) return undefined
    if (value.behavior_assertions !== undefined && !texts(value.behavior_assertions)) return undefined
    requirements.push({ id: value.id, description: value.description, priority: value.priority as SketchRequirement['priority'],
      ...(text(value.story) ? { story: value.story } : {}),
      ...(text(value.scope_notes) ? { scope_notes: value.scope_notes } : {}),
      ...(texts(value.behavior_assertions) ? { behavior_assertions: value.behavior_assertions } : {}),
      origin: value.origin === 'user' ? 'user' : 'guide', source: 'organized' })
  }
  const model = { ...raw.requirements_model, sources } as unknown as RequirementsModel
  const issues = validateRequirementsModel(model, requirements)
  if (issues.length) { onIssues?.(issues); return undefined }
  // Acceptance scenarios are authoritative. Free-form acceptance cannot independently promise different behavior.
  for (const feature of requirements) feature.behavior_assertions = model.scenarios
    .filter(row => row.feature_id === feature.id && !row.not_applicable)
    .map(row => `${row.given}；当${row.when}时，${row.then}`)
  return { requirements, model }
}

/** Mechanical document projection: there is no independently generated feature-number set. */
export function renderRequirementsDocument(backplane: PrdBackplane): string {
  const model = backplane.requirements_model!
  const lines = [`# PRD：${backplane.name || backplane.positioning}`, '', '## 目标与范围', model.goal,
    `目标用户：${model.target_users.join('、')}`, `产品定位：${backplane.positioning}`, '', '## 核心对象与关系']
  for (const entity of model.entities) lines.push(`- [${entity.id}] ${entity.name}：${entity.description}；属性：${entity.attributes.join('、') || '无额外属性'}`)
  for (const relation of model.relations) lines.push(`- ${relation.from} → ${relation.to}：${relation.description}`)
  if (!model.entities.length) lines.push('- 本产品无需要独立管理的业务对象')
  lines.push('', '## 使用流程')
  for (const flow of model.workflows) lines.push(`### [${flow.id}] ${flow.name}`, flow.steps.map((step, index) => `${index + 1}. ${step}`).join('\n'), `关联功能：${flow.feature_ids.join('、')}`, '')
  lines.push('## 业务规则')
  for (const rule of model.rules) lines.push(`- [${rule.id}] ${rule.statement}；约束功能：${rule.feature_ids.join('、')}；来源：${rule.origin === 'user' ? rule.source_ids.join('、') : '建议假设，需随 PRD 过目确认'}`)
  if (!model.rules.length) lines.push('- 无独立于功能的业务规则')
  lines.push('', '## 功能能力与验收场景')
  for (const feature of backplane.requirements) {
    lines.push(`### [${feature.id}]（${feature.priority ?? 'P2'}）${feature.description}`)
    if (feature.story) lines.push(feature.story)
    if (feature.scope_notes) lines.push(`范围说明：${feature.scope_notes}`)
    if (feature.source_refs?.length) lines.push(`材料来源：${feature.source_refs.map(ref => `附件 ${ref.attachment_id}，第 ${ref.start_line}–${ref.end_line} 行`).join('；')}`)
    for (const scenario of model.scenarios.filter(row => row.feature_id === feature.id)) lines.push(
      `- [${scenario.id}] ${scenario.kind}：${scenario.not_applicable ? `不适用：${scenario.not_applicable}` : `给定${scenario.given}；当${scenario.when}；则${scenario.then}`}${scenario.rule_ids.length ? `；规则：${scenario.rule_ids.join('、')}` : ''}`)
    lines.push('')
  }
  for (const [title, values] of [['用户约束', backplane.constraints ?? []], ['范围外', backplane.out_of_scope], ['后台假设', backplane.assumptions], ['待确定问题', model.open_questions]] as const) {
    lines.push(`## ${title}`, ...((values ?? []).length ? values.map(value => `- ${value}`) : ['- 无']), '')
  }
  lines.push('## 原始需求与处理说明')
  for (const source of model.sources) {
    const coverage = model.coverage.find(row => row.source_id === source.id)
    lines.push(`- [${source.id}] ${source.text}`, `  处理：${coverage?.disposition ?? '未说明'}；${coverage?.reason ?? ''}；功能：${coverage?.feature_ids.join('、') || '无'}；规则：${coverage?.rule_ids.join('、') || '无'}`)
  }
  // User-facing prose remains a projection, while implementation-specific metadata stays in the backplane.
  if (backplane.pages?.length) lines.push('', '## 界面安排', ...backplane.pages.map(page => `- ${page.name}：${page.purpose ?? ''}`))
  if (backplane.ux) lines.push('', '## 操作反馈', ...backplane.ux.states.map(state => `- ${state.observable}`), ...backplane.ux.feedback_rules.map(rule => `- ${rule}`))
  if (backplane.shape) lines.push('', '## 使用与运行方式', `主流程：${backplane.shape.primary_loop}`, `处理对象：${backplane.shape.fact_source}`,
    `使用网络：${backplane.shape.needs_network ? '需要' : '不需要'}`, ...backplane.shape.destructive_ops.map(operation => `- 涉及覆盖或删除：${operation}`), ...backplane.shape.architecture_open_questions.map(question => `- 待明确：${question}`))
  if (backplane.glossary?.length) lines.push('', '## 术语说明', ...backplane.glossary.map(entry => `- ${entry.term}：${entry.definition}`))
  if (backplane.gdd) lines.push('', '## 游戏体验与规则', backplane.gdd.core_fantasy, ...backplane.gdd.pillars.map(row => `- ${row}`), `游戏循环：${backplane.gdd.core_loop.join(' → ')}`, ...backplane.gdd.numbers.map(row => `- 数值：${row}`))
  if (backplane.ai_capabilities?.length) lines.push('', '## 智能能力与完成标准', ...backplane.ai_capabilities.flatMap(capability => [
    `- ${capability.task}：${capability.ioDependency}`, ...capability.forbiddenSubstitutions.map(row => `  - 不算完成：${row}`), ...capability.evidence.map(row => `  - 验收依据：${row}`),
  ]))
  if (backplane.key_tasks?.length) lines.push('', '## 本版交付任务', ...backplane.key_tasks.map(task => `- ${task.label}（${task.must_deliver ? '必须完成' : '可选'}；${task.feature_ids.join('、')}）`))
  return lines.join('\n')
}

/** No mutation/repair in a gate: show the caller the exact mismatch instead. Legacy documents remain readable. */
export function prdStructureIssues(backplane: PrdBackplane): string[] {
  const issues: string[] = []
  if (!Array.isArray(backplane.requirements) || backplane.requirements.some(row => !record(row) || !text(row.id) || !text(row.description))) return ['功能清单形状无效']
  const ids = backplane.requirements.map(row => row.id)
  if (!ids.length || new Set(ids).size !== ids.length) issues.push('功能清单为空或存在重复编号')
  if (backplane.requirements_model) {
    const modelIssues = validateRequirementsModel(backplane.requirements_model, backplane.requirements)
    issues.push(...modelIssues)
    if (modelIssues.length) return [...new Set(issues)]
    if (backplane.requirements_model.open_questions.length) issues.push('仍有未处理的需求问题')
  }
  const documentText = (backplane.prd_document ?? '').replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
  const headings = [...documentText.matchAll(/^#{1,6}\s+\[?(F-\d+)\]?(?=[\s（(：:])/gm)].map(match => match[1])
  if (headings.length && (new Set(headings).size !== headings.length || headings.some(id => !ids.includes(id)) || ids.some(id => !headings.includes(id)))) issues.push('PRD 正文与功能清单编号不一致')
  if (backplane.requirements_model && backplane.prd_document !== renderRequirementsDocument(backplane)) issues.push('PRD 正文不是当前需求模型的同源视图')
  for (const id of Object.keys(backplane.acceptance ?? {})) if (!ids.includes(id)) issues.push(`验收引用不存在的功能：${id}`)
  return [...new Set(issues)]
}

export function projectRequirementsModel(backplane: PrdBackplane): PrdBackplane {
  return backplane.requirements_model ? { ...backplane, prd_document: renderRequirementsDocument(backplane) } : backplane
}

/** Exact surviving capabilities keep ids. Renumbering the array is never an acceptable revision. */
export function stableFeatureIdIssues(previous: PrdBackplane | undefined, next: SketchRequirement[]): string[] {
  if (!previous?.requirements_model) return []
  return previous.requirements.flatMap(old => {
    const matching = next.find(row => row.description.replace(/\s+/g, ' ').trim() === old.description.replace(/\s+/g, ' ').trim())
    return matching && matching.id !== old.id ? [`功能编号被重排：${old.id} → ${matching.id}（${old.description}）`] : []
  })
}

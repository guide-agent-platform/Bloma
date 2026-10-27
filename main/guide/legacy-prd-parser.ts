/** Pure historical document/schema readers. No model or execution entry. */








import type { AgentMessage, MessageContentBlock, TemplateType } from '../../shared/types'
import type { AiCapability, GameDesignDoc, InterfaceEndpoint, KeyTask, PrdBackplane, ProductShape, ShapeCandidate, ShapeHostTemplate, SketchRequirement, UxExperienceSpec, UxStateId } from '../model/prd-backplane'
import {
  buildPrdDocumentFallback,
  capContractEnabled,
  deriveAiCapabilities,
  finalizeKeyTasks,
  keyTasksEnabled,
  normalizePrdDocumentNewlines,
  reconcilePrdDocumentPriorities,
} from '../model/prd-backplane'
import { renderDocumentSectionSpec } from './prd-sections'

import { sanitizeGeneratedProjectName, updateProject } from '../project/project-service'

import { bindAcceptance } from '../project/requirement-contract'
import { parseOrganizedRequirements, projectRequirementsModel, stableFeatureIdIssues, type RequirementsModel, type RequirementSource } from '../model/requirements-model'






/**
 * 能力契约块产出指令（Phase 2 M1，仅在 BLOMA_CAP_CONTRACT=on 时追加到 system prompt 末尾）。
 * 三处消费（loop 锚定/裁判/确认卡）读背板 ai_capabilities，与本指令同 schema。
 */
export const CAP_PROMPT_ADDENDUM = [
  '【能力契约块（ai_capabilities，本段启用时必须输出）】',
  '输出结构新增字段（与上述字段同层级；纯展示/纯 CRUD 项目省略或给空数组）：',
  '"ai_capabilities":[{"capability_id":"CAP-01","task":"该能力承担的任务","keyProcessing":"关键处理依赖什么","ioDependency":"输入=…；输出=…；输入变化→输出如何相应变化","forbiddenSubstitutions":["固定模板冒充"],"evidence":["修改关键输入后输出变化"],"source":"user_explicit"}',
  '- 凡功能项涉及 AI/智能/语音/自动生成/总结整理等能力（输入→智能处理→输出），必须为每条此类能力输出一条 CAP，上限 4 条。',
  '- task 不得用「智能处理」「一键生成」类标签词代替；keyProcessing 说清该能力靠什么成立（模型调用/规则/检索）。',
  '- forbiddenSubstitutions 从对话与需求提炼写具体（如「固定模板冒充总结」「关键词匹配冒充分析」「降级为普通增删改查」）；evidence 为行为级可观察证据。',
  '- source：user_explicit=用户原话明确要求；confirmed_derived=从已确认需求派生；pending_assumption=未经确认的假设。',
  '- document 的功能清单与验收不得与 CAP 矛盾；CAP 的「不算完成」优先于任何局部测试通过。',
].join('\n')

/**
 * 关键任务块产出指令（Phase 7 U1 H2，仅在 BLOMA_KEY_TASKS=on 时追加到 system prompt 末尾）。
 * 消费方：PRD 确认卡展示 + delivery_status 计算（P7-2）读背板 key_tasks，与本指令同 schema。
 */
export const KEY_TASKS_PROMPT_ADDENDUM = [
  '【关键任务块（key_tasks，本段启用时必须输出）】',
  '输出结构新增字段（与上述字段同层级）：',
  '"key_tasks":[{"task_id":"KT-01","label":"用户语言的一句话任务（如：记一笔账，月底能看到这个月花了多少）","feature_ids":["F-001","F-002"],"must_deliver":true}]',
  '- 从已确认功能项提炼 2~4 个「做完才算这一版交付」的关键任务，用用户任务视角的语言写：动词开头、说清用户能完成什么，不用技术术语。',
  '- 每个 P0 功能项必须落入至少一个任务（硬约束；系统会自动补齐遗漏，但请尽量自己写好）。',
  '- label 不复制功能项描述原文，而是任务视角的合并表述（例：F-001 记账 + F-002 结余 →「记一笔账，月底能看到这个月花了多少」）。',
  '- must_deliver=true 表示必须做到（做不到这一版不能算完成）；确属锦上添花、可整体失败的才标 false；不确定时一律 true。',
  '- document 的功能清单与 key_tasks 不得矛盾；任务里承诺的功能项必须在功能清单内。',
].join('\n')




export function buildBackplaneFromParsed(parsed: ParsedPrd, items: SketchRequirement[], projectId: string, templateType?: import('../../shared/types').TemplateType): PrdBackplane {  const acceptance: Record<string, string> = {}
  for (const item of items) {
    acceptance[item.id] = parsed.acceptance[item.id]?.trim() || `${item.description}：核心路径可交互，边界与异常输入不崩溃。`
  }
  const positioning = parsed.positioning.trim() || items[0].description
  // 长文本 PRD dual-form：document 缺失/空白时由结构化字段机械拼装兜底（确定性，不编内容），
  // 保证背板 prd_document 恒存在（确认卡/loop 锚定的消费假设）。
  // P1-4/P1-5（2026-09-04）：LLM 输出的 document 先还原双重转义换行（\\n→真换行），再按结构化
  // 字段校正 priority 标注（document 自标 P0/P1 与 requirements 冻结 priority 不一致时以结构化覆盖）。
  const rawDocument = parsed.document.trim()
  const prdDocument = rawDocument
    ? reconcilePrdDocumentPriorities(normalizePrdDocumentNewlines(rawDocument), items)
    : buildPrdDocumentFallback({
        positioning,
        requirements: items,
        acceptance,
        out_of_scope: parsed.out_of_scope,
        assumptions: parsed.assumptions,
      })
  return bindAcceptance({
    project_id: projectId,
    name: parsed.name ?? '', // 候选名；pipeline 按项目命名来源与最新存储状态裁决。
    positioning,
    prd_document: prdDocument,
    requirements: items,
    ...(parsed.organized ? { requirements_model: parsed.organized.model } : {}),
    acceptance,
    out_of_scope: parsed.out_of_scope,
    assumptions: parsed.assumptions,
    // P1-7：game 类型 GDD（玩法真相源）随背板冻结；非 game 缺省 undefined。
    ...(parsed.gdd ? { gdd: parsed.gdd } : {}),
    // UX 契约线（2026-10-06）：体验契约随背板冻结（PRD 确认时刻）；未产出/解析失败
    // 缺省 undefined——下游任务书按通用九态兑底纪律注入，不 fail PRD。
    ...(parsed.ux ? { ux: parsed.ux } : {}),
    // 批9 形状体系（2026-10-07）：shape 随背板冻结（PRD 确认时刻）；未产出/解析失败
    // 缺省 undefined——无形状增强，行为等同批8，不 fail PRD。
    ...(parsed.shape ? { shape: parsed.shape } : {}),
    // 后端契约派生腿已退役（2026-10-06 web 残留清理）：prompt 已明说不输出 interface_spec，
    // 此处仅兼容透传 LLM 异常输出（正常恒缺省），不再有确定性派生。
    ...(parsed.interface_spec && parsed.interface_spec.length > 0 ? { interface_spec: parsed.interface_spec } : {}),
    // Phase 2 M1：能力契约块随背板冻结——LLM 产出优先；漏报且命中 AI 信号 →
    // deriveAiCapabilities 确定性派生；开关 off 整段不挂（字节级现状）。
    ...(capContractEnabled()
      ? {
          ai_capabilities:
            parsed.ai_capabilities && parsed.ai_capabilities.length > 0
              ? parsed.ai_capabilities
              : (deriveAiCapabilities(items) ?? []),
        }
      : {}),
    // Phase 7 U1 H2：关键任务块随背板冻结——LLM 产出优先，finalizeKeyTasks 做
    // 白名单过滤+P0 补齐+重编号；开关 off 整段不挂（字节级现状）。
    ...(keyTasksEnabled() ? { key_tasks: finalizeKeyTasks(parsed.key_tasks ?? [], items) } : {}),
  })
}

interface ParsedPrd {
  organized?: { requirements: SketchRequirement[]; model: RequirementsModel; link_notes: string[] }
  name?: string
  source_refs?: Record<string, unknown>
  document: string
  positioning: string
  /** 判型 LLM 化（2026-10-06）：引擎自判交付形态；desktop 缺省（解析容错：非法值→undefined）。 */
  form?: 'desktop' | 'game' | 'web'
  acceptance: Record<string, string>
  /** UX 契约线（2026-10-06）：体验契约（七态白名单 + 反馈规则；解析容错缺省 undefined=降级）。 */
  ux?: UxExperienceSpec
  /** 批9 形状体系（2026-10-07）：产品形状轴（四模板白名单；解析容错缺省 undefined=降级）。 */
  shape?: ProductShape
  out_of_scope: string[]
  assumptions: string[]
  gdd?: GameDesignDoc
  interface_spec?: InterfaceEndpoint[]
  /** Phase 2 M1：能力契约块（开关 on 时 prompt 要求产出；解析容错同 interface_spec）。 */
  ai_capabilities?: AiCapability[]
  /** Phase 7 U1 H2：关键任务块（开关 on 时 prompt 要求产出；形状级清洗，定稿在 finalizeKeyTasks）。 */
  key_tasks?: KeyTask[]
}

/** 九态白名单（批9 2026-10-07 扩：+cancelled/+unconfigured；与 prd-backplane UxStateId 同源）。 */
const UX_STATE_IDS: ReadonlySet<string> = new Set(['empty', 'ready_input', 'validating', 'running', 'success', 'partial', 'failed', 'cancelled', 'unconfigured'])

/** 形状模板宿主白名单（首批四模板；与 shape-templates.ts 同源）。 */
const SHAPE_HOST_TEMPLATES: ReadonlySet<string> = new Set(['instant_utility', 'record_manager', 'file_pipeline', 'job_runner'])

/** LLM 角色白名单（llm_role；判定教学见 prd-system 提示词九）。 */
const LLM_ROLES: ReadonlySet<string> = new Set(['none', 'core', 'optional', 'preview', 'user_config'])

/** 解析 shape 产品形状（批9 工件1）：host_template/llm_role/task_duration 白名单校验，
 * 结构字段齐备才采纳（齐备性门在 evaluateShapeGate——parse 阶段只做形态过滤）；
 * 任一白名单字段非法或宿主字段缺失 → undefined（降级=无形状增强，不 fail）。
 * export：供单测直测（同 parseUxExperience 口径）。 */
export function parseProductShape(raw: unknown): ProductShape | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const hostTemplate = typeof obj.host_template === 'string' ? obj.host_template : ''
  const llmRole = typeof obj.llm_role === 'string' ? obj.llm_role : ''
  const taskDuration = typeof obj.task_duration === 'string' ? obj.task_duration : ''
  if (!SHAPE_HOST_TEMPLATES.has(hostTemplate)) return undefined
  if (!LLM_ROLES.has(llmRole)) return undefined
  if (taskDuration !== 'instant' && taskDuration !== 'short' && taskDuration !== 'long_running') return undefined
  const primaryLoop = typeof obj.primary_loop === 'string' ? obj.primary_loop.trim() : ''
  const factSource = typeof obj.fact_source === 'string' ? obj.fact_source.trim() : ''
  if (!primaryLoop || !factSource) return undefined
  const stringArray = (value: unknown, cap: number): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim().slice(0, 120)).slice(0, cap) : []
  const candidates: ShapeCandidate[] = []
  if (Array.isArray(obj.candidates)) {
    for (const entry of obj.candidates) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Record<string, unknown>
      const template = typeof item.template === 'string' ? item.template.trim() : ''
      if (!template) continue
      candidates.push({ template, reasons: stringArray(item.reasons, 3) })
      if (candidates.length >= 3) break
    }
  }
  const policyRaw = typeof obj.job_policy === 'object' && obj.job_policy !== null ? (obj.job_policy as Record<string, unknown>) : {}
  const jobPolicy = {
    cancellable: policyRaw.cancellable !== false,
    progress: policyRaw.progress !== false,
    close_policy: typeof policyRaw.close_policy === 'string' && policyRaw.close_policy.trim() ? policyRaw.close_policy.trim().slice(0, 60) : 'wait_or_confirm',
  }
  return {
    host_template: hostTemplate as ShapeHostTemplate,
    modules: stringArray(obj.modules, 4),
    primary_loop: primaryLoop.slice(0, 160),
    fact_source: factSource.slice(0, 120),
    needs_resident: obj.needs_resident === true,
    needs_network: obj.needs_network === true,
    task_duration: taskDuration as ProductShape['task_duration'],
    destructive_ops: stringArray(obj.destructive_ops, 6),
    llm_role: llmRole as ProductShape['llm_role'],
    job_policy: jobPolicy,
    candidates,
    architecture_open_questions: stringArray(obj.architecture_open_questions, 4),
  }
}

/** 形状门判定结果：pass=false 时 questions 非空（澄清回流问题清单，业务语言）。 */
export interface ShapeGateResult {
  pass: boolean
  /** 未决的架构级问题（含 open questions 与结构缺口推导；pass 时为空）。 */
  questions: string[]
}

/** 形状确定性拦截规则（批9 工件1，替代 LLM 自报 confidence）：
 * - architecture_open_questions 非空 → 拦截（铁律，高置信也不豁免）；
 * - task_duration/needs_resident/needs_network/llm_role 任一缺失 → 拦截
 *   （parse 已自齐备白名单字段，此处兑底防御未经过 parse 的存量/修订背板）；
 * - candidates 为空（无法想象任何形状）→ 拦截。
 * 消费点：runPrdPipeline（PRD 确认前）——pass=false 时发澄清回流卡，不阻塞 fail。
 * export：供单测直测。 */
export function evaluateShapeGate(shape: ProductShape | undefined): ShapeGateResult {
  if (!shape) return { pass: true, questions: [] }
  const questions: string[] = []
  for (const open of shape.architecture_open_questions) {
    if (open.trim()) questions.push(open.trim())
  }
  const missing: string[] = []
  if (!shape.task_duration) missing.push('任务时长档')
  if (shape.llm_role === undefined || shape.llm_role === null) missing.push('AI 角色判定')
  if (typeof shape.needs_resident !== 'boolean') missing.push('是否常驻')
  if (typeof shape.needs_network !== 'boolean') missing.push('是否联网')
  if (missing.length > 0) {
    questions.push(`还有几处影响成品形态的信息未定：${missing.join('、')}`)
  }
  if (shape.candidates.length === 0 && questions.length === 0) {
    questions.push('这个产品更像哪种工作形态还没想清楚，需要补充信息')
  }
  return { pass: questions.length === 0, questions }
}

/**
 * 解析 ux 体验契约（UX 契约线，2026-10-06）：states 按 id 白名单过滤（observable 必填非空），
 * 上限 7 态；feedback_rules 字符串数组上限 6 条；清洗后 states 为空 → undefined（降级）。
 * export：供单测直测（同 parseInterfaceSpec/parseAiCapabilities 口径）。
 */
export function parseUxExperience(raw: unknown): UxExperienceSpec | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const obj = raw as Record<string, unknown>
  const states: UxExperienceSpec['states'] = []
  const seen = new Set<string>()
  if (Array.isArray(obj.states)) {
    for (const entry of obj.states) {
      if (typeof entry !== 'object' || entry === null) continue
      const item = entry as Record<string, unknown>
      const id = typeof item.id === 'string' ? item.id : ''
      const observable = typeof item.observable === 'string' ? item.observable.trim() : ''
      if (!UX_STATE_IDS.has(id) || observable.length === 0 || seen.has(id)) continue
      seen.add(id)
      states.push({ id: id as UxStateId, observable })
      if (states.length >= 9) break
    }
  }
  if (states.length === 0) return undefined
  const feedbackRules = Array.isArray(obj.feedback_rules)
    ? obj.feedback_rules.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).slice(0, 6)
    : []
  return { states, feedback_rules: feedbackRules }
}

function parsePrdJson(text: string, sources?: RequirementSource[], onIssues?: (issues: string[]) => void): ParsedPrd | undefined {
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

  const organized = sources ? parseOrganizedRequirements(parsed, sources, onIssues) : undefined
  if (sources && !organized) return undefined
  const acceptance: Record<string, string> = {}
  if (isRecord(parsed.acceptance)) {
    for (const [key, value] of Object.entries(parsed.acceptance)) {
      if (typeof value === 'string') acceptance[key] = value
    }
  }
  if (organized) {
    for (const key of Object.keys(acceptance)) delete acceptance[key]
    for (const feature of organized.requirements) acceptance[feature.id] = feature.behavior_assertions!.join('；')
  }
  const stringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

  // P1-7：gdd 解析（game 类型；四要素齐备才采纳，缺任一视为无 GDD 降级）。
  const gdd = parseGdd(parsed.gdd)
  // UX 契约线（2026-10-06）：ux 解析（七态白名单；空 states 视为未产出降级）。
  const ux = parseUxExperience(parsed.ux)
  // 批9 形状体系（2026-10-07）：shape 解析（白名单+齐备性；非法视为未产出降级）。
  const shape = parseProductShape(parsed.shape)
  // 判型 LLM 化：form 白名单解析（非法/缺省 → undefined = 维持 desktop_tool 缺省）。
  const rawForm = typeof parsed.form === 'string' ? parsed.form : ''
  const form: ParsedPrd['form'] = rawForm === 'desktop' || rawForm === 'game' || rawForm === 'web' ? rawForm : undefined
  // 完整程序阶段 2：interface_spec 解析（前后端契约真相源；缺省/非法 → 空数组零注入）。
  const interfaceSpec = parseInterfaceSpec(parsed.interface_spec)
  // Phase 2 M1：ai_capabilities 解析（能力契约块；缺省/非法 → 空数组走派生兜底）。
  const aiCapabilities = parseAiCapabilities(parsed.ai_capabilities)
  // Phase 7 U1 H2：key_tasks 解析（关键任务块；缺省/非法 → 空数组走 P0 补齐兜底）。
  const keyTasks = parseKeyTasks(parsed.key_tasks)

  return {
    ...(organized ? { organized } : {}),
    positioning: typeof parsed.positioning === 'string' ? parsed.positioning : '',
    name: sanitizeGeneratedProjectName(parsed.name),
    ...(isRecord(parsed.source_refs) ? { source_refs: parsed.source_refs } : {}),
    document: typeof parsed.document === 'string' ? parsed.document : '',
    ...(form ? { form } : {}),
    acceptance,
    ...(ux ? { ux } : {}),
    ...(shape ? { shape } : {}),
    out_of_scope: stringArray(parsed.out_of_scope),
    assumptions: stringArray(parsed.assumptions),
    ...(gdd ? { gdd } : {}),
    ...(interfaceSpec.length > 0 ? { interface_spec: interfaceSpec } : {}),
    ...(aiCapabilities.length > 0 ? { ai_capabilities: aiCapabilities } : {}),
    ...(keyTasks.length > 0 ? { key_tasks: keyTasks } : {}),
  }
}

/**
 * 解析 ai_capabilities（Phase 2 M1）：capability_id 归一为 CAP-0N（接受 CAP-1/cap_01/1
 * 等变体）；task 必填（缺则弃条）；数组字段过滤空串，保留全部义务；source 白名单外归
 * pending_assumption（保守：来源不明不当作已确认）。
 * export：供单测直测（契约清洗承重，同 parseInterfaceSpec 口径）。
 */
export function parseAiCapabilities(raw: unknown): AiCapability[] {
  if (!Array.isArray(raw)) return []
  const out: AiCapability[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const task = typeof entry.task === 'string' ? entry.task.trim() : ''
    if (!task) continue
    const idRaw = typeof entry.capability_id === 'string' ? entry.capability_id : ''
    const idMatch = idRaw.match(/(\d+)/)
    const capabilityId = `CAP-${String(idMatch ? Number(idMatch[1]) : out.length + 1).padStart(2, '0')}`
    const list = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0).map((v) => v.trim())
        : []
    const sourceRaw = typeof entry.source === 'string' ? entry.source : ''
    const source: AiCapability['source'] =
      sourceRaw === 'user_explicit' || sourceRaw === 'confirmed_derived' || sourceRaw === 'pending_assumption'
        ? sourceRaw
        : 'pending_assumption'
    out.push({
      capability_id: capabilityId,
      task,
      keyProcessing: typeof entry.keyProcessing === 'string' ? entry.keyProcessing.trim() : '',
      ioDependency: typeof entry.ioDependency === 'string' ? entry.ioDependency.trim() : '',
      forbiddenSubstitutions: list(entry.forbiddenSubstitutions),
      evidence: list(entry.evidence),
      source,
    })
  }
  return out
}

/**
 * 解析 key_tasks（Phase 7 U1 H2）：形状级清洗——label 必填（缺则弃条）；
 * feature_ids 过滤非字符串并去重（白名单校验与 P0 补齐在 finalizeKeyTasks，
 * 因 parse 阶段无 requirements 上下文）；must_deliver 非 false 一律归 true
 * （保守：关键任务缺省必交）。解析不静默裁剪任务或功能关联。
 * export：供单测直测（契约清洗承重，同 parseAiCapabilities 口径）。
 */
export function parseKeyTasks(raw: unknown): KeyTask[] {
  if (!Array.isArray(raw)) return []
  const out: KeyTask[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) continue
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    if (!label) continue
    const featureIds = Array.isArray(entry.feature_ids)
      ? [...new Set(entry.feature_ids.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))]
      : []
    if (featureIds.length === 0) continue
    out.push({
      task_id: typeof entry.task_id === 'string' ? entry.task_id : '',
      label,
      feature_ids: featureIds,
      must_deliver: entry.must_deliver !== false,
    })
  }
  return out
}

/** 解析 interface_spec（完整程序阶段 2）：端点必须落在 /api/ 前缀下（平台自动挂载
 * server/routes），缺前缀自动补；方法白名单（缺省 GET）；上限 6 条，宁缺毋滥。
 * export：供单测直测（契约清洗规则承重，防下游挂载/探针被脏端点打穿）。 */
export function parseInterfaceSpec(raw: unknown): InterfaceEndpoint[] {
  if (!Array.isArray(raw)) return []
  const out: InterfaceEndpoint[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const endpointRaw = typeof record.endpoint === 'string' ? record.endpoint.trim() : ''
    if (!endpointRaw) continue
    // 缺 /api/ 前缀自动补：'api/records'（无斜杠但带 api 段）与 '/records' 同视为缺前缀
    const endpoint = endpointRaw.startsWith('/api/')
      ? endpointRaw
      : '/api/' + endpointRaw.replace(/^\/+/, '').replace(/^api\/+/, '')
    const methodRaw = typeof record.method === 'string' ? record.method.trim().toUpperCase() : 'GET'
    const method = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(methodRaw) ? methodRaw : 'GET'
    out.push({
      endpoint,
      method,
      ...(typeof record.request === 'string' && record.request.trim() ? { request: record.request.trim().slice(0, 200) } : {}),
      ...(typeof record.response === 'string' && record.response.trim() ? { response: record.response.trim().slice(0, 200) } : {}),
    })
    if (out.length >= 6) break
  }
  return out
}

/** 解析 gdd 四要素（核心幻想/支柱/核心循环/数值基准）；缺核心幻想或支柱或核心循环任一即 undefined。 */
function parseGdd(value: unknown): GameDesignDoc | undefined {
  if (!isRecord(value)) return undefined
  const coreFantasy = typeof value.core_fantasy === 'string' ? value.core_fantasy.trim() : ''
  const pillars = Array.isArray(value.pillars)
    ? value.pillars.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  const coreLoop = Array.isArray(value.core_loop)
    ? value.core_loop.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  const numbers = Array.isArray(value.numbers)
    ? value.numbers.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    : []
  if (!coreFantasy || pillars.length === 0 || coreLoop.length === 0) return undefined
  return { core_fantasy: coreFantasy, pillars, core_loop: coreLoop, numbers }
}



function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

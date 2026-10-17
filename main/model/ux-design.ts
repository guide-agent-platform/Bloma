import type { PrdBackplane } from './prd-backplane'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { createHash } from 'node:crypto'

export function uxDesignFingerprint(design: UxDesign): string {
  return createHash('sha256').update(JSON.stringify(design)).digest('hex')
}

export interface UxDesign {
  version: 1
  prd_fingerprint: string
  summary: string
  pages: Array<{ id: string; name: string; purpose: string; feature_ids: string[] }>
  flows: Array<{ workflow_id: string; page_ids: string[]; non_ui_reason?: string }>
  interactions: Array<{ id: string; page_id: string; feature_id: string; action: string;
    states: Array<{ kind: 'normal' | 'boundary' | 'exception'; observable: string; scenario_ids: string[] }> }>
  non_ui_features: Array<{ feature_id: string; reason: string; scenario_ids: string[] }>
}

const object = (raw: unknown): raw is Record<string, unknown> => raw !== null && typeof raw === 'object' && !Array.isArray(raw)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)

/** The host owns the PRD version. A model cannot assert that a stale scope is current. */
export function parseUxDesign(raw: unknown, prd: PrdBackplane, onIssues?: (issues: string[]) => void): UxDesign | undefined {
  if (!object(raw)) { onIssues?.(['缺少设计记录']); return undefined }
  const design = { ...raw, version: 1, prd_fingerprint: prdScopeFingerprint(prd) } as unknown as UxDesign
  const issues = uxDesignIssues(design, prd)
  if (issues.length) { onIssues?.(issues); return undefined }
  return design
}

export function uxDesignIssues(design: UxDesign, prd: PrdBackplane): string[] {
  const issues: string[] = []
  if (!object(design) || design.version !== 1 || !text(design.summary)) return ['界面设计记录缺失或无摘要']
  if (design.prd_fingerprint !== prdScopeFingerprint(prd)) issues.push('界面设计对应的需求版本已变化')
  if (!Array.isArray(design.pages) || !Array.isArray(design.flows) || !Array.isArray(design.interactions) || !Array.isArray(design.non_ui_features)) return [...issues, '界面设计的页面、流程或交互列表无效']
  if (!design.pages.length || !design.interactions.length) issues.push('桌面界面设计须至少说明一个页面与交互')
  const features = new Set(prd.requirements.map(row => row.id)), pages = new Set<string>(), interactions = new Set<string>(), covered = new Set<string>(), seenScenarios = new Set<string>()
  const scenarioById = new Map((prd.requirements_model?.scenarios ?? []).map(row => [row.id, row]))
  for (const page of design.pages) {
    if (!object(page) || !text(page.id) || !/^P-\d{3,}$/.test(page.id) || !text(page.name) || !text(page.purpose) || !strings(page.feature_ids)) { issues.push('页面定义无效'); continue }
    if (pages.has(page.id)) issues.push(`页面编号重复：${page.id}`)
    pages.add(page.id)
    for (const id of page.feature_ids) if (!features.has(id)) issues.push(`页面引用未知功能：${id}`)
  }
  const checkScenarios = (ids: unknown, featureId: string, kind?: string): void => {
    if (!strings(ids)) { issues.push(`${featureId} 场景引用无效`); return }
    for (const id of ids) {
      const scenario = scenarioById.get(id)
      if (!scenario || scenario.feature_id !== featureId || (kind && scenario.kind !== kind)) issues.push(`场景 ${id} 与功能/状态类型不一致`)
      else seenScenarios.add(id)
    }
  }
  for (const item of design.interactions) {
    if (!object(item) || !text(item.id) || !/^UI-\d{3,}$/.test(item.id) || !text(item.action) || !features.has(item.feature_id) || !pages.has(item.page_id) || !Array.isArray(item.states) || !item.states.length) { issues.push('交互定义或功能/页面引用无效'); continue }
    if (interactions.has(item.id)) issues.push(`交互编号重复：${item.id}`)
    interactions.add(item.id)
    const page = design.pages.find(row => row.id === item.page_id)
    if (!page?.feature_ids.includes(item.feature_id)) issues.push(`${item.id} 功能未在所在页面声明`)
    covered.add(item.feature_id)
    for (const state of item.states) {
      if (!object(state) || !['normal', 'boundary', 'exception'].includes(state.kind) || !text(state.observable)) { issues.push(`${item.id} 状态反馈无效`); continue }
      checkScenarios(state.scenario_ids, item.feature_id, state.kind)
    }
  }
  for (const item of design.non_ui_features) {
    if (!object(item) || !features.has(item.feature_id) || !text(item.reason) || item.reason.trim().length < 12) { issues.push('非界面需求须说明具体原因'); continue }
    if (covered.has(item.feature_id)) issues.push(`${item.feature_id} 同时被声明为界面与非界面需求`)
    covered.add(item.feature_id)
    checkScenarios(item.scenario_ids, item.feature_id)
  }
  for (const id of features) if (!covered.has(id)) issues.push(`${id} 未说明界面操作或非界面职责`)
  const workflowIds = new Set(prd.requirements_model?.workflows.map(row => row.id) ?? []), seenFlows = new Set<string>()
  for (const flow of design.flows) {
    if (!object(flow) || !workflowIds.has(flow.workflow_id) || seenFlows.has(flow.workflow_id) || !strings(flow.page_ids)) { issues.push('使用流程关联无效或重复'); continue }
    seenFlows.add(flow.workflow_id)
    for (const id of flow.page_ids) if (!pages.has(id)) issues.push(`${flow.workflow_id} 引用未知页面：${id}`)
    if (!flow.page_ids.length && !text(flow.non_ui_reason)) issues.push(`${flow.workflow_id} 未关联页面或说明非界面流程`)
    const workflow = prd.requirements_model?.workflows.find(row => row.id === flow.workflow_id)
    if (flow.page_ids.length && workflow) for (const id of workflow.feature_ids) {
      if (!design.pages.some(page => flow.page_ids.includes(page.id) && page.feature_ids.includes(id)) && !design.non_ui_features.some(row => row.feature_id === id)) issues.push(`${flow.workflow_id} 关联页面未覆盖 ${id}`)
    }
  }
  for (const id of workflowIds) if (!seenFlows.has(id)) issues.push(`使用流程未进入设计：${id}`)
  // An explicit PRD exemption is not an observable behavior to invent a UI for.
  // Applicable scenarios still require the same feature/kind association above.
  for (const [id, scenario] of scenarioById) if (scenario.not_applicable === undefined && !seenScenarios.has(id)) issues.push(`验收场景未说明对应的界面状态或非界面职责：${id}`)
  return [...new Set(issues)]
}

/** Honest fallback, mechanically describing all requirements/states rather than promising model-designed layout. */
export function buildFallbackUxDesign(prd: PrdBackplane): UxDesign {
  const scenarios = prd.requirements_model?.scenarios ?? []
  return { version: 1, prd_fingerprint: prdScopeFingerprint(prd), summary: '简易方案：分区呈现各项操作，显示正常结果、输入边界与失败反馈；具体布局可继续调整。',
    pages: [{ id: 'P-001', name: '主工作区', purpose: prd.positioning, feature_ids: prd.requirements.map(row => row.id) }],
    flows: (prd.requirements_model?.workflows ?? []).map(flow => ({ workflow_id: flow.id, page_ids: ['P-001'] })),
    interactions: prd.requirements.map((feature, index) => ({ id: `UI-${String(index + 1).padStart(3, '0')}`, page_id: 'P-001', feature_id: feature.id,
      action: feature.description, states: (['normal', 'boundary', 'exception'] as const).map(kind => ({ kind,
        observable: scenarios.filter(row => row.feature_id === feature.id && row.kind === kind).map(row => row.then ?? `不适用：${row.not_applicable}`).join('；') || (kind === 'normal' ? '展示操作结果' : '提示原因并保留已输入内容'),
        scenario_ids: scenarios.filter(row => row.feature_id === feature.id && row.kind === kind).map(row => row.id) })) })), non_ui_features: [] }
}

export function renderUxDesignSummary(design: UxDesign): string {
  return [design.summary, ...design.pages.map(page => `界面「${page.name}」：${page.purpose}`), ...design.interactions.map(item =>
    `${item.action}：${item.states.map(state => state.observable).join('；')}`), ...design.non_ui_features.map(item => `${item.feature_id}：${item.reason}`)].join('\n')
}

import { parseProjectContract } from './contract-schema'
import type { PrdBackplane } from '../model/prd-backplane'
import { prdScopeFingerprint } from '../project/requirement-contract'

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(text)

export function earlyArtifactIssues(phase: string, read: (path: string) => string | undefined, prd?: PrdBackplane): string[] {
  const issues: string[] = []
  const json = (path: string): unknown => {
    const raw = read(path)
    if (raw === undefined) { issues.push(`${path} 不可读取`); return undefined }
    try { return JSON.parse(raw) } catch { issues.push(`${path} 不是合法 JSON`); return undefined }
  }
  if (phase === 'desktop-arch') {
    if (!read('00_ARCH/architecture.md')?.trim()) issues.push('架构文档为空，尚未说明职责与数据边界')
    const env = json('00_ARCH/env-checklist.json')
    if (env !== undefined && (!object(env) || !Array.isArray(env.components) || !env.components.length)) issues.push('环境清单须为对象并声明非空 components')
    if (object(env) && Array.isArray(env.components)) for (const component of env.components) {
      if (prd?.requirements_model) {
        if (!object(component) || !text(component.name) || !text(component.source) || !['verified', 'documented', 'pending'].includes(component.evidence as string)) issues.push('每个环境组件须声明 name/source/evidence（verified/documented/pending）')
      } else if (!text(component) && (!object(component) || !text(component.name))) issues.push('环境组件名称无效')
    }
    if (prd?.requirements_model) issues.push(...architecturePlanIssues(json('00_ARCH/architecture.json'), prd))
  }
  if (phase === 'desktop-scaffold') {
    const raw = read('00_SCAFFOLD/contract.json')
    try {
      if (!raw) throw new Error('契约不存在或为空')
      const contract = parseProjectContract(raw)
      const featureIds = new Set(prd?.requirements.map(row => row.id) ?? [])
      if (prd) for (const scenario of contract.scenarios) for (const id of scenario.covers) if (!featureIds.has(id)) issues.push(`工程契约引用未知功能：${id}`)
      if (prd?.requirements_model) {
        const declared = JSON.parse(raw) as Record<string, unknown>
        if (declared.prd_fingerprint !== prdScopeFingerprint(prd)) issues.push('工程契约未绑定当前需求范围版本')
        const covered = new Set(contract.scenarios.flatMap(row => row.covers))
        for (const id of featureIds) if (!covered.has(id)) issues.push(`工程契约尚未登记已确认功能：${id}`)
      }
    } catch (error) { issues.push(`工程契约无效：${error instanceof Error ? error.message : String(error)}`) }
    if (!read('00_SCAFFOLD/driver-skeleton.py')?.trim()) issues.push('驱动骨架为空，不能进入实现')
  }
  return [...new Set(issues)]
}

/** Structural module/data/test mapping; it is not a claim that the planned architecture is implemented. */
export function architecturePlanIssues(raw: unknown, prd: PrdBackplane): string[] {
  if (!object(raw) || raw.version !== 1 || raw.prd_fingerprint !== prdScopeFingerprint(prd)) return ['架构记录缺失、版本无效或未绑定当前 PRD']
  const model = prd.requirements_model!
  if (!Array.isArray(raw.modules) || !raw.modules.length || !Array.isArray(raw.data_boundaries) || !Array.isArray(raw.validation)) return ['架构须声明 modules/data_boundaries/validation']
  const issues: string[] = [], paths = new Set<string>(), features = new Set<string>(), rules = new Set<string>(), entities = new Set<string>(), validations = new Set<string>()
  const featureIds = new Set(prd.requirements.map(row => row.id)), ruleIds = new Set(model.rules.map(row => row.id)), entityIds = new Set(model.entities.map(row => row.id)), scenarioIds = new Set(model.scenarios.map(row => row.id))
  const collect = (raw: unknown, allowed: Set<string>, seen: Set<string>, field: string): void => {
    if (!strings(raw)) { issues.push(`${field} 须为编号列表`); return }
    for (const id of raw) { if (!allowed.has(id)) issues.push(`${field} 引用未知编号：${id}`); seen.add(id) }
  }
  for (const module of raw.modules) {
    if (!object(module) || !text(module.path) || !text(module.responsibility) || /(?:^|\/)\.\.(?:\/|$)|^\/|^[A-Za-z]:/.test(module.path.split(String.fromCharCode(92)).join('/'))) { issues.push('模块路径或职责无效'); continue }
    if (paths.has(module.path)) issues.push(`模块路径重复：${module.path}`)
    paths.add(module.path)
    collect(module.feature_ids, featureIds, features, '模块功能')
    collect(module.rule_ids, ruleIds, rules, '模块规则')
  }
  for (const boundary of raw.data_boundaries) {
    if (!object(boundary) || !entityIds.has(boundary.entity_id as string) || !paths.has(boundary.owner as string) || !text(boundary.persistence) || !text(boundary.failure_policy)) { issues.push('数据对象归属、留存或失败策略无效'); continue }
    entities.add(boundary.entity_id as string)
  }
  for (const test of raw.validation) {
    if (!object(test) || !scenarioIds.has(test.scenario_id as string) || !paths.has(test.module as string) || !text(test.method)) { issues.push('架构验证位置/方式或场景引用无效'); continue }
    validations.add(test.scenario_id as string)
  }
  for (const [all, seen, label] of [[featureIds, features, '功能'], [ruleIds, rules, '规则'], [entityIds, entities, '数据对象'], [scenarioIds, validations, '验收场景']] as const) for (const id of all) if (!seen.has(id)) issues.push(`${label} 未落实架构位置：${id}`)
  return [...new Set(issues)]
}

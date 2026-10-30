import { createHash } from 'node:crypto'
import type { PrdBackplane } from '../model/prd-backplane'
import { requirementEvidenceHash, trustedAcceptance } from '../project/requirement-contract'

export const INDEPENDENT_CATEGORIES = ['normal', 'multi_object', 'exception', 'cancel', 'reopen'] as const
export type IndependentCategory = typeof INDEPENDENT_CATEGORIES[number]
export type IndependentOracle = { kind: 'input'; step: number } | { kind: 'literal'; quote: string } | { kind: 'unresolved'; question: string }
export type IndependentStep = ({ kind: 'fill'; control: string; value: string } | { kind: 'click'; control: string; intent?: 'submit' | 'cancel' }
  | { kind: 'expect'; control: string; equals: string; oracle?: IndependentOracle } | { kind: 'restart' }) & { subject?: string }
export interface IndependentCase { id: string; feature: string; steps: IndependentStep[]
  basis?: { requirement_hash: string; expected_source: string }; coverage?: IndependentCategory[] }
export interface IndependentCases { cases: IndependentCase[]; coverage_notes?: Array<{ feature: string; category: IndependentCategory; disposition: 'not_applicable' | 'unresolved'; reason: string; source: string }> }
export interface IndependentSemantics { version: 1; digest: string; cases: Array<{ id: string; feature: string; status: 'grounded' | 'disputed'; issues: string[] }>
  coverage: Array<{ feature: string; category: IndependentCategory; status: 'declared_cases' | 'declared_not_applicable' | 'unresolved' | 'missing'; cases: string[]; reason?: string }>; ready: boolean }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const text = (value: unknown, max = 4000): value is string => typeof value === 'string' && value.length <= max
const keys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key))
/** Conservative positive signals only, not a natural-language scope proof.
 * Explicit exclusions stay exclusions; an uncertain category remains declared. */
function explicitlyRequested(source: string, category: IndependentCategory) {
  const patterns: Record<IndependentCategory, RegExp> = { normal: /./, multi_object: /多对象|两(?:条|个|件|项)(?:记录|对象|物品|资料)|修改A.*B|A与B|A和B/, exception: /异常|无效|非法|错误|空(?:白|名称|输入|值)|失败|超库存/, cancel: /取消|撤销编辑|放弃.*编辑/, reopen: /重开|重新打开|重启|退出后.*(?:保留|恢复)/ }
  return source.split(/[；;。!?！？\n]/).some(clause => !/不(?:要求|需要|支持|做)|无需|无须|不在范围|范围外/.test(clause) && patterns[category].test(clause))
}

/** Shape validation keeps all proposed business assertions intact. Semantic
 * disputes are assessed separately, never repaired by changing B's bytes. */
export function parseIndependentCases(textValue: string, features: string[]): IndependentCases {
  if (Buffer.byteLength(textValue) > 64 * 1024) throw Error('INDEPENDENT_CASES_TOO_LARGE')
  const value = JSON.parse(textValue) as IndependentCases
  if (!value || !keys(value, ['cases', 'coverage_notes']) || !Array.isArray(value.cases) || !value.cases.length || value.cases.length > 12
    || new Set(value.cases.map(c => c?.id)).size !== value.cases.length) throw Error('INDEPENDENT_CASES_INVALID')
  for (const item of value.cases) {
    if (!item || !keys(item, ['id', 'feature', 'steps', 'basis', 'coverage']) || !/^[A-Za-z0-9_-]{1,64}$/.test(item.id) || !features.includes(item.feature)
      || !Array.isArray(item.steps) || !item.steps.length || item.steps.length > 32 || !item.steps.some(s => s.kind === 'expect') || !item.steps.some(s => ['click', 'fill'].includes(s.kind))) throw Error('INDEPENDENT_CASE_INVALID')
    if (item.basis !== undefined && (!item.basis || !keys(item.basis, ['requirement_hash', 'expected_source']) || !text(item.basis.requirement_hash, 64) || !text(item.basis.expected_source))) throw Error('INDEPENDENT_BASIS_INVALID')
    if (item.coverage !== undefined && (!Array.isArray(item.coverage) || !item.coverage.length || new Set(item.coverage).size !== item.coverage.length || item.coverage.some(c => !INDEPENDENT_CATEGORIES.includes(c)))) throw Error('INDEPENDENT_COVERAGE_INVALID')
    for (const step of item.steps) {
      const allowed = step.kind === 'fill' ? ['kind', 'control', 'value', 'subject'] : step.kind === 'expect' ? ['kind', 'control', 'equals', 'oracle', 'subject'] : step.kind === 'click' ? ['kind', 'control', 'subject', 'intent'] : step.kind === 'restart' ? ['kind'] : []
      if (!allowed.length || !keys(step, allowed) || 'control' in step && !/^[A-Za-z0-9_-]{1,64}$/.test(step.control)
        || 'value' in step && !text(step.value, 2000) || 'equals' in step && !text(step.equals)
        || step.subject !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(step.subject)) throw Error('INDEPENDENT_STEP_INVALID')
      if(step.kind==='click'&&step.intent!==undefined&&!['submit','cancel'].includes(step.intent))throw Error('INDEPENDENT_STEP_INVALID')
      if (step.kind === 'expect' && step.oracle !== undefined) {
        const oracle = step.oracle
        if (!oracle || (oracle.kind === 'input' ? !keys(oracle, ['kind', 'step']) || !Number.isSafeInteger(oracle.step)
          : oracle.kind === 'literal' ? !keys(oracle, ['kind', 'quote']) || !text(oracle.quote) || !oracle.quote.trim()
          : oracle.kind === 'unresolved' ? !keys(oracle, ['kind', 'question']) || !text(oracle.question) || !oracle.question.trim() : true)) throw Error('INDEPENDENT_ORACLE_INVALID')
      }
    }
  }
  if (value.coverage_notes !== undefined && (!Array.isArray(value.coverage_notes) || value.coverage_notes.length > 64 || value.coverage_notes.some(note => !note
    || !keys(note, ['feature', 'category', 'disposition', 'reason', 'source']) || !features.includes(note.feature) || !INDEPENDENT_CATEGORIES.includes(note.category)
    || !['not_applicable', 'unresolved'].includes(note.disposition) || !text(note.reason, 1200) || !note.reason.trim() || !text(note.source)))) throw Error('INDEPENDENT_COVERAGE_NOTES_INVALID')
  return value
}
export function assessIndependentCases(brief: PrdBackplane, contract: IndependentCases): IndependentSemantics {
  const cases = contract.cases.map(item => {
    const requirement = brief.requirements.find(r => r.id === item.feature), expected = requirement && trustedAcceptance(brief, requirement), issues: string[] = []
    if (!requirement || !expected || item.basis?.expected_source !== expected || item.basis.requirement_hash !== requirementEvidenceHash(brief, requirement)) issues.push('预期来源缺失或与当前确认需求不匹配')
    if (!item.coverage?.length) issues.push('未声明本案例检查的业务错误面')
    item.steps.forEach((step, index) => {
      if (step.kind === 'restart' && !item.steps.slice(index + 1).some(s => s.kind === 'expect')) issues.push('重开后缺少实际断言')
      if (step.kind !== 'expect') return
      const oracle = step.oracle
      if (!oracle || oracle.kind === 'unresolved') { issues.push(oracle?.kind === 'unresolved' ? `待澄清：${oracle.question}` : '断言未说明预期依据'); return }
      if (oracle.kind === 'literal') {
        if (!expected?.includes(oracle.quote) || step.equals !== oracle.quote) issues.push('固定预期不是确认资料中逐字引用的业务值')
      } else {
        const source = item.steps[oracle.step]
        if (oracle.step < 0 || oracle.step >= index || source?.kind !== 'fill' || source.value !== step.equals || source.subject !== step.subject) issues.push('预期与所引用的先前输入或对象身份不一致')
      }
    })
    if (item.coverage?.includes('multi_object')) {
      const inputs = item.steps.filter((s): s is Extract<IndependentStep, { kind: 'fill' }> => s.kind === 'fill' && Boolean(s.subject))
      const subjects = new Set(inputs.map(s => s.subject))
      if (subjects.size < 2 || new Set(inputs.map(s => s.value)).size < 2 || [...subjects].some(subject => !item.steps.some(s => s.kind === 'expect' && s.subject === subject))) issues.push('多对象案例须有至少两个对象、不同输入及各自的实际断言')
      if (![...subjects].some(subject => new Set(inputs.filter(s => s.subject === subject).map(s => s.value)).size >= 2)) issues.push('多对象案例须再次修改其中一个对象，并观察其他对象是否保持')
    }
    if (item.coverage?.includes('reopen') && !item.steps.some(s => s.kind === 'restart')) issues.push('声明重开但没有真实重开步骤')
    if (item.coverage?.includes('cancel') && !item.steps.some((s, index) => s.kind === 'click' && s.intent === 'cancel' && item.steps.slice(index + 1).some(next => next.kind === 'expect'))) issues.push('声明取消但没有取消操作及后续断言')
    return { id: item.id, feature: item.feature, status: issues.length ? 'disputed' as const : 'grounded' as const, issues }
  })
  const coverage = brief.requirements.flatMap(requirement => INDEPENDENT_CATEGORIES.map(category => {
    const ids = contract.cases.filter(c => c.feature === requirement.id && c.coverage?.includes(category) && cases.find(s => s.id === c.id)?.status === 'grounded').map(c => c.id)
    const notes = contract.coverage_notes?.filter(n => n.feature === requirement.id && n.category === category) ?? []
    const valid = notes.length === 1 && notes[0].source === trustedAcceptance(brief, requirement)
    const requested=explicitlyRequested([requirement.description,trustedAcceptance(brief,requirement),...(requirement.behavior_assertions??[])].join('；'),category)
    const status = ids.length && !notes.length ? 'declared_cases' as const : category !== 'normal' && !requested && !ids.length && valid && notes[0].disposition === 'not_applicable' ? 'declared_not_applicable' as const
      : notes.length ? 'unresolved' as const : 'missing' as const
    return { feature: requirement.id, category, status, cases: ids, reason: requested&&notes[0]?.disposition==='not_applicable'?'确认资料明确提及该类行为，不能仅凭B的不适用声明跳过':notes[0]?.reason }
  }))
  return { version: 1, digest: hash({ contract, cases, coverage }), cases, coverage,
    ready: cases.every(c => c.status === 'grounded') && coverage.every(c => ['declared_cases', 'declared_not_applicable'].includes(c.status)) }
}
export const INDEPENDENT_SEMANTICS_INSTRUCTIONS = '返回严格JSON {cases:[{id,feature,basis:{requirement_hash,expected_source},coverage:[normal|multi_object|exception|cancel|reopen],steps}],coverage_notes:[{feature,category,disposition:not_applicable|unresolved,reason,source}]}。basis逐字引用确认expected与requirement_hash。step仅fill(control,value,subject可选)、click(control,subject可选,intent可选submit|cancel)、expect(control,equals,subject可选,oracle)、restart；control是逻辑控件名，不是选择器。expect.oracle仅input(step:先前fill的从0开始序号，equals须等于该输入且对象一致)、literal(quote:确认expected中逐字业务值，equals等于quote)、unresolved(question:规则未明)。不凭常识新增规则；规则未明用unresolved，不硬编预期。每需求有normal；其余四种错误面用案例coverage或coverage_notes说明不适用/待澄清及确认来源；不适用声明不是覆盖证明。多对象须不同subject及不同值并各自断言，取消操作标intent:cancel且其后断言，重开后必须断言。最多12案例，每案例32步；不得返回PASS或修改目标。'

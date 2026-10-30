import { randomUUID } from 'node:crypto'
import { independentDesignVersion, readIndependentDesign } from './independent-design'
import type { IndependentVerification } from './independent-verification'
import type { SoftwareRelease } from './release-store'
import { qualityIdentity, qualityHash, readQualityLedger, saveQualityLedger, type QualityFinding } from './quality-ledger'
import { redactSoftwareOutput } from './process-manager'
import { readPrdBackplane } from '../project/prd-store'
import { trustedAcceptance } from '../project/requirement-contract'
import { assessIndependentCases, type IndependentCases, type IndependentSemantics } from './independent-semantics'

export function independentChallengeVersion(projectId: string) {
  return qualityHash(readQualityLedger(projectId).findings.filter(f => f.independent && f.challenge).map(f => [f.id, f.independent, f.challenge]))
}
export function currentIndependentSemantics(projectId: string, contract: IndependentCases): IndependentSemantics {
  const base = assessIndependentCases(readPrdBackplane(projectId), contract), version = independentDesignVersion(projectId)
  const challenged = readQualityLedger(projectId).findings.filter(f => f.independent?.design_version === version && f.challenge)
  if (!challenged.length) return base
  const cases = base.cases.map(c => { const challenge = challenged.find(f => f.independent?.case_id === c.id)?.challenge
    return challenge ? { ...c, status: 'disputed' as const, issues: [...c.issues, `实现者争议尚待核对：${challenge.reason}；证据：${challenge.evidence}`] } : c })
  return { ...base, digest: qualityHash([base.digest, challenged.map(f => f.challenge)]), cases, ready: false,
    coverage: base.coverage.map(row => row.cases.some(id => cases.find(c => c.id === id)?.status === 'disputed') ? { ...row, status: 'unresolved' as const } : row) }
}
export async function recordIndependentDisputes(projectId: string, assessment: IndependentSemantics, signal?: AbortSignal) {
  const design = readIndependentDesign(projectId)
  if (design?.status !== 'frozen' || !design.digest) throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const identity = await qualityIdentity(projectId, signal), version = independentDesignVersion(projectId), ledger = readQualityLedger(projectId), brief = readPrdBackplane(projectId)
  const disputes = [...assessment.cases.filter(c => c.status === 'disputed').map(c => ({ id: c.id, feature: c.feature, issues: c.issues })),
    ...assessment.coverage.filter(c => ['missing', 'unresolved'].includes(c.status)).map(c => ({ id: `coverage:${c.feature}:${c.category}`, feature: c.feature, issues: [c.reason ?? `缺少${c.category}覆盖说明`] }))]
  for (const row of disputes) {
    if (ledger.findings.some(f => f.independent?.design_version === version && f.independent?.case_id === row.id)) continue
    const requirement = brief.requirements.find(r => r.id === row.feature)
    ledger.findings.push({ id: randomUUID(), review: `independent:${design.digest}:${row.id}`, identity, requirement: row.feature, expected_source: requirement && trustedAcceptance(brief, requirement) || '', category: 'independent_expectation', severity: 'medium',
      location: `B:${row.id}`, trigger: '实现前核对独立预期', evidence: row.issues.join('；'), reproduction: row.id, unknowns: row.issues.join('；'), disposition: 'disputed', checks: [], independent: { design_version: version, design_digest: design.digest, case_id: row.id } })
  }
  saveQualityLedger(projectId, ledger)
}
/** Raising a dispute blocks reuse; it never excludes a valid failure or grants
 * authority to edit B. A new confirmed target/design is a separate host action. */
export async function challengeIndependentCase(projectId: string, input: Record<string, unknown>, signal?: AbortSignal) {
  if (Object.keys(input).some(k => !['case_id', 'reason', 'evidence'].includes(k)) || ['case_id', 'reason', 'evidence'].some(k => typeof input[k] !== 'string' || !(input[k] as string).trim() || (input[k] as string).length > 2000)) throw Error('INDEPENDENT_CHALLENGE_INVALID')
  const design = readIndependentDesign(projectId), item = design?.contract?.cases.find(c => c.id === input.case_id)
  if (design?.status !== 'frozen' || !item) throw Error('INDEPENDENT_CHALLENGE_CASE_UNKNOWN')
  const base = assessIndependentCases(readPrdBackplane(projectId), design.contract!), assessment = { ...base, ready: false, cases: base.cases.map(c => c.id === item.id ? { ...c, status: 'disputed' as const, issues: [`实现者提出争议：${input.reason}`] } : c) }
  await recordIndependentDisputes(projectId, assessment, signal)
  const ledger = readQualityLedger(projectId), version = independentDesignVersion(projectId), finding = ledger.findings.find(f => f.independent?.design_version === version && f.independent?.case_id === item.id)!
  finding.challenge = { at: new Date().toISOString(), reason: String(input.reason), evidence: String(input.evidence), source: 'implementer_claim' }; saveQualityLedger(projectId, ledger)
  return finding
}

/** B writes proposals. Only actual host observations create confirmation or
 * closure. An invalid oracle is a design dispute, never a product failure. */
export async function recordIndependentFindings(projectId: string, candidate: SoftwareRelease, result: IndependentVerification, canClose: boolean, signal?: AbortSignal) {
  if (result.status === 'disabled' || !result.case_results || !result.design_version || !result.design_digest) return
  const identity = await qualityIdentity(projectId, signal)
  if (identity.source !== candidate.source.digest || independentDesignVersion(projectId) !== result.design_version) throw Error('INDEPENDENT_FINDING_CANDIDATE_CHANGED')
  const ledger = readQualityLedger(projectId)
  const brief=readPrdBackplane(projectId)
  for (const finding of ledger.findings.filter(f => f.independent && f.independent.design_version !== result.design_version && f.disposition !== 'superseded')) {
    const requirement=brief.requirements.find(r=>r.id===finding.requirement)
    // A fresh B proposal cannot erase a reproduced defect under the same
    // confirmed expectation just by dropping or renaming its failing case.
    if(!requirement||trustedAcceptance(brief,requirement)!==finding.expected_source){finding.disposition = 'superseded'; finding.unknowns = '确认需求已移除或预期已改变；旧意见保留，不计为修复关闭。'}
  }
  for (const observed of result.case_results) {
    let finding = ledger.findings.find(f => f.independent?.design_version === result.design_version && f.independent?.case_id === observed.id)
    if (!finding && observed.status === 'passed') continue
    if (!finding) {
      finding = { id: randomUUID(), review: `independent:${result.design_digest}:${observed.id}`, identity, requirement: observed.feature,
        expected_source: observed.expected_source ?? '', category: observed.kind === 'semantic' ? 'independent_expectation' : 'independent_behavior',
        severity: observed.kind === 'semantic' ? 'medium' : 'high', location: `B:${observed.id}`, trigger: '执行冻结的独立业务案例', evidence: observed.error ?? observed.issues?.join('；') ?? '宿主实际断言结果',
        reproduction: observed.id, unknowns: observed.kind === 'semantic' ? observed.issues?.join('；') ?? '预期待澄清' : '', disposition: observed.kind === 'semantic' ? 'disputed' : 'suspected', checks: [],
        independent: { design_version: result.design_version, design_digest: result.design_digest, case_id: observed.id } } satisfies QualityFinding
      ledger.findings.push(finding)
    }
    const outcome = observed.status === 'failed' && observed.kind === 'product_assertion' ? 'failed' : observed.status === 'passed' ? 'passed' : 'unverified'
    const baseline = finding.checks.some(c => c.outcome === 'failed')
    finding.checks.push({ at: new Date().toISOString(), identity, case_name: observed.id, rules: result.design_version, outcome, report: result.report_path, candidate: candidate.id,
      observation: redactSoftwareOutput(JSON.stringify({ case: observed, overall_passed: canClose, scope: 'frozen_independent_business_case' })) })
    if (outcome === 'failed') finding.disposition = 'confirmed'
    else if (outcome === 'passed' && baseline && canClose) finding.disposition = 'closed'
    else if (!baseline) finding.disposition = observed.kind === 'semantic' ? 'disputed' : outcome === 'passed' ? 'not_reproduced' : 'suspected'
    // A pass before all required verification finishes is retained, not closed.
  }
  saveQualityLedger(projectId, ledger)
}

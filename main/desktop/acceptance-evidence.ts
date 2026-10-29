import type { CoreVerificationResult, CoreVerificationStatus } from './core-verification'
export interface FeatureAcceptanceEvidence {
  local_cases: CoreVerificationStatus
  capability_contracts: CoreVerificationStatus | 'not_required'
  implementation: 'not_assessed'
  external_model_effects: 'unverified' | 'not_required'
}
export interface AcceptanceEvidence {
  version: 1
  coverage: 'registered_case_references'
  registered_checks: CoreVerificationStatus
  implementation: 'not_assessed'
  external_model_effects: 'unverified' | 'not_required'
  complete_requirements: 'not_assessed'
}
/** Only host-observed checks feed delivery. Neither a feature ID nor a successful
 * local HTTP probe certifies exhaustive implementation or provider quality. */
export function acceptanceEvidence(status: CoreVerificationStatus, features: FeatureAcceptanceEvidence[]): AcceptanceEvidence {
  return { version:1,coverage:'registered_case_references',registered_checks:status,implementation:'not_assessed',
    external_model_effects:features.some(row=>row.external_model_effects==='unverified')?'unverified':'not_required',complete_requirements:'not_assessed' }
}
export function invalidateAcceptanceEvidence(result: CoreVerificationResult) {
  if(result.local_status!==undefined)result.local_status='unverified'
  if(result.acceptance_evidence)result.acceptance_evidence.registered_checks='unverified'
  for(const row of result.requirements??[])if(row.acceptance_evidence){
    row.verification='unverified'
    row.acceptance_evidence.local_cases='unverified'
    if(row.acceptance_evidence.capability_contracts!=='not_required')row.acceptance_evidence.capability_contracts='unverified'
  }
}
export function acceptanceScopeNote(evidence?: AcceptanceEvidence) {
  if(!evidence||evidence.version!==1)return '历史记录未分层，不能据此推断完整需求或真实模型效果通过。'
  return evidence.external_model_effects==='unverified'
    ?'仅验证已登记的本机案例与能力协议；真实供应商连通和模型效果尚未验证。'
    :'仅验证已登记的本机案例与能力协议；完整需求实现尚未独立评定。'
}

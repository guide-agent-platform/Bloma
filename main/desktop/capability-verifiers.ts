import type { PrdBackplane } from '../model/prd-backplane'
import { requirementCapabilities, type RequirementCapability } from '../model/requirement-capabilities'
import type { CoreVerificationResult, CoreVerificationStatus } from './core-verification'
import { hasCurrentMicrophoneEvidence, runHostSpeechProbe, type SpeechVerificationSpec } from './speech-verification'
import { runHostPrefixRenameProbe } from './file-verification'
import { runHostLlmProbe, type LlmVerificationSpec } from './llm-verification'

export interface CapabilityContext {
  projectId: string; root: string; backplane: PrdBackplane; manifest: Record<string, unknown>; signal?: AbortSignal
}
export interface CapabilityOutcome {
  verifier_id?: string
  status: CoreVerificationStatus
  missing: string[]
  features: Record<string, CoreVerificationStatus>
  report?: Pick<CoreVerificationResult, 'speech' | 'file_operations' | 'llm'>
}
export interface CapabilityVerifier { id: string; run(context: CapabilityContext): Promise<CapabilityOutcome | undefined> }
export function combineVerification(current: CoreVerificationStatus, probe: CoreVerificationStatus): CoreVerificationStatus {
  const rank = { passed: 0, unverified: 1, environment_blocked: 2, failed: 3 }
  return rank[probe] > rank[current] ? probe : current
}
const items = (ctx: CapabilityContext, capability: RequirementCapability) => ctx.backplane.requirements.filter(item => requirementCapabilities(item).has(capability))

const speechVerifier: CapabilityVerifier = { id: 'speech', async run(ctx) {
  const required = items(ctx, 'speech')
  if (!required.length) return
  const spec = ctx.manifest.speech as SpeechVerificationSpec | undefined
  const result = spec ? await runHostSpeechProbe({ projectId: ctx.projectId, root: ctx.root, speech: spec, signal: ctx.signal }) : undefined
  const status = result?.status ?? 'unverified', missing: string[] = []
  if (!spec) missing.push('缺少 ASR 入口登记 speech，须登记产品实际使用的模型构造和转写方法')
  const features = Object.fromEntries(required.map(item => {
    let state: CoreVerificationStatus = status
    if (status !== 'passed') missing.push(`${item.id}: 宿主真实音频探针未通过，文本模拟不可替代${result?.error ? `（${result.error}）` : ''}`)
    if (spec && requirementCapabilities(item).has('microphone') && !hasCurrentMicrophoneEvidence(ctx.projectId, ctx.root, spec)) {
      missing.push(`${item.id}: 真实采集链路待授权实测`)
      state = combineVerification(state, 'unverified')
    }
    return [item.id, state]
  }))
  return { status, missing, features, report: result ? { speech: result } : undefined }
} }
const fileVerifier: CapabilityVerifier = { id: 'prefix_rename', async run(ctx) {
  const required = items(ctx, 'prefix_rename')
  if (!required.length) return
  const result = await runHostPrefixRenameProbe(ctx.root, undefined, { requireUndo: items(ctx, 'rename_undo').length > 0, signal: ctx.signal })
  return { status: result.status, features: Object.fromEntries(required.map(item => [item.id, result.status])), report: { file_operations: result },
    missing: result.status === 'passed' ? [] : [`宿主前缀改名反例未通过：${result.error ?? result.tests?.filter(test => !test.passed).map(test => test.name).join('、')}`] }
} }
const llmVerifier: CapabilityVerifier = { id: 'llm', async run(ctx) {
  const required = items(ctx, 'llm'), spec = ctx.manifest.llm as LlmVerificationSpec | undefined
  const needed = required.length > 0 || !!ctx.backplane.shape && !['none', 'preview'].includes(ctx.backplane.shape.llm_role)
  if (!needed && !spec) return
  const ids = new Set(ctx.backplane.requirements.map(item => item.id))
  if (spec && (!Array.isArray(spec.covers) || !spec.covers.length || spec.covers.some(id => !ids.has(id)) || required.some(item => !spec.covers.includes(item.id)))) {
    const declared = Array.isArray(spec.covers) ? spec.covers.filter(id => typeof id === 'string' && /^F-\d+$/.test(id)) : []
    throw Error(`MODEL_COVERAGE_INVALID: 模型入口覆盖声明缺失、悬空或漏掉模型需求 ${JSON.stringify({ required: required.map(item => item.id), declared,
      missing: required.filter(item => !declared.includes(item.id)).map(item => item.id), unknown: declared.filter(id => !ids.has(id)),
      next: '在CORE_CHECK.json的llm.covers登记实际客户端覆盖的对应需求；入口必须由产品实际使用，不要更改需求或添加探针专用替身。' })}`)
  }
  const result = spec ? await runHostLlmProbe(ctx.root, spec, undefined, ctx.signal, ctx.projectId) : undefined
  const status = result?.status ?? 'unverified'
  return { status, features: Object.fromEntries([...new Set([...required.map(item => item.id), ...(spec?.covers ?? [])])].map(id => [id, status])),
    report: result ? { llm: result } : undefined,
    missing: !spec ? [`缺少真实模型功能入口登记 llm（需求：${required.map(item => item.id).join(',') || '模型角色声明'}）；mock 或固定 network_error 不能证明请求链路已实现`] : status === 'passed' ? [] :
      [`模型功能本机 HTTP 探针未通过：${result?.error ?? result?.tests?.filter(test => !test.passed).map(test => test.name).join('、')}`] }
} }
export const BUILTIN_CAPABILITY_VERIFIERS: readonly CapabilityVerifier[] = [speechVerifier, fileVerifier, llmVerifier]

/** Host injection only. No global registration or product-owned executable plugins. */
export async function runCapabilityVerifiers(ctx: CapabilityContext, registry = BUILTIN_CAPABILITY_VERIFIERS): Promise<CapabilityOutcome[]> {
  if (new Set(registry.map(verifier => verifier.id)).size !== registry.length) throw new Error('DUPLICATE_CAPABILITY_VERIFIER')
  ctx.signal?.throwIfAborted()
  const outcomes: CapabilityOutcome[] = []
  for (const verifier of registry) {
    ctx.signal?.throwIfAborted()
    const outcome = await verifier.run(ctx)
    ctx.signal?.throwIfAborted()
    if (outcome) {
      const valid = (status: string) => ['passed', 'failed', 'unverified', 'environment_blocked'].includes(status)
      if (!valid(outcome.status) || !Array.isArray(outcome.missing) || outcome.missing.some(reason => typeof reason !== 'string')
        || !outcome.features || Object.entries(outcome.features).some(([id, status]) => !valid(status) || !ctx.backplane.requirements.some(item => item.id === id))) throw new Error('CAPABILITY_OUTCOME_INVALID')
      outcomes.push({...outcome,verifier_id:verifier.id})
    }
  }
  return outcomes
}

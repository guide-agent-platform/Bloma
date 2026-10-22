import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeTextFileAtomic } from '../../storage/json-store'
import { runAgentLoop } from '../agent/loop/agent-loop'
import { buildAgentTools } from '../agent/tools/agent-tools'
import { readPrdBackplane } from '../project/prd-store'
import { getPromaHome } from '../../storage/config-paths'
import { readExperiment, recordExperiment } from './dispatch-experiment'
import { bindExperimentInput } from './dispatch-experiment-runtime'
import { buildProductionContextTool } from './production-context'
import type { DesktopDispatchRunInput } from './dispatcher-loop'
import { verificationFingerprint } from './verification-fingerprint'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { randomUUID } from 'node:crypto'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { recordExperimentBoundary } from './dispatch-experiment'
import { recordSessionActivity } from '../platform/sessions/session-service'
import { appendDelegationSettle } from '../agent/delegation/delegation-persistence'
import type { AgentLoopResult } from '../agent/loop/agent-loop'
import { runNormalStartupVerification, NORMAL_STARTUP_REPORT } from './normal-startup-verification'

export interface QuickProductionReview {
  verdict: 'pass' | 'fail' | 'unverified'
  checked_features: string[]
  evidence: string[]
  findings: Array<{ feature_id: string; problem: string; kind?: 'product' | 'evidence' | 'environment' | 'advisory' }>
}
export function parseQuickProductionReview(text: string, required: string[]): QuickProductionReview | undefined {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as QuickProductionReview
    if (!['pass', 'fail', 'unverified'].includes(value.verdict) || !Array.isArray(value.checked_features)
      || value.checked_features.some(id => typeof id !== 'string' || !required.includes(id))
      || !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string' || !item.trim())
      || !Array.isArray(value.findings) || value.findings.some(item => !item || !required.includes(item.feature_id) || typeof item.problem !== 'string' || !item.problem.trim()
        || item.kind !== undefined && !['product', 'evidence', 'environment', 'advisory'].includes(item.kind))) return
    if (value.verdict === 'pass' && (required.some(id => !value.checked_features.includes(id)) || !value.evidence.length || value.findings.some(item => item.kind !== 'advisory'))) return
    return value
  } catch { return }
}

/** v2 quick has a pinned, read-only V review. It does not replace the external GUI score. */
export async function runQuickProductionReview(input: DesktopDispatchRunInput): Promise<QuickProductionReview> {
  const config = readExperiment(input.projectId)
  if (!config?.models || config.production_protocol !== 'v2') throw new Error('QUICK_REVIEW_REQUIRES_V2_EXPERIMENT')
  const backplane = readPrdBackplane(input.projectId)
  const required = backplane.requirements.map(item => item.id)
  if (!required.length) throw new Error('QUICK_REVIEW_EMPTY_SCOPE')
  const binding = bindExperimentInput({ ...input, maxTurns: 12 }, config, 'verify')
  const startup = input.sandboxRoot ? await runNormalStartupVerification(input.sandboxRoot, binding.signal)
    : { status: 'unverified' as const, error: 'NORMAL_STARTUP_PROJECT_ROOT_MISSING' }
  const fingerprintBefore = verificationFingerprint(input.sandboxRoot, prdScopeFingerprint(backplane))
  const reviewId = randomUUID()
  const reviewSessionId = randomUUID()
  const readFeatures = new Set<string>(), readPaths = new Set<string>()
  const tools = [...buildAgentTools({ projectId: input.projectId, role: 'review', realFullstackVariant: true })
    .filter(tool => ['read_file', 'list_files', 'grep', 'find'].includes(tool.name)), buildProductionContextTool(input.projectId)]
    .map(tool => ({ ...tool, execute: async (args: Record<string, unknown>, ctx: Parameters<typeof tool.execute>[1]) => {
      const outcome = await tool.execute(args, ctx)
      if (!outcome.isError) {
        if (tool.name === 'read_file' && typeof args.path === 'string') readPaths.add(args.path.replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase())
        if (tool.name === 'read_production_context' && args.topic === 'features') for (const id of (args.feature_ids as string[] | undefined) ?? required) readFeatures.add(id)
      }
      return outcome
    } }))
  recordSessionActivity(reviewSessionId, input.projectId, { parentSessionId: input.sessionId, sourceDelegationId: `quick-review-${reviewId}` })
  recordExperiment(config, 'quick_verifier_started', { review_id: reviewId, child_session_id: reviewSessionId, scope: 'independent_source_and_host_evidence_review', required_features: required })
  input.publish('message_delta', { text: '制作已完成，正在进行独立检查。' })
  let result: AgentLoopResult
  try { result = await runAgentLoop({
    system: '你是独立制作审阅者V，只读核查已确认需求、实现、CORE_CHECK.json、DELIVERY.md与宿主00_VERIFY/core-verification.json。按功能读取read_production_context，核对需求版本、实际业务断言及逻辑/GUI证据。不得写源码、降低验收、将脚本自述冒充独立GUI通过。最终只输出JSON：{"verdict":"pass|fail|unverified","checked_features":["F-001"],"evidence":["文件路径及核查事实"],"findings":[{"feature_id":"F-001","kind":"product|evidence|environment|advisory","problem":"具体问题和用户影响/缺失证据"}]}。product是有源码或执行证据支持的功能错误；evidence是缺少验证；environment是审阅或环境故障；advisory是没有已确认用户功能影响的建议。fail需具体功能错误，缺证给unverified。接口形式与建议风格不同不能单独阻断；须追踪调用、回包及前端兜底的数据流。pass要求全部功能已核查、有具体证据且无阻断问题，可保留advisory。若有宿主normal-startup.json必须读取，它验证无dport原生桥及首屏状态，不替代业务GUI验收。外部GUI验收和Q另计。',
    task: `审阅当前已实现产物，不重新设计。必须覆盖：${required.join(',')}。先读取宿主核心验证报告，按缺口核对相关实现。正常启动宿主检查：${startup.status}${startup.status !== 'not_applicable' ? `，证据${NORMAL_STARTUP_REPORT}` : '（本产物不适用骨架v2探针）'}。`,
    tools, query: binding.query, env: binding.env, providerType: binding.providerType,
    sessionId: reviewSessionId, parentSessionId: input.sessionId, accountingRole: 'verify', projectId: input.projectId, requestId: `${input.requestId}-quick-review`,
    maxTokens: binding.maxTokens, maxTurns: binding.maxTurns!, permissionMode: 'allow-all', signal: binding.signal,
    // Structured review and reasoning stay in the owned review session, outside the user conversation.
    publish: (type, payload) => { if (type === 'usage_summary') input.publish(type, payload) }, disableProgressNudge: true,
  }) } catch (error) {
    appendDelegationSettle(reviewSessionId, input.signal.aborted ? 'cancelled' : 'failed', { error: 'VERIFIER_EXECUTION_ERROR' })
    throw error
  }
  binding.signal.throwIfAborted()
  appendDelegationSettle(reviewSessionId, result.status === 'cancelled' ? 'cancelled' : 'completed', { loopStatus: result.status, resultSummary: '独立检查调用已结束，业务判定见审阅报告。' })
  let review = result.status === 'completed' && parseQuickProductionReview(result.finalText, required)
    || { verdict: 'unverified' as const, checked_features: [], evidence: [], findings: [] }
  const evidenceRead = readPaths.has('00_verify/core-verification.json') && [...readPaths].some(path => /\.(py|js|html)$/.test(path))
    && required.every(id => readFeatures.has(id))
  const fingerprintAfter = verificationFingerprint(input.sandboxRoot, prdScopeFingerprint(readPrdBackplane(input.projectId)))
  const unchanged = Boolean(fingerprintBefore && fingerprintAfter === fingerprintBefore)
  if (review.verdict === 'pass' && (!evidenceRead || !unchanged)) review = { ...review, verdict: 'unverified' }
  if (startup.status === 'failed') review = { ...review, verdict: 'fail', findings: [...review.findings,
    { feature_id: required[0], kind: 'product', problem: `正常启动宿主检查失败，读取${NORMAL_STARTUP_REPORT}中的原生桥与首屏错误证据。` }] }
  else if (startup.status === 'unverified' || startup.status === 'passed' && !readPaths.has(NORMAL_STARTUP_REPORT.toLowerCase())) {
    review = { ...review, verdict: 'unverified', findings: [...review.findings,
      { feature_id: required[0], kind: 'evidence', problem: `正常启动证据尚未确认，读取${NORMAL_STARTUP_REPORT}：${startup.error ?? '审阅未读取正常启动报告'}。` }] }
  }
  const directory = join(getPromaHome(), 'production-reviews'); mkdirSync(directory, { recursive: true })
  const evidence = join(directory, `${config.run_id}-${reviewId}.json`)
  writeTextFileAtomic(evidence, JSON.stringify({ ...review, child_session_id: reviewSessionId, scope: 'independent_source_and_host_evidence_review', loop_status: result.status, run_id: config.run_id,
    fingerprint_before: fingerprintBefore, fingerprint_after: fingerprintAfter, source_unchanged: unchanged,
    observed_feature_reads: [...readFeatures], observed_file_reads: [...readPaths], required_evidence_read: evidenceRead }, null, 2))
  recordExperiment(config, 'quick_verifier_finished', { review_id: reviewId, verdict: review.verdict, loop_status: result.status, scope: 'independent_source_and_host_evidence_review', evidence })
  return review
}

/** Repair and evidence collection share one durable recovery allowance. Only a
 * fresh V pass can deliver; unknown evidence is never converted into a pass. */
export async function ensureQuickProductionReview(input: DesktopDispatchRunInput, controls: {
  review?: typeof runQuickProductionReview
  repair: (feedback: string) => Promise<void>
  supplement?: (feedback: string) => Promise<void>
  publish: (text: string) => void
  stop: (reason?: string) => void
}): Promise<boolean> {
  const config = readExperiment(input.projectId)
  if (config?.production_protocol !== 'v2' || !config.models) return true
  input.signal.throwIfAborted()
  let review: QuickProductionReview
  let unavailable = false
  try { review = await (controls.review ?? runQuickProductionReview)(input) }
  catch (error) {
    if (input.signal.aborted) throw error
    unavailable = true
    review = { verdict: 'unverified', checked_features: [], evidence: [], findings: [] }
    recordExperiment(config, 'quick_verifier_finished', { verdict: 'unverified', reason: 'VERIFIER_EXECUTION_ERROR' })
  }
  input.signal.throwIfAborted()
  if (review.verdict === 'pass') { resetProjectAttemptScope(input.projectId, 'quick-review'); return true }
  const findings = review.findings.filter(item => item.kind !== 'advisory')
  const productFailure = findings.some(item => item.kind === 'product') || review.verdict === 'fail' && findings.some(item => !item.kind)
  let attempt: { allowed: boolean; used: number }
  try { attempt = consumeProjectAttempt(input.projectId, 'quick-review', 2) }
  catch {
    recordExperimentBoundary(input.projectId, 'quick_verifier_blocked', { reason: 'VERIFICATION_RECOVERY_LEDGER_UNAVAILABLE', verdict: review.verdict })
    controls.publish('验证恢复记录无法保存，产物已保留，未宣布交付。')
    controls.stop('VERIFICATION_RECOVERY_LEDGER_UNAVAILABLE')
    return false
  }
  if (productFailure) {
    if (attempt.allowed) {
      controls.publish('独立审阅发现了具体问题，我会交回原实现者局部修复，再复核。')
      recordExperiment(config, 'quick_verifier_repair', { attempt: attempt.used, findings })
      await controls.repair('[独立V审阅反馈] 保留既有任务分解与实现者，按功能编号找到原负责人续接修复；不要重复任务正文、重建环境或降低验收。\n' + JSON.stringify(findings))
      return false
    }
  } else if (attempt.allowed) {
    recordExperiment(config, 'quick_verifier_evidence_requested', { attempt: attempt.used, verdict: review.verdict, findings })
    if (findings.length && controls.supplement && findings.some(item => item.kind !== 'environment')) {
      controls.publish('独立审阅仍缺验证证据，我会先补证再复核。')
      await controls.supplement('[独立V补证反馈] 保留原负责人、登记范围与累计预算。先核对下列疑点并补真实执行证据，优先读取00_VERIFY/normal-startup.json及core-verification.json；正常启动证据必须走无dport的pywebview桥。不要把未知当失败盲改源码；只有复现明确业务错误后才在已有权限内局部修复，不改需求、验收期望或放宽写入范围。功能正常但接口形式不同的，说明数据流与实测证据，不为迎合审阅改设计。\n' + JSON.stringify(findings))
    } else {
      // Execution/format failures and absent evidence get a bounded read-only
      // review retry, not an instruction to rewrite the product.
      return ensureQuickProductionReview(input, controls)
    }
    return false
  }
  const reason = productFailure ? 'VERIFICATION_REPAIR_EXHAUSTED'
    : unavailable || findings.length > 0 && findings.every(item => item.kind === 'environment') ? 'VERIFIER_EXECUTION_UNAVAILABLE' : 'VERIFICATION_EVIDENCE_INSUFFICIENT'
  recordExperimentBoundary(input.projectId, 'quick_verifier_blocked', { reason, verdict: review.verdict, recovery_attempts: attempt.used })
  controls.publish(`独立审阅尚未通过（${review.verdict}）：${review.findings.map(item => item.problem).join('；') || '证据或完整审阅结果不足'}。产物已保留，未宣布交付。`)
  controls.stop(reason)
  return false
}

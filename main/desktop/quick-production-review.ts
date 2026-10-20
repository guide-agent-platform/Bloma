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
import { randomUUID } from 'node:crypto'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { recordExperimentBoundary } from './dispatch-experiment'
import { recordSessionActivity } from '../platform/sessions/session-service'
import { appendDelegationSettle } from '../agent/delegation/delegation-persistence'
import type { AgentLoopResult } from '../agent/loop/agent-loop'

export interface QuickProductionReview {
  verdict: 'pass' | 'fail' | 'unverified'
  checked_features: string[]
  evidence: string[]
  findings: Array<{ feature_id: string; problem: string }>
}
export function parseQuickProductionReview(text: string, required: string[]): QuickProductionReview | undefined {
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')) as QuickProductionReview
    if (!['pass', 'fail', 'unverified'].includes(value.verdict) || !Array.isArray(value.checked_features)
      || value.checked_features.some(id => typeof id !== 'string' || !required.includes(id))
      || !Array.isArray(value.evidence) || value.evidence.some(item => typeof item !== 'string' || !item.trim())
      || !Array.isArray(value.findings) || value.findings.some(item => !item || !required.includes(item.feature_id) || typeof item.problem !== 'string' || !item.problem.trim())) return
    if (value.verdict === 'pass' && (required.some(id => !value.checked_features.includes(id)) || !value.evidence.length || value.findings.length)) return
    return value
  } catch { return }
}

/** v2 quick has a pinned, read-only V review. It does not replace the external GUI score. */
export async function runQuickProductionReview(input: DesktopDispatchRunInput): Promise<QuickProductionReview> {
  const config = readExperiment(input.projectId)
  if (!config?.models || config.production_protocol !== 'v2') throw new Error('QUICK_REVIEW_REQUIRES_V2_EXPERIMENT')
  const required = readPrdBackplane(input.projectId).requirements.map(item => item.id)
  if (!required.length) throw new Error('QUICK_REVIEW_EMPTY_SCOPE')
  const fingerprintBefore = verificationFingerprint(input.sandboxRoot)
  const reviewId = randomUUID()
  const reviewSessionId = randomUUID()
  const binding = bindExperimentInput({ ...input, maxTurns: 12 }, config, 'verify')
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
    system: '你是独立制作审阅者V，只读核查已确认需求、实现、CORE_CHECK.json、DELIVERY.md与宿主00_VERIFY/core-verification.json。按功能读取read_production_context，核对接口、需求版本、实际业务断言及逻辑/GUI证据；发现不足如实fail/unverified。不得写源码、降低验收、将脚本自述冒充独立GUI通过。最终只输出JSON：{"verdict":"pass|fail|unverified","checked_features":["F-001"],"evidence":["文件路径及核查事实"],"findings":[{"feature_id":"F-001","problem":"具体问题"}]}。pass要求全部功能已核查、有具体证据且无未解决问题。本阶段是源码及宿主证据审阅，外部GUI验收和Q另计。',
    task: `审阅当前已实现产物，不重新设计。必须覆盖：${required.join(',')}。先读取宿主核心验证报告，按缺口核对相关实现。`,
    tools, query: binding.query, env: binding.env, providerType: binding.providerType,
    sessionId: reviewSessionId, parentSessionId: input.sessionId, accountingRole: 'verify', projectId: input.projectId, requestId: `${input.requestId}-quick-review`,
    maxTokens: binding.maxTokens, maxTurns: binding.maxTurns!, permissionMode: 'allow-all', signal: binding.signal,
    // Structured review and reasoning stay in the owned review session, outside the user conversation.
    publish: (type, payload) => { if (type === 'usage_summary') input.publish(type, payload) }, disableProgressNudge: true,
  }) } catch (error) {
    appendDelegationSettle(reviewSessionId, input.signal.aborted ? 'cancelled' : 'failed', { error: 'VERIFIER_EXECUTION_ERROR' })
    throw error
  }
  appendDelegationSettle(reviewSessionId, result.status === 'cancelled' ? 'cancelled' : 'completed', { loopStatus: result.status, resultSummary: '独立检查调用已结束，业务判定见审阅报告。' })
  let review = result.status === 'completed' && parseQuickProductionReview(result.finalText, required)
    || { verdict: 'unverified' as const, checked_features: [], evidence: [], findings: [] }
  const evidenceRead = readPaths.has('00_verify/core-verification.json') && [...readPaths].some(path => /\.(py|js|html)$/.test(path))
    && required.every(id => readFeatures.has(id))
  const fingerprintAfter = verificationFingerprint(input.sandboxRoot)
  const unchanged = Boolean(fingerprintBefore && fingerprintAfter === fingerprintBefore)
  if (review.verdict === 'pass' && (!evidenceRead || !unchanged)) review = { ...review, verdict: 'unverified' }
  const directory = join(getPromaHome(), 'production-reviews'); mkdirSync(directory, { recursive: true })
  const evidence = join(directory, `${config.run_id}-${reviewId}.json`)
  writeTextFileAtomic(evidence, JSON.stringify({ ...review, child_session_id: reviewSessionId, scope: 'independent_source_and_host_evidence_review', loop_status: result.status, run_id: config.run_id,
    fingerprint_before: fingerprintBefore, fingerprint_after: fingerprintAfter, source_unchanged: unchanged,
    observed_feature_reads: [...readFeatures], observed_file_reads: [...readPaths], required_evidence_read: evidenceRead }, null, 2))
  recordExperiment(config, 'quick_verifier_finished', { review_id: reviewId, verdict: review.verdict, loop_status: result.status, scope: 'independent_source_and_host_evidence_review', evidence })
  return review
}

/** Repair concrete V findings through the existing implementers; unknown evidence never triggers blind code repair. */
export async function ensureQuickProductionReview(input: DesktopDispatchRunInput, controls: {
  review?: typeof runQuickProductionReview
  repair: (feedback: string) => Promise<void>
  publish: (text: string) => void
  stop: () => void
}): Promise<boolean> {
  const config = readExperiment(input.projectId)
  if (config?.production_protocol !== 'v2' || !config.models) return true
  let review: QuickProductionReview
  try { review = await (controls.review ?? runQuickProductionReview)(input) }
  catch (error) {
    if (input.signal.aborted) throw error
    review = { verdict: 'unverified', checked_features: [], evidence: [], findings: [] }
    recordExperiment(config, 'quick_verifier_finished', { verdict: 'unverified', reason: 'VERIFIER_EXECUTION_ERROR' })
  }
  if (review.verdict === 'pass') { resetProjectAttemptScope(input.projectId, 'quick-review'); return true }
  if (review.verdict === 'fail' && review.findings.length) {
    const attempt = consumeProjectAttempt(input.projectId, 'quick-review', 2)
    if (attempt.allowed) {
      controls.publish('独立审阅发现了具体问题，我会交回原实现者局部修复，再复核。')
      recordExperiment(config, 'quick_verifier_repair', { attempt: attempt.used, findings: review.findings })
      await controls.repair('[独立V审阅反馈] 保留既有任务分解与实现者，按功能编号找到原负责人续接修复；不要重复任务正文、重建环境或降低验收。\n' + JSON.stringify(review.findings))
      return false
    }
  }
  recordExperimentBoundary(input.projectId, 'gate_exhausted', { phase: 'quick-verifier', verdict: review.verdict })
  controls.publish(`独立审阅尚未通过（${review.verdict}）：${review.findings.map(item => item.problem).join('；') || '证据或完整审阅结果不足'}。产物已保留，未宣布交付。`)
  controls.stop()
  return false
}

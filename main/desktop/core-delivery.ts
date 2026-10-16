import { findProject } from '../project/project-service'
import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import type { DesktopRouteDeps } from './desktop-route'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { recordExperimentBoundary } from './dispatch-experiment'
const seenProjects = new Set<string>()
export function resetCoreDeliveryState(): void { for (const id of seenProjects) { try { resetProjectAttemptScope(id, 'core') } catch { /* test cleanup */ } } seenProjects.clear() }
export function clearCoreDeliveryRetries(projectId: string): void { resetProjectAttemptScope(projectId, 'core') }

/** Common check used by quick delivery, longterm review and final confirmation. */
export async function ensureCoreDelivery(input: { projectId: string; sessionId: string; requestId: string }, deps: DesktopRouteDeps,
  repair?: (feedback: string) => Promise<void>): Promise<boolean> {
  const result: CoreVerificationResult = await (deps.coreVerification
    ? deps.coreVerification(input.projectId)
    : runCoreVerification({ projectId: input.projectId, sandboxRoot: findProject(input.projectId)?.root_path }))
  seenProjects.add(input.projectId)
  if (result.status === 'passed') { clearCoreDeliveryRetries(input.projectId); return true }
  deps.publish(input, 'message_delta', { text: result.summary })
  deps.persistSystem(input.sessionId, `[decision] core-verification ${result.status}: ${result.missing.join('; ')}`)
  const hardwarePending = result.missing.some(reason => reason.includes('采集链路待授权'))
  let attempt: { allowed: boolean; used: number } = { allowed: false, used: 0 }
  if (repair && result.status !== 'environment_blocked' && !hardwarePending) {
    try { attempt = consumeProjectAttempt(input.projectId, 'core', 2) }
    catch { deps.publish(input, 'message_delta', { text: '修复计数无法保存，程序已保留，请先恢复执行记录。' }) }
  }
  if (repair && attempt.allowed) {
    deps.publish(input, 'message_delta', { text: '我会按失败原因做局部修复，再验证一次。' })
    await repair(`[系统反馈] 核心业务验证 ${result.status}。读取 00_VERIFY/core-verification.json，按当前失败点局部修复并执行核心检查，不改已确认需求或测试期望。原因：${result.missing.join('; ')}。本次修复 ${attempt.used}/2。`)
    return false
  }
  recordExperimentBoundary(input.projectId, 'core_verification_blocked', { verification_status: result.status, missing: result.missing, repair_attempts: attempt.used })
  deps.complete(input.sessionId, input.projectId, 'incomplete')
  return false
}

import { findProject } from '../project/project-service'
import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import type { DesktopRouteDeps } from './desktop-route'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import { recordExperimentBoundary } from './dispatch-experiment'
const seenProjects = new Set<string>()
export function resetCoreDeliveryState(): void { for (const id of seenProjects) { try { resetProjectAttemptScope(id, 'core') } catch { /* test cleanup */ } } seenProjects.clear() }
export function clearCoreDeliveryRetries(projectId: string): void { resetProjectAttemptScope(projectId, 'core') }

/** Common check used by quick delivery, longterm review and final confirmation. */
export async function ensureCoreDelivery(input: { projectId: string; sessionId: string; requestId: string; signal?: AbortSignal }, deps: DesktopRouteDeps,
  repair?: (feedback: string) => Promise<void>): Promise<boolean> {
  input.signal?.throwIfAborted()
  const result: CoreVerificationResult = await (deps.coreVerification
    ? deps.coreVerification(input.projectId, input.signal)
    : runCoreVerification({ projectId: input.projectId, sandboxRoot: findProject(input.projectId)?.root_path, signal: input.signal }))
  input.signal?.throwIfAborted()
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
    const failed = result.status === 'failed'
    deps.publish(input, 'message_delta', { text: failed ? '我会按失败原因做局部修复，再验证一次。' : '核心验证证据不足，我会先核对声明并补证，再检查。' })
    await repair(`[系统反馈] 核心业务验证 ${result.status}。读取 00_VERIFY/core-verification.json，${failed ? '按当前失败点局部修复并执行核心检查' : '先核对当前需求、登记与实际场景回读并补证；只有复现明确功能错误后才局部修复，不要把未知当失败盲改源码'}，不改已确认需求或测试期望。原因：${result.missing.join('; ')}。本次恢复 ${attempt.used}/2。`)
    return false
  }
  recordExperimentBoundary(input.projectId, 'core_verification_blocked', { verification_status: result.status, missing: result.missing, repair_attempts: attempt.used })
  deps.complete(input.sessionId, input.projectId, 'incomplete')
  return false
}

import { findProject } from '../project/project-service'
import { runCoreVerification, type CoreVerificationResult } from './core-verification'
import type { DesktopRouteDeps } from './desktop-route'
const repairCounts = new Map<string, number>()
export function resetCoreDeliveryState(): void { repairCounts.clear() }
export function clearCoreDeliveryRetries(projectId: string): void { repairCounts.delete(projectId) }

/** Common check used by quick delivery, longterm review and final confirmation. */
export async function ensureCoreDelivery(input: { projectId: string; sessionId: string; requestId: string }, deps: DesktopRouteDeps,
  repair?: (feedback: string) => Promise<void>): Promise<boolean> {
  const result: CoreVerificationResult = await (deps.coreVerification
    ? deps.coreVerification(input.projectId)
    : runCoreVerification({ projectId: input.projectId, sandboxRoot: findProject(input.projectId)?.root_path }))
  if (result.status === 'passed') { repairCounts.delete(input.projectId); return true }
  deps.publish(input, 'message_delta', { text: result.summary })
  deps.persistSystem(input.sessionId, `[decision] core-verification ${result.status}: ${result.missing.join('; ')}`)
  const count = repairCounts.get(input.projectId) ?? 0
  const hardwarePending = result.missing.some(reason => reason.includes('采集链路待授权'))
  if (repair && count < 2 && result.status !== 'environment_blocked' && !hardwarePending) {
    repairCounts.set(input.projectId, count + 1)
    deps.publish(input, 'message_delta', { text: '我会按失败原因做局部修复，再验证一次。' })
    await repair(`[系统反馈] 核心业务验证 ${result.status}。读取 00_VERIFY/core-verification.json，按当前失败点局部修复并执行核心检查，不改已确认需求或测试期望。原因：${result.missing.join('; ')}。本次修复 ${count + 1}/2。`)
    return false
  }
  deps.complete(input.sessionId, input.projectId, 'incomplete')
  return false
}

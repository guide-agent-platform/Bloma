import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureCoreDelivery, resetCoreDeliveryState } from '../../../main/desktop/core-delivery'
import type { DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { CoreVerificationResult } from '../../../main/desktop/core-verification'
const input = { projectId: 'p1', sessionId: 's1', requestId: 'r1' }
const result = (status: CoreVerificationResult['status'], missing = ['actual failed assertion']): CoreVerificationResult => ({ status, summary: '简短结论', checked_at: '', missing, evidence: [] })
beforeEach(resetCoreDeliveryState)
function deps(outcome: () => Promise<CoreVerificationResult>) {
  return { coreVerification: outcome, publish: vi.fn(), persistSystem: vi.fn(), complete: vi.fn(), persistAssistant: vi.fn() } as DesktopRouteDeps
}
describe('bounded autonomous core repair', () => {
  it('does not deliver or recover from a result returned after cancellation', async () => {
    const controller = new AbortController()
    const target = deps(async () => { controller.abort(); return result('passed') })
    const repair = vi.fn()
    await expect(ensureCoreDelivery({ ...input, signal: controller.signal }, target, repair)).rejects.toThrow()
    expect(repair).not.toHaveBeenCalled()
    expect(target.complete).not.toHaveBeenCalled()
  })

  it('requests evidence before source edits for an unknown result', async () => {
    const target = deps(async () => result('unverified', ['场景名不匹配']))
    const repair = vi.fn()
    await ensureCoreDelivery(input, target, repair)
    expect(repair).toHaveBeenCalledWith(expect.stringContaining('不要把未知当失败盲改源码'))
  })

  it('repairs a concrete failed path and rechecks without asking the user', async () => {
    let attempts = 0
    const target = deps(async () => result(++attempts < 3 ? 'failed' : 'passed'))
    const repair = vi.fn(async (feedback: string) => { expect(feedback).toContain('actual failed assertion'); await ensureCoreDelivery(input, target, repair) })
    await ensureCoreDelivery(input, target, repair)
    expect(repair).toHaveBeenCalledTimes(2)
    expect(attempts).toBe(3)
    expect(target.complete).not.toHaveBeenCalled()
  })
  it('stops after two repair attempts and preserves incomplete', async () => {
    const target = deps(async () => result('failed'))
    const repair = vi.fn(async () => { await ensureCoreDelivery(input, target, repair) })
    await ensureCoreDelivery(input, target, repair)
    expect(repair).toHaveBeenCalledTimes(2)
    expect(target.complete).toHaveBeenCalledOnce()
    expect(target.complete).toHaveBeenCalledWith('s1', 'p1', 'incomplete')
  })
  it.each([['environment_blocked', '环境未就绪'], ['unverified', '采集链路待授权实测']] as const)('does not rewrite business for %s', async (status, missing) => {
    const target = deps(async () => result(status, [missing]))
    const repair = vi.fn()
    await ensureCoreDelivery(input, target, repair)
    expect(repair).not.toHaveBeenCalled()
    expect(target.complete).toHaveBeenCalledWith('s1', 'p1', 'incomplete')
  })
})

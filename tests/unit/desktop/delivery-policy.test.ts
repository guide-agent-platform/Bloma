import { describe, expect, it } from 'vitest'
import { desktopDeliveryPolicy } from '../../../main/desktop/delivery-policy'
import { runCapabilityVerifiers } from '../../../main/desktop/capability-verifiers'
describe('host verification composition', () => {
  it.each(['quick', 'longterm', undefined])('keeps the delivery gates and confirmation matrix for %s', mode => {
    const policy = desktopDeliveryPolicy(mode, { production_protocol: 'v2', models: {} })
    expect(policy.mvpConfirmation).toBe(mode === 'longterm')
    expect(policy.independentReview).toBe(mode === 'quick')
    expect(policy.gates).toEqual(['core', 'security', 'launch', ...(mode === 'quick' ? ['independent_review'] : []), ...(mode === 'longterm' ? ['mvp_confirmation'] : []), 'version'])
  })
  it('does not add paid review to ordinary quick delivery', () => {
    expect(desktopDeliveryPolicy('quick').independentReview).toBe(false)
  })
  it('keeps injected capability evidence and cancellation under the host owner', async () => {
    const controller = new AbortController()
    const context = { projectId: 'p', root: '', backplane: { requirements: [] }, manifest: {}, signal: controller.signal } as never
    const result = await runCapabilityVerifiers(context, [{ id: 'custom', run: async () => ({ status: 'unverified', missing: ['hardware unavailable'], features: { 'F-001': 'unverified' } }) }])
    expect(result[0].features['F-001']).toBe('unverified')
    controller.abort()
    await expect(runCapabilityVerifiers(context, [])).resolves.toEqual([])
    await expect(runCapabilityVerifiers(context, [{ id: 'custom', run: async () => { throw Error('must not run') } }])).rejects.toThrow()
  })
  it('refuses duplicate capability identities', async () => {
    const verifier = { id: 'same', run: async () => undefined }
    await expect(runCapabilityVerifiers({} as never, [verifier, verifier])).rejects.toThrow('DUPLICATE_CAPABILITY')
  })
})

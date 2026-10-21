import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureQuickProductionReview, parseQuickProductionReview, type QuickProductionReview } from '../../../main/desktop/quick-production-review'
import { readProjectAttempts } from '../../../main/platform/execution/project-attempts'
import { recordExperiment, recordExperimentBoundary } from '../../../main/desktop/dispatch-experiment'
import type { DesktopDispatchRunInput } from '../../../main/desktop/dispatcher-loop'

vi.mock('../../../main/desktop/dispatch-experiment', () => ({
  readExperiment: () => ({ production_protocol: 'v2', models: {} }), recordExperiment: vi.fn(), recordExperimentBoundary: vi.fn(),
}))
let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'quick-review-recovery-')); process.env.PROMA_HOME = home; vi.clearAllMocks() })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
const input = () => ({ projectId: 'p', signal: new AbortController().signal }) as DesktopDispatchRunInput
const pass: QuickProductionReview = { verdict: 'pass', checked_features: ['F-001'], evidence: ['fresh review'], findings: [] }

describe('V recovery without changing evidence into PASS', () => {
  it('replays the captured r5 unverified review through evidence collection and a fresh V pass', async () => {
    const captured = JSON.parse(readFileSync(new URL('../../../outputs/experiment-r5a-20261021/verifier-review.json', import.meta.url), 'utf8')) as QuickProductionReview
    const original = structuredClone(captured)
    const review = vi.fn().mockResolvedValueOnce(captured).mockResolvedValueOnce(pass)
    const repair = vi.fn(), stop = vi.fn()
    const controls = { review, repair, stop, publish: vi.fn(), supplement: vi.fn(async (feedback: string) => {
      expect(feedback).toContain('不要把未知当失败盲改源码')
      expect(feedback).toContain(captured.findings[0].problem)
      await ensureQuickProductionReview(run, controls)
    }) }
    const run = input()
    await ensureQuickProductionReview(run, controls)
    expect(review).toHaveBeenCalledTimes(2); expect(controls.supplement).toHaveBeenCalledTimes(1)
    expect(repair).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled()
    expect(captured).toEqual(original)
    expect(readProjectAttempts('p')).toMatchObject({ active: {}, total: { 'quick-review': 1 } })
    expect(recordExperimentBoundary).not.toHaveBeenCalled()
  })
  it('bounds empty/unknown review retries and retains the recovery count across another invocation', async () => {
    const controls = { review: vi.fn(async () => ({ ...pass, verdict: 'unverified' as const })), repair: vi.fn(), supplement: vi.fn(), publish: vi.fn(), stop: vi.fn() }
    await ensureQuickProductionReview(input(), controls)
    expect(controls.review).toHaveBeenCalledTimes(3); expect(controls.repair).not.toHaveBeenCalled(); expect(controls.supplement).not.toHaveBeenCalled()
    expect(controls.stop).toHaveBeenCalledWith('VERIFICATION_EVIDENCE_INSUFFICIENT')
    expect(readProjectAttempts('p').total['quick-review']).toBe(2)
    await ensureQuickProductionReview(input(), controls)
    expect(controls.review).toHaveBeenCalledTimes(4); expect(readProjectAttempts('p').total['quick-review']).toBe(2)
    expect(recordExperimentBoundary).toHaveBeenCalledWith('p', 'quick_verifier_blocked', expect.objectContaining({ recovery_attempts: 2 }))
  })
  it('retries verifier execution errors read-only and reports unavailable rather than product failure', async () => {
    const controls = { review: vi.fn(async () => { throw Error('provider unavailable') }), repair: vi.fn(), supplement: vi.fn(), publish: vi.fn(), stop: vi.fn() }
    await ensureQuickProductionReview(input(), controls)
    expect(controls.review).toHaveBeenCalledTimes(3); expect(controls.repair).not.toHaveBeenCalled(); expect(controls.supplement).not.toHaveBeenCalled()
    expect(controls.stop).toHaveBeenCalledWith('VERIFIER_EXECUTION_UNAVAILABLE')
  })
  it('shares the same cumulative allowance when evidence collection discovers a product failure', async () => {
    const run = input(), product: QuickProductionReview = { ...pass, verdict: 'fail', findings: [{ feature_id: 'F-001', kind: 'product', problem: 'reproduced startup failure' }] }
    const controls = { review: vi.fn().mockResolvedValueOnce({ ...pass, verdict: 'unverified', findings: [{ feature_id: 'F-001', kind: 'evidence', problem: 'missing startup observation' }] }).mockResolvedValue(product),
      repair: vi.fn(async () => { await ensureQuickProductionReview(run, controls) }), supplement: vi.fn(async () => { await ensureQuickProductionReview(run, controls) }), stop: vi.fn(), publish: vi.fn() }
    await ensureQuickProductionReview(run, controls)
    expect(controls.supplement).toHaveBeenCalledTimes(1); expect(controls.repair).toHaveBeenCalledTimes(1)
    expect(controls.stop).toHaveBeenCalledWith('VERIFICATION_REPAIR_EXHAUSTED')
    expect(readProjectAttempts('p').total['quick-review']).toBe(2)
    expect(vi.mocked(recordExperiment).mock.calls.map(call => call[1])).toEqual(['quick_verifier_evidence_requested', 'quick_verifier_repair'])
  })
  it('does not attempt recovery when the durable counter is unreadable', async () => {
    mkdirSync(join(home, 'execution-attempts')); writeFileSync(join(home, 'execution-attempts/p.json'), '{broken')
    const controls = { review: async () => ({ ...pass, verdict: 'unverified' as const }), repair: vi.fn(), supplement: vi.fn(), stop: vi.fn(), publish: vi.fn() }
    await ensureQuickProductionReview(input(), controls)
    expect(controls.stop).toHaveBeenCalledWith('VERIFICATION_RECOVERY_LEDGER_UNAVAILABLE')
    expect(controls.repair).not.toHaveBeenCalled(); expect(controls.supplement).not.toHaveBeenCalled()
  })
  it('repairs a typed product finding even when the overall review is unverified', async () => {
    const controls = { review: async () => ({ ...pass, verdict: 'unverified' as const, findings: [{ feature_id: 'F-001', kind: 'product' as const, problem: 'reproduced functional failure' }] }),
      repair: vi.fn(), supplement: vi.fn(), stop: vi.fn(), publish: vi.fn() }
    await ensureQuickProductionReview(input(), controls)
    expect(controls.repair).toHaveBeenCalledTimes(1); expect(controls.supplement).not.toHaveBeenCalled()
    expect(readProjectAttempts('p').total['quick-review']).toBe(1)
  })
  it('sends no review or recovery after cancellation', async () => {
    const run = input(), abort = new AbortController(); abort.abort(); run.signal = abort.signal
    const controls = { review: vi.fn(), repair: vi.fn(), publish: vi.fn(), stop: vi.fn() }
    await expect(ensureQuickProductionReview(run, controls)).rejects.toThrow()
    expect(controls.review).not.toHaveBeenCalled()
  })
  it('accepts nonblocking advice with a complete pass but rejects hidden blockers and invalid categories', () => {
    expect(parseQuickProductionReview(JSON.stringify({ ...pass, findings: [{ feature_id: 'F-001', kind: 'advisory', problem: 'optional interface cleanup; no behavior impact' }] }), ['F-001'])?.verdict).toBe('pass')
    for (const kind of ['product', 'evidence', 'environment', 'invented']) {
      expect(parseQuickProductionReview(JSON.stringify({ ...pass, findings: [{ feature_id: 'F-001', kind, problem: 'blocking finding' }] }), ['F-001'])).toBeUndefined()
    }
  })
})

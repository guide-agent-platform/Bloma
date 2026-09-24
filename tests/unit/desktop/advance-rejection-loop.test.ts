/**
 * 拒收教育闭环测试（批次 E，2026-09-24）。
 *
 * 覆盖：三态拒因归类全矩阵、闭环决策（计数递增/续接指令/降级阈值）、
 * 防环（第 3 次起降级无续接+转人工文案）、推进清零（新阶段重新计数）、
 * 账本读写分离（决策不改账本）、续接指令要素（目标/拒因/动作）。
 */
import { describe, expect, it } from 'vitest'
import {
  REJECTION_LOOP_LIMIT,
  buildContinuationDirective,
  classifyRejection,
  clearRejectionOnAdvance,
  createRejectionLedger,
  decideRejectionLoop,
  registerRejection,
} from '../../../main/desktop/advance-rejection-loop'
import type { AdvanceDecision } from '../../../main/desktop/dispatcher-gate'

function reject(reason: Extract<AdvanceDecision, { decision: 'reject' }>['reason'], extra: Partial<Extract<AdvanceDecision, { decision: 'reject' }>> = {}): Extract<AdvanceDecision, { decision: 'reject' }> {
  return { decision: 'reject', reason, discardedObservations: [], education: `教育文案（${reason}）`, ...extra }
}

describe('三态拒因归类', () => {
  it('target-deny 家族：目标类六拒因', () => {
    for (const reason of ['no-marks', 'multiple-divergent', 'unknown-current', 'unknown-target', 'not-next', 'terminal'] as const) {
      expect(classifyRejection(reject(reason)), reason).toBe('target-deny')
    }
  })

  it('gate-deny：artifacts-missing；confirmation-required：确认凭据', () => {
    expect(classifyRejection(reject('artifacts-missing'))).toBe('gate-deny')
    expect(classifyRejection(reject('confirmation-required'))).toBe('confirmation-required')
  })
})

describe('闭环决策（四要素）', () => {
  it('第 1/2 次：教育+续接指令注入（可见+驱动），计数递增（落账后）', () => {
    const ledger = createRejectionLedger()
    const first = decideRejectionLoop(ledger, 'desktop-arch', reject('not-next', { expected: 'desktop-scaffold', actual: 'delivered' }))
    expect(first.degrade).toBe(false)
    expect(first.count).toBe(1)
    expect(first.education).toContain('教育文案')
    expect(first.continuation).toContain('拒收续接')
    expect(first.continuation).toContain('desktop-scaffold')
    registerRejection(ledger, 'desktop-arch', first.family, first.count) // 落账后下一次才递增

    const second = decideRejectionLoop(ledger, 'desktop-arch', reject('not-next', { expected: 'desktop-scaffold' }))
    expect(second.count).toBe(2)
    expect(second.degrade).toBe(false)
    expect(second.continuation).toBeTruthy()
  })

  it('第 3 次起（超过上限）：降级转人工——教育仍注入但无续接', () => {
    const ledger = createRejectionLedger()
    ledger.counts['desktop-arch'] = REJECTION_LOOP_LIMIT
    const third = decideRejectionLoop(ledger, 'desktop-arch', reject('artifacts-missing'))
    expect(third.degrade).toBe(true)
    expect(third.count).toBe(3)
    expect(third.continuation).toBeUndefined()
    expect(third.education).toContain('降级转人工')
    expect(third.education).toContain(String(REJECTION_LOOP_LIMIT))
  })

  it('决策不改账本（读写分离——落账显式）', () => {
    const ledger = createRejectionLedger()
    decideRejectionLoop(ledger, 'desktop-scaffold', reject('no-marks'))
    expect(ledger.counts['desktop-scaffold']).toBeUndefined()
    registerRejection(ledger, 'desktop-scaffold', 'target-deny', 1)
    expect(ledger.counts['desktop-scaffold']).toBe(1)
    expect(ledger.pendingReasons['desktop-scaffold']).toBe('target-deny')
  })

  it('education 缺失时按 family 兜底重建（不空串）', () => {
    const ledger = createRejectionLedger()
    const decision = { ...reject('no-marks'), education: '' }
    const action = decideRejectionLoop(ledger, 'desktop-scaffold', decision)
    expect(action.education.length).toBeGreaterThan(10)
  })
})

describe('推进成功清零', () => {
  it('计数与待纠正拒因清除；新阶段独立计数', () => {
    const ledger = createRejectionLedger()
    ledger.counts['desktop-arch'] = 1
    ledger.pendingReasons['desktop-arch'] = 'target-deny'
    clearRejectionOnAdvance(ledger, 'desktop-arch')
    expect(ledger.counts['desktop-arch']).toBeUndefined()
    expect(ledger.pendingReasons['desktop-arch']).toBeUndefined()
    // 其他阶段不受影响
    ledger.counts['desktop-implement'] = 1
    clearRejectionOnAdvance(ledger, 'desktop-arch')
    expect(ledger.counts['desktop-implement']).toBe(1)
  })

  it('清零后再拒收从头计数（新阶段重新计——防跨阶段累计误伤）', () => {
    const ledger = createRejectionLedger()
    ledger.counts['desktop-verify'] = 2
    clearRejectionOnAdvance(ledger, 'desktop-verify')
    const fresh = decideRejectionLoop(ledger, 'desktop-verify', reject('not-next', { expected: 'delivered' }))
    expect(fresh.count).toBe(1)
    expect(fresh.degrade).toBe(false)
  })
})

describe('续接指令要素', () => {
  it('target-deny：含唯一合法目标与锚定形态指引', () => {
    const text = buildContinuationDirective('desktop-arch', 'target-deny', 'desktop-scaffold')
    expect(text).toContain('desktop-scaffold')
    expect(text).toContain('PHASE_ADVANCE')
    expect(text).toContain('句中复述')
  })

  it('gate-deny：含产物清单与补齐动作', () => {
    const text = buildContinuationDirective('desktop-implement', 'gate-deny', undefined, {
      ...reject('artifacts-missing'),
      missingArtifacts: [{ gateId: 'delivery-doc', artifacts: ['DELIVERY.md'] }],
    })
    expect(text).toContain('DELIVERY.md')
    expect(text).toContain('委派补齐')
  })

  it('confirmation-required：含用户确认动作指引', () => {
    const text = buildContinuationDirective('desktop-verify', 'confirmation-required', undefined)
    expect(text).toContain('用户确认')
    expect(text).toContain('凭据')
  })

  it('实际声明目标入文（诊断可读）', () => {
    const text = buildContinuationDirective('desktop-arch', 'not-next' in {} ? 'gate-deny' : 'target-deny', 'desktop-scaffold', {
      ...reject('not-next'),
      actual: 'delivered',
    })
    expect(text).toContain('delivered')
  })
})

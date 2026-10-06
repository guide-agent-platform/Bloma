/**
 * 批5 质量指标地基单测（2026-10-06，讨论 turn9 口径 → 结构化终态枚举）：
 * deriveFinalOutcome 从 advance/driver 路由/修复分类收敛——「重试后绿」不抹掉本段终态。
 */
import { describe, expect, it } from 'vitest'
import { deriveFinalOutcome } from '../../../main/desktop/dispatcher-telemetry'
import type { DesktopDispatchRunResult } from '../../../main/desktop/dispatcher-loop'

function result(overrides: Partial<DesktopDispatchRunResult> = {}): DesktopDispatchRunResult {
  return {
    status: 'completed',
    loopResult: { status: 'completed' },
    ...overrides,
  } as DesktopDispatchRunResult
}

describe('deriveFinalOutcome（批5 结构化终态）', () => {
  it('advance → pass', () => {
    expect(deriveFinalOutcome(result({ advance: { decision: 'advance', target: 'desktop-verify', discardedObservations: [] } }))).toBe('pass')
  })

  it('security-fail 拒因 → security_fail（独立风险面，不被其他好看指标抵消）', () => {
    expect(deriveFinalOutcome(result({ advance: { decision: 'reject', reason: 'security-fail', discardedObservations: [], education: '' } }))).toBe('security_fail')
  })

  it('driver 路由 blocked → infra_error（环境不混入产品失败率）', () => {
    expect(
      deriveFinalOutcome(result({
        advance: { decision: 'reject', reason: 'artifacts-missing', discardedObservations: [], education: '' },
        driverReport: { routing: 'blocked' } as DesktopDispatchRunResult['driverReport'],
      })),
    ).toBe('infra_error')
  })

  it('driver 路由 fail → product_fail', () => {
    expect(
      deriveFinalOutcome(result({
        advance: { decision: 'reject', reason: 'artifacts-missing', discardedObservations: [], education: '' },
        driverReport: { routing: 'fail' } as DesktopDispatchRunResult['driverReport'],
      })),
    ).toBe('product_fail')
  })

  it('contract-invalid 拒因（mapping 类）→ test_fail', () => {
    expect(deriveFinalOutcome(result({ advance: { decision: 'reject', reason: 'contract-invalid', discardedObservations: [], education: '工程契约不合法' } }))).toBe('test_fail')
  })

  it('loop 未完成且无明确拒因 → budget_exceeded；loop 取消 → cancelled', () => {
    expect(deriveFinalOutcome(result({ loopResult: { status: 'max_turns' } as unknown as DesktopDispatchRunResult['loopResult'] }))).toBe('budget_exceeded')
    expect(deriveFinalOutcome(result({ loopResult: { status: 'cancelled' } as unknown as DesktopDispatchRunResult['loopResult'] }))).toBe('cancelled')
  })

  it('无 advance 且 loop error → infra_error；其余 → inconclusive（unknown 不当 pass）', () => {
    expect(deriveFinalOutcome(result({ status: 'error' }))).toBe('infra_error')
    expect(deriveFinalOutcome(result())).toBe('inconclusive')
  })
})

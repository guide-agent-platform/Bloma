/** bench 指标纯函数的类型声明（供 tests 单测 import；实现见 metrics.mjs）。 */

export interface FailureFlag {
  code: string
  severity: 'info' | 'warn' | 'risk'
  detail: string
}

export interface ExtendedMetrics {
  firstConstraintViolation: { violated: boolean; details: Array<{ code: string; detail: string }> }
  coreCapabilityRetention: number | 'n/a'
  protocolLeakRate: number
  effectiveDeliveryTokens: number | null
  emptyBodyRate: number
  wrongTriggerCount: number
  degenerateTurns: number
}

export function computeExtendedMetrics(evidence: Record<string, unknown>): ExtendedMetrics

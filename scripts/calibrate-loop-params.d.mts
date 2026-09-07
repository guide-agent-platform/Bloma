/** 标定脚本纯函数的类型声明（供 tests/unit/calibrate-loop-params.test.ts import；实现见同目录 .mjs）。 */

export interface TurnDistribution {
  count: number
  p50?: number
  p90?: number
  max?: number
}

export interface CalibrationReport {
  loops: { count: number; turns: TurnDistribution }
  lastInputTokens: TurnDistribution
  selfRepair: { histogram: Record<string, number>; maxAttempt: number }
  judge: { total: number; pass: number; passRate: number; byVerdict: Record<string, number> }
  suggestions: {
    maxTurnsQuick: number
    maxTurnsLongterm: number
    compactInputTokens: number | null
    editBudgetAfterTestFailure: number
  }
}

export declare function percentile(sortedValues: number[], p: number): number | undefined
export declare function analyzeEvents(events: Array<Record<string, unknown>>): CalibrationReport

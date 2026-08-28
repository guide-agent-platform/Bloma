import { afterEach, describe, expect, it } from 'vitest'
import { analyzeEvents, percentile } from '../../scripts/calibrate-loop-params.mjs'
import { resolveAgentLoopMaxTurns } from '../../main/programming-orchestrator'

/**
 * 闭环治理 PR8：loop 参数标定脚本（纯函数部分）+ maxTurns env 覆盖。
 * 脚本本体零依赖只读；CLI 侧（扫 analytics.jsonl/写报告）不进单测。
 */

function analyticsLine(eventType: string, payload: Record<string, unknown>, sessionId = 's-1'): Record<string, unknown> {
  return {
    event_id: `evt-${eventType}-${Math.random().toString(36).slice(2)}`,
    event_type: eventType,
    project_id: 'p-1',
    session_id: sessionId,
    payload,
    privacy_level: 'research_safe',
    created_at: new Date().toISOString(),
  }
}

describe('calibrate-loop-params 纯函数（闭环 PR8）', () => {
  it('percentile：最近邻秩法（ceil(p/100*n) 取第 k 个）', () => {
    expect(percentile([10, 12, 14, 16, 40], 50)).toBe(14)
    expect(percentile([10, 12, 14, 16, 40], 90)).toBe(40)
    expect(percentile([30000, 45000], 50)).toBe(30000)
    expect(percentile([], 50)).toBeUndefined()
  })

  it('四维统计：turns 分布 / 末轮 input_tokens / 修复直方图 / judge 通过率 + 建议', () => {
    const events = [
      // ① 5 次 loop 完成，turns [10,12,14,16,40]
      ...[10, 12, 14, 16, 40].map((turns) => analyticsLine('agent_loop_completed', { status: 'completed', turns })),
      // ② 两个会话的逐轮 input_tokens：末轮各取 [30000, 45000]
      ...[1, 2, 3].map((turn) => analyticsLine('agent_loop_turn', { turn, input_tokens: turn * 10000 }, 's-a')),
      ...[1, 2].map((turn) => analyticsLine('agent_loop_turn', { turn, input_tokens: turn === 1 ? 500 : 45000 }, 's-b')),
      // 一个无 input_tokens 的轮（渠道未回 usage）不参与分布
      analyticsLine('agent_loop_turn', { turn: 4 }, 's-a'),
      // ③ 修复直方图 attempt [1,1,2]
      analyticsLine('self_repair_triggered', { attempt: 1 }),
      analyticsLine('self_repair_triggered', { attempt: 1 }),
      analyticsLine('self_repair_triggered', { attempt: 2 }),
      // ④ judge：pass×2 + return×1
      analyticsLine('judge_verdict', { verdict: 'pass' }),
      analyticsLine('judge_verdict', { verdict: 'pass' }),
      analyticsLine('judge_verdict', { verdict: 'return' }),
    ]

    const report = analyzeEvents(events)
    expect(report.loops.count).toBe(5)
    expect(report.loops.turns.p50).toBe(14)
    expect(report.loops.turns.p90).toBe(40)
    expect(report.loops.turns.max).toBe(40)

    expect(report.lastInputTokens.count).toBe(2)
    expect(report.lastInputTokens.p50).toBe(30000)
    expect(report.lastInputTokens.p90).toBe(45000)
    expect(report.lastInputTokens.max).toBe(45000)

    expect(report.selfRepair.histogram).toEqual({ '1': 2, '2': 1 })
    expect(report.selfRepair.maxAttempt).toBe(2)

    expect(report.judge.total).toBe(3)
    expect(report.judge.pass).toBe(2)
    expect(report.judge.passRate).toBeCloseTo(2 / 3, 3)

    // 建议（确定性公式，人工复核口径）
    expect(report.suggestions.maxTurnsQuick).toBe(48) // max(24, ceil(40*1.2))
    expect(report.suggestions.maxTurnsLongterm).toBe(44) // max(40, ceil(40*1.1))
    expect(report.suggestions.compactInputTokens).toBe(50000) // ceil(45000/10000)*10000
    expect(report.suggestions.editBudgetAfterTestFailure).toBe(3) // max(3, maxAttempt=2)
  })

  it('空数据：各分布为空但不抛错，建议回缺省（compact 保留 100k 缺省）', () => {
    const report = analyzeEvents([])
    expect(report.loops.count).toBe(0)
    expect(report.lastInputTokens.count).toBe(0)
    expect(report.suggestions.maxTurnsQuick).toBe(24)
    expect(report.suggestions.maxTurnsLongterm).toBe(40)
    expect(report.suggestions.compactInputTokens).toBeNull()
    expect(report.suggestions.editBudgetAfterTestFailure).toBe(3)
  })
})

describe('resolveAgentLoopMaxTurns（闭环 PR8，env 可覆盖）', () => {
  const originalQuick = process.env.BLOMA_LOOP_MAX_TURNS_QUICK
  const originalLongterm = process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM

  afterEach(() => {
    if (originalQuick === undefined) delete process.env.BLOMA_LOOP_MAX_TURNS_QUICK
    else process.env.BLOMA_LOOP_MAX_TURNS_QUICK = originalQuick
    if (originalLongterm === undefined) delete process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM
    else process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM = originalLongterm
  })

  it('缺省 = 现状（quick 24 / longterm 40），零行为变化', () => {
    delete process.env.BLOMA_LOOP_MAX_TURNS_QUICK
    delete process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM
    expect(resolveAgentLoopMaxTurns('quick')).toBe(24)
    expect(resolveAgentLoopMaxTurns('longterm')).toBe(40)
  })

  it('env 覆盖生效；非法值（非数字/≤0）回退缺省', () => {
    process.env.BLOMA_LOOP_MAX_TURNS_QUICK = '32'
    process.env.BLOMA_LOOP_MAX_TURNS_LONGTERM = '60'
    expect(resolveAgentLoopMaxTurns('quick')).toBe(32)
    expect(resolveAgentLoopMaxTurns('longterm')).toBe(60)

    process.env.BLOMA_LOOP_MAX_TURNS_QUICK = 'abc'
    expect(resolveAgentLoopMaxTurns('quick')).toBe(24)
    process.env.BLOMA_LOOP_MAX_TURNS_QUICK = '0'
    expect(resolveAgentLoopMaxTurns('quick')).toBe(24)
  })
})

import { describe, expect, it } from 'vitest'
import {
  deriveConstraint,
  parseSemanticFindings,
  type SemanticFinding,
} from '../../main/review/judge-semantic'
import type { SketchRequirement } from '../../main/coding/sketch-engine'

/**
 * MVP 语义审查腿纯函数面（judge-semantic，2026-08-26，裁判域 LLM，非 AC）：
 * - 解析白名单：未知功能项 id / 非法状态丢弃；围栏容忍
 * - 严重度推导：P0 missing/deviated→blocking；P0 partial / P1 missing/deviated→major；
 *   P2 / unverified 仅备注不构成失败
 *
 * 2026-10-03 删留执行：原头注承诺的 runSemanticJudgeReview 集成与 skip 分支用例
 * （judge-semantic.ts 的 no_channel / llm_failed skip）已不存在——顶部两个 vi.mock
 * （runJudge 固定 pass / resolveChannelEnv）与成套 fixture 均为死脚手架，已删；
 * skip 分支当前全仓无覆盖，补测时再建档。
 */

const requirements: SketchRequirement[] = [
  { id: 'F-001', description: '记录日常收支', priority: 'P0' },
  { id: 'F-002', description: '按月汇总统计', priority: 'P1' },
  { id: 'F-003', description: '导出 CSV', priority: 'P2' },
]

describe('judge-semantic 纯函数', () => {
  it('parseSemanticFindings：白名单校验 + 围栏容忍 + 未知 id 丢弃', () => {
    const parsed = parseSemanticFindings(
      '```json\n{"findings":[' +
        '{"requirement_id":"F-001","status":"implemented","evidence":"addEntry()"},' +
        '{"requirement_id":"F-009","status":"missing","evidence":"幻觉 id"},' +
        '{"requirement_id":"F-002","status":"halfway","evidence":"非法状态"},' +
        '{"requirement_id":"F-002","status":"partial","evidence":"只有列表无汇总"}' +
        ']}\n```',
      requirements,
    )
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ requirement_id: 'F-001', status: 'implemented' })
    expect(parsed[1]).toMatchObject({ requirement_id: 'F-002', status: 'partial' })
    expect(() => parseSemanticFindings('no json here', requirements)).toThrow(/SEMANTIC_JUDGE_PARSE_FAILED/)
  })

  it('deriveConstraint：P0 missing→blocking；P0 partial / P1 missing→major；P2 与 unverified 不构成失败', () => {
    const blocking = deriveConstraint(
      [{ requirement_id: 'F-001', status: 'missing', evidence: '' }] as SemanticFinding[],
      requirements,
    )
    expect(blocking?.passed).toBe(false)
    expect(blocking?.detail).toContain('F-001')
    expect(blocking?.detail).toContain('未实现')

    const major = deriveConstraint(
      [
        { requirement_id: 'F-001', status: 'partial', evidence: '' },
        { requirement_id: 'F-002', status: 'deviated', evidence: '' },
      ] as SemanticFinding[],
      requirements,
    )
    expect(major?.passed).toBe(false)
    expect(major?.detail).toContain('只实现一部分')
    expect(major?.detail).toContain('做偏了')

    const tolerated = deriveConstraint(
      [
        { requirement_id: 'F-003', status: 'missing', evidence: '' },
        { requirement_id: 'F-001', status: 'unverified', evidence: 'canvas 绘制' },
      ] as SemanticFinding[],
      requirements,
    )
    expect(tolerated?.passed).toBe(true)
    expect(tolerated?.detail).toContain('待人工确认')
  })
})

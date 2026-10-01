import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'

// 规则引擎固定 pass（本文件只测语义腿的合成与降级）；readArtifactText 保真实实现
vi.mock('../../main/review/judge-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/review/judge-engine')>()
  return {
    ...actual,
    runJudge: vi.fn((): import('../../main/review/judge-engine').JudgeVerdict => ({
      verdict: 'pass',
      hard_constraints: [],
      soft_constraints: [],
      user_visible_summary: '规则全绿',
      repairable: false,
    })),
  }
})
vi.mock('../../main/platform/llm/runtime-fallback', () => ({
  // 类别路由固定给出可用 env（语义腿必跑）；skip 分支用独立用例直测 runSemanticJudgeReview
  resolveChannelEnv: vi.fn(() => ({ env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://example.com' }, channel: { id: 'ch-1' } })),
}))

import { resolveChannelEnv } from '../../main/platform/llm/runtime-fallback'
import { runJudge } from '../../main/review/judge-engine'
import { syncDocuments } from '../../main/project/document-engine'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import {
  deriveConstraint,
  parseSemanticFindings,
  runSemanticJudgeReview,
  type SemanticFinding,
} from '../../main/review/judge-semantic'
import type { ConversationTurn, SDKQuery } from '../../main/orchestration/orchestrator'
import type { SketchRequirement } from '../../main/coding/sketch-engine'

/**
 * MVP 语义审查腿（judge-semantic，2026-08-26，裁判域 LLM，非 AC）：
 * - 解析白名单：未知功能项 id / 非法状态丢弃；围栏容忍
 * - 严重度推导：P0 missing/deviated→blocking；P0 partial / P1 missing/deviated→major；
 *   P2 / unverified 仅备注不构成失败
 * - 降级：无 env / LLM 失败 → skipped 留痕，裁决不受影响（保持 ready）
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


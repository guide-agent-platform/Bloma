import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'

// 规则引擎固定 pass（本文件只测语义腿的合成与降级）；readArtifactText 保真实实现
vi.mock('../../main/judge-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/judge-engine')>()
  return {
    ...actual,
    runJudge: vi.fn((): import('../../main/judge-engine').JudgeVerdict => ({
      verdict: 'pass',
      hard_constraints: [],
      soft_constraints: [],
      user_visible_summary: '规则全绿',
      repairable: false,
    })),
  }
})
vi.mock('../../main/runtime-fallback', () => ({
  // 类别路由固定给出可用 env（语义腿必跑）；skip 分支用独立用例直测 runSemanticJudgeReview
  resolveChannelEnv: vi.fn(() => ({ env: { ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://example.com' }, channel: { id: 'ch-1' } })),
}))

import { runJudgeReview, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import { runJudge } from '../../main/judge-engine'
import { syncDocuments } from '../../main/document-engine'
import { createProject, findProject } from '../../main/project-service'
import { recordSessionActivity } from '../../main/session-service'
import {
  deriveConstraint,
  parseSemanticFindings,
  runSemanticJudgeReview,
  type SemanticFinding,
} from '../../main/judge-semantic'
import type { ConversationTurn, SDKQuery } from '../../main/orchestrator'
import type { SketchRequirement } from '../../main/sketch-engine'

/**
 * MVP 语义审查腿（judge-semantic，2026-08-26，裁判域 LLM，非 AC）：
 * - 解析白名单：未知功能项 id / 非法状态丢弃；围栏容忍
 * - 严重度推导：P0 missing/deviated→blocking；P0 partial / P1 missing/deviated→major；
 *   P2 / unverified 仅备注不构成失败
 * - runJudgeReview 合成：规则全绿 + 语义失败 → return 进既有退回流（loop 路径首败让渡）
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

describe('judge-semantic 执行与 runJudgeReview 合成', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  let project: ReturnType<typeof createProject>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-judge-sem-'))
    process.env.PROMA_HOME = home
    project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 产物：index.html + src/app.js
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><button id="add">记一笔</button></body></html>', 'utf8')
    mkdirSync(join(project.root_path, 'src'), { recursive: true })
    writeFileSync(join(project.root_path, 'src', 'app.js'), 'function addEntry(){}\n', 'utf8')
    // PRD 背板落盘（语义审查的对照基准）
    syncDocuments(
      { request_id: 'req-prd', project_id: project.project_id, session_id: 'session-sem', checkpoint: 'requirement_confirmed' },
      { project_id: project.project_id, name: project.name, positioning: '个人记账工具', requirements, acceptance: {}, out_of_scope: [], assumptions: [] } as never,
    )
    vi.mocked(runJudge).mockClear()
    // 决策日志按会话索引聚合：把测试会话注册进索引，保证 recordDecision 后 decisions.md 可断言
    recordSessionActivity('session-sem', project.project_id)
    setProgrammingEventPublisher(() => undefined)
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setProgrammingEventPublisher(() => undefined)
    vi.restoreAllMocks()
  })

  function scriptedQuery(response: string): SDKQuery {
    return async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: response }] } }
      yield { type: 'result', subtype: 'success' }
    }
  }

  it('规则全绿 + 语义发现 P1 missing → 合成 return，loop 路径首败让渡并留痕', async () => {
    const query = scriptedQuery(
      JSON.stringify({
        findings: [
          { requirement_id: 'F-001', status: 'implemented', evidence: 'addEntry()' },
          { requirement_id: 'F-002', status: 'missing', evidence: '全文无汇总实现' },
        ],
      }),
    )
    const result = await runJudgeReview({
      request_id: 'req-j1',
      session_id: 'session-sem',
      project_id: project.project_id,
      loop: { status: 'completed', turns: 5, finalText: '', toolCalls: [] },
      repairInternalized: true,
      query,
      channel_id: 'ch-1',
    })

    expect(result.outcome).toBe('blocked')
    expect(result.verdict.verdict).toBe('return')
    const semantic = result.verdict.hard_constraints.find((item) => item.name === '语义忠实性（裁判审查）')
    expect(semantic?.passed).toBe(false)
    expect(semantic?.detail).toContain('F-002')
    // 退回计数已消耗一次
    expect(findProject(project.project_id).judge_return_count).toBe(1)
    // 决策日志留痕（judge_semantic + judge_return）
    const decisionsFile = join(home, 'agent-workspaces', 'default-software-builder', 'documents', project.project_id, 'decisions.md')
    const decisions = require('node:fs').readFileSync(decisionsFile, 'utf8') as string
    expect(decisions).toContain('语义审查未过')
    expect(decisions).toContain('judge_return')
  })

  it('语义全绿 → 维持规则 verdict，ready 收尾', async () => {
    const query = scriptedQuery(
      JSON.stringify({
        findings: requirements.map((item) => ({ requirement_id: item.id, status: 'implemented', evidence: 'ok' })),
      }),
    )
    const result = await runJudgeReview({
      request_id: 'req-j2',
      session_id: 'session-sem',
      project_id: project.project_id,
      query,
      channel_id: 'ch-1',
    })

    expect(result.outcome).toBe('ready')
    expect(result.verdict.verdict).toBe('pass')
  })

  it('LLM 失败 → skipped 留痕，不改变裁决（ready）', async () => {
    const failing: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      throw new Error('CHANNEL_DOWN')
    }
    const result = await runJudgeReview({
      request_id: 'req-j3',
      session_id: 'session-sem',
      project_id: project.project_id,
      query: failing,
      channel_id: 'ch-1',
    })
    expect(result.outcome).toBe('ready')
    const decisionsFile = join(home, 'agent-workspaces', 'default-software-builder', 'documents', project.project_id, 'decisions.md')
    const decisions = require('node:fs').readFileSync(decisionsFile, 'utf8') as string
    expect(decisions).toContain('语义审查跳过')
  })

  it('runSemanticJudgeReview 直测：无 env → no_channel；超长产物截断标注进 prompt', async () => {
    const noChannel = await runSemanticJudgeReview({
      backplane: { project_id: 'p1', name: 'x', positioning: 'p', requirements, acceptance: {}, out_of_scope: [], assumptions: [] } as never,
      artifact: '<html></html>',
      query: scriptedQuery('{}'),
      env: undefined,
      sessionId: 'session-sem',
    })
    expect(noChannel).toMatchObject({ skipped: true, skipReason: 'no_channel' })

    const prompts: string[] = []
    const capture: SDKQuery = async function* (prompt: string): AsyncGenerator<SDKMessage> {
      prompts.push(prompt)
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '{"findings":[]}' }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const truncated = await runSemanticJudgeReview({
      backplane: { project_id: 'p1', name: 'x', positioning: 'p', requirements, acceptance: {}, out_of_scope: [], assumptions: [] } as never,
      artifact: 'x'.repeat(30_000),
      query: capture,
      env: { ANTHROPIC_AUTH_TOKEN: 'k' },
      sessionId: 'session-sem',
    })
    expect(truncated.skipped).toBe(false)
    expect(truncated.constraint?.passed).toBe(true)
    expect(prompts[0]).toContain('超长已截断')
    expect(prompts[0]).toContain('按月汇总统计')
  })
})

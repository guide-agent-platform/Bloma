import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/platform-services', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/document-engine', () => ({ syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })) }))
vi.mock('../../main/project-service', () => ({
  findProject: vi.fn(() => ({
    project_id: 'proj-1',
    workspace_slug: 'default-software-builder',
    name: '未命名项目',
    mode: 'quick',
    status: 'active',
    current_stage: 'clarifying',
    root_path: '/tmp/proj-1',
  })),
  updateProject: vi.fn(),
}))
vi.mock('../../main/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
vi.mock('../../main/decision-log', () => ({ recordDecision: vi.fn(), parseDecisionText: vi.fn() }))
vi.mock('../../main/guide-research', () => ({
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({ available: false, queries, results: [], summary: '' })),
}))
vi.mock('../../main/runtime-fallback', () => ({
  // 类别路由解析固定失败 → 审查 env 走 pending（向导轮 env）回退路径
  resolveChannelEnv: vi.fn(() => ({ env: undefined, channel: undefined })),
}))

import {
  handleGuideMessage,
  resolveRequirementConfirm,
} from '../../main/guide-agent-service'
import { recordDecision } from '../../main/decision-log'
import { resolvePrdBackplane, runSketchTask } from '../../main/programming-orchestrator'
import {
  PRD_REVIEW_OPTION_OVERRIDE,
  PRD_REVIEW_OPTION_SUPPLEMENT,
  parseReviewIssues,
  ruleGateReview,
} from '../../main/prd-review'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestrator'

/**
 * PRD 裁判审查门（简化版 AC，2026-08-26）：
 * - LLM 审查通过 → 草图照常（话术含「已通过裁判审查」）
 * - LLM 审查发现 blocking/major → 决策卡（忽略继续/我来补充）+ 不开草图 + 留痕
 * - override → 按原需求开草图 + prd_review_overridden 日志
 * - supplement → 提示打字补充，不开草图
 * - LLM 输出不可解析 → 规则门降级（degraded）
 * - parseReviewIssues 白名单校验（非法维度/严重度/空 claim 丢弃）
 */

const SESSION_ID = 'sess-prd-review'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '记账本，记录日常收支' },
    { id: 'F-002', description: '按月汇总统计' },
  ],
  research_queries: [],
})

/** 可编程脚本化查询：第一次调用返回 confirmJson，之后按脚本返回审查 JSON。 */
function scriptedQuery(reviewResponses: string[]): { query: SDKQuery; reviewCalls: string[] } {
  const reviewCalls: string[] = []
  let confirmServed = false
  let reviewIndex = 0
  const query: SDKQuery = async function* (prompt: string): AsyncGenerator<SDKMessage> {
    if (prompt.includes('confirm_requirements') || (!confirmServed && !prompt.includes('六维'))) {
      confirmServed = true
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: confirmJson }] } }
      yield { type: 'result', subtype: 'success' }
      return
    }
    reviewCalls.push(prompt)
    const response = reviewResponses[Math.min(reviewIndex, reviewResponses.length - 1)] ?? ''
    reviewIndex += 1
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: response }] } }
    yield { type: 'result', subtype: 'success' }
  }
  return { query, reviewCalls }
}

function makeModel(query: SDKQuery): GuideModelOptions {
  const history: ConversationTurn[] = [
    { role: 'user', content: '做个记账的东西' },
    { role: 'assistant', content: '自己用还是全家？' },
    { role: 'user', content: '自己用，要能按月看统计' },
  ]
  return {
    query,
    env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: 'https://example.com' },
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    history,
    maxTokens: 2048,
    persistAssistant: vi.fn(),
  }
}

function makeInput(content = '自己用，要能按月看统计'): AgentSendMessageInput {
  return {
    request_id: 'req-pr1',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content,
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
  }
}

const reviewPassJson = JSON.stringify({ issues: [{ dimension: 'U', severity: 'minor', location: 'F-001', claim: '措辞可更具体', evidence: ['记账'] }], clean_dimensions: ['F', 'I', 'Z', 'L', 'G'] })
const reviewFailJson = JSON.stringify({
  issues: [
    { dimension: 'F', severity: 'major', location: 'F-002', claim: '用户要的按月汇总在 PRD 里被弱化成了可选', evidence: ['按月汇总统计'] },
    { dimension: 'L', severity: 'blocking', location: 'F-001', claim: '只有记账没有查看记录的路径', evidence: ['记录日常收支'] },
  ],
  clean_dimensions: ['I', 'Z'],
})

describe('PRD 裁判审查门（简化版 AC）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let events: AgentEvent[]

  beforeEach(() => {
    // 委派审查默认开启：单测固定走直连路径（委派链路由 review-delegation 专属测试覆盖）
    process.env.BLOMA_DELEGATED_REVIEW = '0'
    const home = mkdtempSync(join(tmpdir(), 'proma-prd-review-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    events = []
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(recordDecision).mockClear()
  })

  afterEach(() => {
    delete process.env.BLOMA_DELEGATED_REVIEW
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  it('审查通过（仅 minor）→ 发 PRD 确认卡挂起（改造 3：草图待用户确认），话术含「已通过裁判审查」', async () => {
    const { query, reviewCalls } = scriptedQuery([reviewPassJson])
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(query))
    await resolveRequirementConfirm({ request_id: 'req-pr2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })

    expect(reviewCalls.length).toBe(1)
    expect(reviewCalls[0]).toContain('六维攻击面')
    expect(reviewCalls[0]).toContain('记账本')
    // 2026-08-26 改造 3：审查通过后不直接开草图，先发四段式 PRD 确认卡（人语义关接力）
    expect(runSketchTask).not.toHaveBeenCalled()
    const card = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(card).toBeTruthy()
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('已通过裁判审查'))).toBe(true)
  })

  it('审查发现 blocking/major → 决策卡 + 不开草图 + prd_review 留痕（simplified_ac）', async () => {
    const { query } = scriptedQuery([reviewFailJson])
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(query))
    events.length = 0
    await resolveRequirementConfirm({ request_id: 'req-pr2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })

    expect(runSketchTask).not.toHaveBeenCalled()
    const card = events.find((event) => event.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('prd_review')
    expect(card?.payload.questions).toEqual([
      expect.objectContaining({ id: PRD_REVIEW_OPTION_OVERRIDE, label: '忽略问题，继续生成' }),
      expect.objectContaining({ id: PRD_REVIEW_OPTION_SUPPLEMENT, label: '我来补充说明' }),
    ])
    expect(String(card?.payload.summary)).toContain('按月汇总')
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'prd_review',
        detail: expect.objectContaining({ simplified_ac: true, mode: 'llm' }),
      }),
    }))
  })

  it('override → 按原需求开草图 + overridden 留痕；supplement → 提示打字、不开草图', async () => {
    const { query } = scriptedQuery([reviewFailJson])
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(query))
    await resolveRequirementConfirm({ request_id: 'req-pr2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })

    // override 回传（卡片点击语义）
    events.length = 0
    vi.mocked(runSketchTask).mockClear()
    await handleGuideMessage(
      {
        ...makeInput('忽略问题，继续生成'),
        metadata: { source: 'card_option', selected_option_id: PRD_REVIEW_OPTION_OVERRIDE },
      },
      (event) => events.push(event),
      makeModel(scriptedQuery([reviewPassJson]).query),
    )
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runSketchTask).mock.calls[0][0].requirements).toEqual([
      { id: 'F-001', description: '记账本，记录日常收支' },
      { id: 'F-002', description: '按月汇总统计' },
    ])
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'prd_review_overridden', title: '用户忽略裁判问题，按原需求继续' }),
    }))

    // 再造一次 needs_revision，测 supplement
    const again = scriptedQuery([reviewFailJson])
    await handleGuideMessage(makeInput(), () => undefined, makeModel(again.query))
    await resolveRequirementConfirm({ request_id: 'req-pr3', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })
    events.length = 0
    vi.mocked(runSketchTask).mockClear()
    await handleGuideMessage(
      {
        ...makeInput('我来补充说明'),
        metadata: { source: 'card_option', selected_option_id: PRD_REVIEW_OPTION_SUPPLEMENT },
      },
      (event) => events.push(event),
      makeModel(scriptedQuery([reviewPassJson]).query),
    )
    expect(runSketchTask).not.toHaveBeenCalled()
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('直接打字'))).toBe(true)
  })

  it('LLM 输出不可解析 → 规则门降级（degraded），正常背板放行（改造 3：发确认卡而非直接草图）', async () => {
    const { query } = scriptedQuery(['这不是 JSON，模型抽风了'])
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(query))
    events.length = 0
    await resolveRequirementConfirm({ request_id: 'req-pr2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })

    // 规则门检查 mock 背板（定位非空、需求正常）→ pass → 发 PRD 确认卡（不直接草图）
    expect(runSketchTask).not.toHaveBeenCalled()
    expect(
      events.some(
        (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
      ),
    ).toBe(true)
  })

  it('parseReviewIssues 白名单：非法维度/严重度/空 claim 丢弃；围栏容忍', () => {
    const parsed = parseReviewIssues(
      '```json\n{"issues":[' +
        '{"dimension":"F","severity":"blocking","location":"F-001","claim":"缺核心功能","evidence":["原句"]},' +
        '{"dimension":"X","severity":"major","claim":"非法维度"},' +
        '{"dimension":"U","severity":"huge","claim":"非法严重度"},' +
        '{"dimension":"U","severity":"minor","claim":""},' +
        '{"dimension":"L","severity":"suggestion","location":"F-002","claim":"可加导出"}' +
        '],"clean_dimensions":["I"]}\n```',
    )
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ dimension: 'F', severity: 'blocking' })
    expect(parsed[1]).toMatchObject({ dimension: 'L', severity: 'suggestion' })
    expect(() => parseReviewIssues('完全没有 JSON')).toThrow(/PRD_REVIEW_PARSE_FAILED/)
  })

  it('规则门单测：空定位/零功能项 blocking；描述过短/完全重复 major', () => {
    const broken = ruleGateReview({ name: 'x', positioning: '', requirements: [] } as never)
    expect(broken.verdict).toBe('needs_revision')
    expect(broken.issues.map((issue) => issue.severity)).toEqual(['blocking', 'blocking'])

    const duplicated = ruleGateReview({
      name: 'x',
      positioning: '记账工具',
      requirements: [
        { id: 'F-001', description: '记录日常收支' },
        { id: 'F-002', description: '记录日常收支' },
        { id: 'F-003', description: '统计' },
      ],
    } as never)
    expect(duplicated.verdict).toBe('needs_revision')
    expect(duplicated.issues).toEqual([
      expect.objectContaining({ dimension: 'I', severity: 'major', location: 'F-002' }),
      expect.objectContaining({ dimension: 'U', severity: 'major', location: 'F-003' }),
    ])

    const healthy = ruleGateReview({
      name: 'x',
      positioning: '记账工具',
      requirements: [{ id: 'F-001', description: '记录日常收支' }],
    } as never)
    expect(healthy.verdict).toBe('pass')
  })
})

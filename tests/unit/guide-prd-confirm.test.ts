import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/coding/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })),
  setProgrammingEventPublisher: vi.fn(),
  // 保真对齐真实实现（审查 P1-2）：max+1 + padStart(3,'0')，而非 length+1——
  // 防 id 空洞/≥10 条时掩盖编号类 bug
  nextRequirementId: vi.fn((existing: Array<{ id: string }>) => {
    const max = existing.reduce((acc, item) => {
      const match = /^F-(\d+)$/.exec(item.id)
      return match ? Math.max(acc, Number(match[1])) : acc
    }, 0)
    return `F-${String(max + 1).padStart(3, '0')}`
  }),
  refineModificationDescription: vi.fn((text: string) => text.trim()),
}))
vi.mock('../../main/delivery/track-analytics', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/project/document-engine', () => ({
  syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })),
  markPrdUserConfirmed: vi.fn(() => ({ project_id: 'proj-1', user_confirmed_at: '2026-08-26T00:00:00.000Z' })),
}))
vi.mock('../../main/project/project-service', () => ({
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
vi.mock('../../main/platform/sessions/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/platform/sessions/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
vi.mock('../../main/project/decision-log', () => ({ recordDecision: vi.fn(), parseDecisionText: vi.fn() }))
vi.mock('../../main/guide/guide-research', () => ({
    normalizeResearchQuery: (q: string) => q,
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({ available: false, queries, results: [], summary: '' })),
}))
vi.mock('../../main/platform/llm/runtime-fallback', () => ({
  resolveChannelEnv: vi.fn(() => ({ env: undefined, channel: undefined })),
}))

import { handleGuideMessage, resolveRequirementConfirm } from '../../main/guide/guide-agent-service'
import { recordDecision } from '../../main/project/decision-log'
import { researchMarketSimilar } from '../../main/guide/guide-research'
import { trackAnalytics } from '../../main/delivery/track-analytics'
import { markPrdUserConfirmed } from '../../main/project/document-engine'
import { resolvePrdBackplane, runSketchTask } from '../../main/coding/programming-orchestrator'
import {
  PRD_CONFIRM_OPTION_ADJUST,
  PRD_CONFIRM_OPTION_CONFIRM,
  resolvePrdConfirmCardAnswer,
} from '../../main/guide/prd-confirm'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestration/orchestrator'

/**
 * PRD 用户确认门（2026-08-26 改造 3）：
 * - 六维审查通过 → 四段式确认卡（kind='prd_confirm'，背板结构化投影）+ 不开草图（挂起）
 * - confirm 回传 → markPrdUserConfirmed 落盘 + 开草图 + 决策留痕
 * - adjust 回传带实质文本 → 直接进修订闭环（归一化并入→重走 PRD 管线→新确认卡），不再咐提示
 * - dismiss 回传 → 消费 pending + 引导回对话，不开工
 * - 无 pending 的选项回传不拦截（重启丢失/重复点击防误拦）
 */

const SESSION_ID = 'sess-prd-confirm'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '记账本，记录日常收支' },
    { id: 'F-002', description: '按月汇总统计' },
  ],
  research_queries: [],
})

const reviewPassJson = JSON.stringify({
  issues: [{ dimension: 'U', severity: 'minor', location: 'F-001', claim: '措辞可更具体', evidence: ['记账'] }],
  clean_dimensions: ['F', 'I', 'Z', 'L', 'G'],
})

/** 脚本化查询：confirm 轮返回 confirmJson，审查轮返回 reviewPassJson。 */
function scriptedQuery(): SDKQuery {
  let confirmServed = false
  return async function* (prompt: string): AsyncGenerator<SDKMessage> {
    if (!confirmServed && !prompt.includes('六维')) {
      confirmServed = true
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: confirmJson }] } }
      yield { type: 'result', subtype: 'success' }
      return
    }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reviewPassJson }] } }
    yield { type: 'result', subtype: 'success' }
  }
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

function makeInput(overrides: Partial<AgentSendMessageInput> = {}): AgentSendMessageInput {
  return {
    request_id: 'req-pc1',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content: '自己用，要能按月看统计',
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
    ...overrides,
  }
}

describe('PRD 用户确认门（改造 3）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let events: AgentEvent[]

  beforeEach(() => {
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    process.env.BLOMA_GUIDE_LOOP = '0'
    // 委派审查固定关：单测走直连（委派链路由 review-delegation 专属测试覆盖）
    process.env.BLOMA_DELEGATED_REVIEW = '0'
    // R2（2026-09-12）：市调想法来源相关用例（想法提炼/回退原始条目）钉到 scrape 模式
    process.env.BLOMA_RESEARCH_MODE = 'scrape'
    const home = mkdtempSync(join(tmpdir(), 'proma-prd-confirm-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    events = []
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(recordDecision).mockClear()
    vi.mocked(markPrdUserConfirmed).mockClear()
  })

  afterEach(() => {
    delete process.env.BLOMA_DELEGATED_REVIEW
    delete process.env.BLOMA_RESEARCH_MODE
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  /** 完整流到确认卡：向导 confirm 判定 → 需求弹窗确认（模拟用户点「确认」）→ PRD 落盘 → 六维审查通过 → 发确认卡 */
  async function startConfirmFlow(): Promise<void> {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(scriptedQuery()))
    await resolveRequirementConfirm({ request_id: 'req-pc2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })
  }

  it('勾选采纳市调想法（2026-08-29 灵感参考）→ 并入需求清单追加条目，decision 留痕；LLM 提炼失败回退原始条目', async () => {
    // 市调可用：distill 调模型（scriptedQuery 第二次返 reviewPassJson，解析不出 ideas）→ 回退原始条目当想法
    vi.mocked(researchMarketSimilar).mockResolvedValueOnce({
      available: true,
      queries: ['做个记账的东西'],
      results: [
        { title: '虚拟键盘实时弹奏类工具盘点', url: 'https://www.example.com/studio', snippet: '按键即发声，支持多音色' },
        { title: '步进音序器编曲工具', url: 'https://example.org/seq', snippet: '网格排布音符' },
      ],
      summary: '1. 虚拟键盘实时弹奏类工具盘点 — example.com\n按键即发声，支持多音色\n2. 步进音序器编曲工具 — example.org\n网格排布音符',
    })

    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(scriptedQuery()))

    const confirmEvent = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'requirement_confirm',
    )
    expect(confirmEvent).toBeTruthy()
    const ideas = (confirmEvent!.payload as { ideas?: Array<{ label: string; source: string }> }).ideas ?? []
    expect(ideas).toHaveLength(2)
    expect(ideas[0].label).toContain('虚拟键盘')
    expect(ideas[0].source).toBe('example.com') // www. 剥除

    // 用户勾选第一条想法确认 → 并入需求清单（PRD 背板透传 requirements 可见）+ decision 留痕
    await resolveRequirementConfirm({
      request_id: 'req-pc2',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      adopted_ideas: [ideas[0].label, '嘉绗不存在的想法'],
    })
    // ② 后主路调用带第三参 onClarification（收集追问信号），只断前两参中的清单。
    const adoptCall = vi.mocked(resolvePrdBackplane).mock.calls.at(-1)
    expect(adoptCall?.[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ description: `参考市面做法：${ideas[0].label}` }),
      ]),
    )
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'requirement_confirmed',
        detail: expect.objectContaining({ adopted_ideas: [ideas[0].label] }), // 篡改/不存在的 label 被过滤
      }),
    }))
  })

  it('发卡前市调提炼段（审查 P1-1）：市调可用时 ideas 进 prd_confirm 卡 payload；市调抛错仍发卡不阻断（降级兑现）', async () => {
    vi.mocked(researchMarketSimilar).mockImplementationOnce(async () => {
      throw new Error('fetch failed')
    })
    await startConfirmFlow()

    // 市调抛错 → ideas 空，确认卡仍发出（增强不是依赖）
    let card = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(card).toBeTruthy()
    expect((card!.payload as { ideas?: unknown[] }).ideas ?? []).toHaveLength(0)

    // 市调可用（fallback 提炼）→ ideas 随卡透出（注意：一次 startConfirmFlow 调两次市调——弹窗+发卡，mock 需栈两次）
    events = []
    const availableResearch = {
      available: true,
      queries: ['q'],
      results: [{ title: '虚拟键盘实时弹奏类工具', url: 'https://www.example.com/studio', snippet: '按键即发声' }],
      summary: '虚拟键盘实时弹奏类工具 — example.com 按键即发声',
    }
    vi.mocked(researchMarketSimilar).mockResolvedValueOnce(availableResearch)
    vi.mocked(researchMarketSimilar).mockResolvedValueOnce(availableResearch)
    await startConfirmFlow()
    card = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(card).toBeTruthy()
    const ideas = (card!.payload as { ideas?: Array<{ label: string; source: string }> }).ideas ?? []
    expect(ideas).toHaveLength(1)
    expect(ideas[0].label).toContain('虚拟键盘')
    expect(ideas[0].source).toBe('example.com')
  })

  it('审查通过 → 发四段式确认卡（kind=prd_confirm，背板投影）且不开草图', async () => {
    await startConfirmFlow()

    const card = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(card).toBeTruthy()
    const payload = card!.payload as {
      positioning: string
      requirements: Array<{ id: string; priority: string; story: string; assertions: string[] }>
      out_of_scope: string[]
      expanded: boolean
    }
    expect(payload.positioning).toBe('个人记账工具')
    expect(payload.requirements).toHaveLength(2)
    expect(payload.requirements[0]).toMatchObject({ id: 'F-001' })
    // 断言物化进卡（缺省回退默认断言），P0/P2 优先级投影
    expect(payload.requirements[0].assertions.length).toBeGreaterThan(0)
    expect(payload.requirements[0].priority).toBe('P0')
    // C1a（P1，审计⑧）显影 + 2026-09-25 拍板收紧：本项目为本地工具（记账 personal_tool），
    // 「记录」留存词命中本地优先豁免 → 徽标不亮（localStorage 持久化合法一等实现，
    // 随手计算器案根治）；纯展示项照旧不带。web_fullstack 品类保留旧行为（另测）。
    const reqs = payload.requirements as Array<{ id: string; implies_backend?: boolean }>
    expect(reqs.find((r) => r.id === 'F-001')?.implies_backend).toBeUndefined()
    expect(reqs.find((r) => r.id === 'F-002')?.implies_backend).toBeUndefined()
    expect(payload.expanded).toBe(false)
    // 挂起：不直接开草图，话术引导用户过目
    expect(runSketchTask).not.toHaveBeenCalled()
    const texts = events.filter((event) => event.type === 'message_delta').map((event) => (event.payload as { text?: string }).text ?? '')
    expect(texts.join('\n')).toContain('请你过目')
  })

  it('confirm 回传 → user_confirmed_at 落盘 + 开草图 + 决策留痕', async () => {
    await startConfirmFlow()
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(trackAnalytics).mockClear()

    await handleGuideMessage(
      makeInput({ content: '确认这份 PRD，开始画草图。', metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM } }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    expect(markPrdUserConfirmed).toHaveBeenCalledWith('proj-1')
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    const decisions = vi.mocked(recordDecision).mock.calls.map((call) => call[0].entry)
    expect(decisions.some((entry) => entry.type === 'prd_confirm' && entry.title.includes('已确认'))).toBe(true)
    // Phase 7 U5 J5：scope_confirmed 埋点（需求版本+key_tasks 标识随确认动作留存）
    const scoped = vi.mocked(trackAnalytics).mock.calls.map((call) => call[0].event).find((event) => event.event_type === 'scope_confirmed')
    expect(scoped).toBeDefined()
    expect(scoped?.payload.via).toBe('prd_confirm_card')
    expect(Array.isArray(scoped?.payload.requirement_ids)).toBe(true)
    expect(scoped?.payload.user_confirmed_at).toBe('2026-08-26T00:00:00.000Z')
  })

  it('B-1 回归（2026-09-02 对抗审查）：盘上权威清单含 behavior_assertions 时完整传入 runSketchTask——探针链不瘦身', async () => {
    await startConfirmFlow()
    vi.mocked(runSketchTask).mockClear()
    // 盘上背板（markPrdUserConfirmed 读盘返回）：enrichment 断言在场
    vi.mocked(markPrdUserConfirmed).mockReturnValueOnce({
      project_id: 'proj-1',
      user_confirmed_at: '2026-09-02T00:00:00.000Z',
      name: '记账本',
      positioning: '记账本，记录日常收支',
      requirements: [
        { id: 'F-001', description: '记账本，记录日常收支', behavior_assertions: ['WHEN 点击保存按钮 → 列表新增一条记录'], priority: 'P0' },
        { id: 'F-002', description: '按月汇总统计', behavior_assertions: ['WHEN 点击汇总按钮 → 汇总数值更新'], priority: 'P0' },
      ],
      acceptance: {},
      out_of_scope: [],
      assumptions: [],
    } as unknown as ReturnType<typeof markPrdUserConfirmed>)

    await handleGuideMessage(
      makeInput({ content: '确认这份 PRD，开始画草图。', metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM } }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    expect(runSketchTask).toHaveBeenCalledTimes(1)
    const call = vi.mocked(runSketchTask).mock.calls[0]?.[0]
    // 断言完整传入（此前被 map 瘦身为 {id, description}，GWT 探针整体退化存在性检查）
    expect(call?.requirements?.[0]?.behavior_assertions).toEqual(['WHEN 点击保存按钮 → 列表新增一条记录'])
    expect(call?.requirements?.[1]?.behavior_assertions).toEqual(['WHEN 点击汇总按钮 → 汇总数值更新'])
  })

  it('adjust 回传带文本 → 直接进修订闭环：ack 后重走 PRD 管线出新确认卡，不再咐「指出条目」（2026-08-27 线上案例 02239079）', async () => {
    await startConfirmFlow()
    events.length = 0

    await handleGuideMessage(
      makeInput({ content: '我想要更多有趣的功能', metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_ADJUST } }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    expect(runSketchTask).not.toHaveBeenCalled()
    expect(markPrdUserConfirmed).not.toHaveBeenCalled()
    const texts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => (event.payload as { text?: string }).text ?? '')
      .join('\n')
    // ack 话术承诺修订，不再把用户咐在「你想调整哪里」
    expect(texts).toContain('修订 PRD')
    expect(texts).not.toContain('你想调整哪里')
    // 修订链重走 PRD 管线：新确认卡再次挂起（含首张共 2 张 prd_confirm 事件）
    const confirmCards = events.filter(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(confirmCards).toHaveLength(1)
    // 修订后的清单在原清单基础上追加（归一化 fallback append，非推倒重来）
    const card = confirmCards[0]!.payload as { requirements?: Array<{ id: string }> }
    expect(card.requirements?.map((item) => item.id)).toContain('F-003')
    expect(card.requirements?.map((item) => item.id)).toContain('F-001')
  })

  it('dismiss 回传 → 消费 pending + 引导回对话，不开工不发新卡', async () => {
    await startConfirmFlow()
    events.length = 0

    await handleGuideMessage(
      makeInput({ content: '稍后再说，先不确认。', metadata: { source: 'card_option', selected_option_id: 'prd_confirm_dismiss' } }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    expect(runSketchTask).not.toHaveBeenCalled()
    expect(markPrdUserConfirmed).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
    const texts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => (event.payload as { text?: string }).text ?? '')
      .join('\n')
    expect(texts).toContain('先不确认这份 PRD')
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ title: '用户暂不确认 PRD，回对话继续' }),
    }))
  })

  it('无 pending 的选项回传不拦截（重复点击/重启丢失防误拦）', async () => {
    // 直接发 confirm 选项消息（从未发过卡）：resolvePrdConfirmCardAnswer 应返回 undefined
    const decision = resolvePrdConfirmCardAnswer(
      makeInput({ metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM } }),
    )
    expect(decision).toBeUndefined()
    expect(markPrdUserConfirmed).not.toHaveBeenCalled()
  })
})

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
  nextRequirementId: vi.fn((existing: Array<{ id: string }>) => `F-00${existing.length + 1}`),
  refineModificationDescription: vi.fn((text: string) => text.trim()),
}))
vi.mock('../../main/platform-services', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/document-engine', () => ({
  syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })),
  markPrdUserConfirmed: vi.fn(() => ({ project_id: 'proj-1', user_confirmed_at: '2026-08-26T00:00:00.000Z' })),
}))
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
  resolveChannelEnv: vi.fn(() => ({ env: undefined, channel: undefined })),
}))

import { handleGuideMessage, resolveRequirementConfirm } from '../../main/guide-agent-service'
import { recordDecision } from '../../main/decision-log'
import { markPrdUserConfirmed } from '../../main/document-engine'
import { resolvePrdBackplane, runSketchTask } from '../../main/programming-orchestrator'
import {
  PRD_CONFIRM_OPTION_ADJUST,
  PRD_CONFIRM_OPTION_CONFIRM,
  resolvePrdConfirmCardAnswer,
} from '../../main/prd-confirm'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestrator'

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
    // 委派审查固定关：单测走直连（委派链路由 review-delegation 专属测试覆盖）
    process.env.BLOMA_DELEGATED_REVIEW = '0'
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
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  /** 完整流到确认卡：向导 confirm 判定 → 需求弹窗确认（模拟用户点「确认」）→ PRD 落盘 → 六维审查通过 → 发确认卡 */
  async function startConfirmFlow(): Promise<void> {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(scriptedQuery()))
    await resolveRequirementConfirm({ request_id: 'req-pc2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })
  }

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
    expect(payload.expanded).toBe(false)
    // 挂起：不直接开草图，话术引导用户过目
    expect(runSketchTask).not.toHaveBeenCalled()
    const texts = events.filter((event) => event.type === 'message_delta').map((event) => (event.payload as { text?: string }).text ?? '')
    expect(texts.join('\n')).toContain('请你过目')
  })

  it('confirm 回传 → user_confirmed_at 落盘 + 开草图 + 决策留痕', async () => {
    await startConfirmFlow()
    vi.mocked(runSketchTask).mockClear()

    await handleGuideMessage(
      makeInput({ content: '确认这份 PRD，开始画草图。', metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM } }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    expect(markPrdUserConfirmed).toHaveBeenCalledWith('proj-1')
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    const decisions = vi.mocked(recordDecision).mock.calls.map((call) => call[0].entry)
    expect(decisions.some((entry) => entry.type === 'prd_confirm' && entry.title.includes('已确认'))).toBe(true)
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

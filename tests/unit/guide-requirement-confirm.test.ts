import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideBlocks } from '../support/guide-decide-stream'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/coding/programming-orchestrator', () => ({
  resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/delivery/track-analytics', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/project/document-engine', () => ({ syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })) }))
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
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({
    available: true,
    queries,
    results: [{ title: '十款记账应用盘点', url: 'https://a.example.com/ledger', snippet: '流行的记账工具对比' }],
    summary: '1. 十款记账应用盘点 — a.example.com\n   流行的记账工具对比',
  })),
}))

import {
  handleGuideMessage,
  resolveRequirementConfirm,
  takePendingRequirementConfirm,
} from '../../main/guide/guide-agent-service'
import { recordDecision } from '../../main/project/decision-log'
import { resolvePrdBackplane } from '../../main/coding/programming-orchestrator'
import { syncDocuments } from '../../main/project/document-engine'
import { researchMarketSimilar } from '../../main/guide/guide-research'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestration/orchestrator'

/**
 * 需求确认弹窗（confirm_requirements，2026-08-26）：
 * - 模型判定需求成型 → 市调 → 弹窗事件 + pending 状态，不直接开工；
 * - 用户 confirm（勾选子集）→ PRD 前移（requirement_confirmed 检查点）→ 以勾选集开工；
 * - 用户 delegate → 向导清单全量开工；
 * - 无 pending → started:false（幂等，弹窗重复提交不炸）。
 */

const SESSION_ID = 'sess-req-confirm'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '记账本，记录日常收支', origin: 'user' },
    { id: 'F-002', description: '按月汇总统计', origin: 'guide' },
  ],
  research_queries: ['记账 应用 推荐'],
})

function makeModel(): GuideModelOptions {
  const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: decideBlocks(confirmJson) } }
    yield { type: 'result', subtype: 'success' }
  }
  const history: ConversationTurn[] = [
    { role: 'user', content: '做个记账的东西' },
    { role: 'assistant', content: '自己用还是全家？' },
    { role: 'user', content: '自己用' },
  ]
  return {
    query,
    env: { PATH: 'x' },
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    history,
    maxTokens: 2048,
    persistAssistant: vi.fn(),
  }
}

function makeInput(): AgentSendMessageInput {
  return {
    request_id: 'req-c1',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content: '自己用，还要能按月看统计',
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
  }
}

describe('需求确认弹窗（confirm_requirements）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  let events: AgentEvent[]
  let persistSystem: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    // 委派审查默认开启：单测固定走直连路径（委派链路由 review-delegation 专属测试覆盖）
    // R2（2026-09-12）：本文件多数用例验证 scrape 市调链路（搜索/想法提炼），
    // 钉到 scrape；agent 模式专属用例内自行改回
    process.env.BLOMA_RESEARCH_MODE = 'scrape'
    home = mkdtempSync(join(tmpdir(), 'proma-req-confirm-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    events = []
    // 按生产语义落盘（orchestrator 传入的 persistSystem 会写会话 JSONL），供回访追溯断言
    persistSystem = vi.fn((text: string) => {
      appendFileSync(
        join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
        JSON.stringify({ role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() }) + '\n',
      )
    })
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(syncDocuments).mockClear()
    vi.mocked(recordDecision).mockClear()
    vi.mocked(researchMarketSimilar).mockClear()
  })

  afterEach(() => {
    delete process.env.BLOMA_RESEARCH_MODE
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  it('R2 缺省 agent 模式：零网络请求（researchMarketSimilar 零调用），想法来自模型灵感且 source=AI 建议', async () => {
    delete process.env.BLOMA_RESEARCH_MODE
    let call = 0
    const query: SDKQuery = async function* () {
      call += 1
      // 首调：向导决策（guide_decide 工具化）；次调：agent 灵感建议 JSON
      if (call === 1) {
        yield { type: 'assistant', message: { role: 'assistant', content: decideBlocks(confirmJson) } }
      } else {
        const text = JSON.stringify({ ideas: [{ label: '账单日历视图', note: '按日历看收支分布，超支日标红' }] })
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
      }
      yield { type: 'result', subtype: 'success' }
    }
    const model: GuideModelOptions = { ...makeModel(), query }
    await handleGuideMessage(makeInput(), (event) => events.push(event), model, undefined, persistSystem)
    expect(researchMarketSimilar).not.toHaveBeenCalled()
    const card = events.find((event) => event.type === 'user_decision_required')
    expect(card).toBeTruthy()
    const payload = JSON.stringify(card?.payload)
    expect(payload).toContain('账单日历视图')
    expect(payload).toContain('AI 建议')
    expect(payload).toContain('"mode":"agent"')
  })

  it('模型判定需求成型 → 执行市调并弹确认窗，不直接开工', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    // 市调按模型的 research_queries 执行（增强注入弹窗）；查询构造失败时候选词优先进入市调
    expect(researchMarketSimilar).toHaveBeenCalledWith(expect.arrayContaining(['记账 应用 推荐']))
    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect(confirmEvent?.payload.kind).toBe('requirement_confirm')
    expect(confirmEvent?.payload.requirements).toHaveLength(2)
    // 向导补充可见（2026-08-27）：origin 透传到弹窗，渲染「向导补充」徽标
    const confirmRequirements = (confirmEvent?.payload as { requirements?: Array<{ id: string; origin?: string }> }).requirements ?? []
    expect(confirmRequirements[0]).toMatchObject({ id: 'F-001', origin: 'user' })
    expect(confirmRequirements[1]).toMatchObject({ id: 'F-002', origin: 'guide' })
    expect(confirmEvent?.payload.research).toMatchObject({ available: true })
    // 落盘留痕：弹窗内容可事后追溯 + 决策日志
    expect(persistSystem).toHaveBeenCalledWith(expect.stringContaining('[decision-card] 需求确认：'))
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirm_card' }),
    }))
    // 阶段进入待决策
    expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'blocked_for_user_decision')).toBe(true)
    // pending 状态已建立（供 IPC 回传使用）
    expect(takePendingRequirementConfirm('proj-1')).toBeDefined()
    // 弹窗后 pending 被取走（幂等），再来一次为空
    expect(takePendingRequirementConfirm('proj-1')).toBeUndefined()
  })

  it('用户勾选子集 confirm → PRD 前移落盘（requirement_confirmed）+ 审查后发 PRD 确认卡挂起（改造 3）', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    const result = await resolveRequirementConfirm({
      request_id: 'req-c2',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      requirement_ids: ['F-002'],
    })

    expect(result).toMatchObject({ started: true, prd_written: true })
    // PRD 前移：勾选后的需求集 + requirement_confirmed 检查点（origin 随条目透传）。
    // ② 后主路调用带第三参 onClarification（收集追问信号），只断前两参。
    const prdCall = vi.mocked(resolvePrdBackplane).mock.calls[0]
    expect(prdCall?.[1]).toEqual([
      { id: 'F-002', description: '按月汇总统计', origin: 'guide' },
    ])
    expect(syncDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: 'requirement_confirmed', project_id: 'proj-1' }),
      expect.anything(),
    )
    // 改造 3：审查（本例 mock 无审查响应→规则门降级过）后不直接开草图，
    // 先发四段式 PRD 确认卡挂起，等用户确认卡回传才开工
    const prdCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(prdCard).toBeTruthy()
    expect((prdCard!.payload as { requirements?: Array<{ id: string }> }).requirements).toEqual([
      expect.objectContaining({ id: 'F-002' }),
    ])
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirmed', title: '用户确认需求清单' }),
    }))
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('产品需求文档'))).toBe(true)
  })

  it('用户选择「由向导决定」（delegate）→ PRD 确认卡同样挂起（清单全量投影），决策注明让渡', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    await resolveRequirementConfirm({
      request_id: 'req-c3',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'delegate',
    })

    // 改造 3：delegate 同样进确认门（全量清单投影），不直接开工
    const prdCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(prdCard).toBeTruthy()
    expect((prdCard!.payload as { requirements?: Array<{ id: string }> }).requirements).toEqual([
      expect.objectContaining({ id: 'F-001' }),
      expect.objectContaining({ id: 'F-002' }),
    ])
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirmed', title: '用户让渡：由向导决定需求' }),
    }))
  })

  it('无 pending（重复提交/重启丢失）→ started:false 幂等不炸', async () => {
    const result = await resolveRequirementConfirm({
      request_id: 'req-c4',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      requirement_ids: ['F-001'],
    })
    expect(result).toMatchObject({ started: false, prd_written: false })
  })

  it('确认后用户停止（AGENT_STOP signal 预 abort）→ 管线零推进：不前移 PRD、不审查、不开草图（abb1a19f 断链修复）', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(syncDocuments).mockClear()

    const controller = new AbortController()
    controller.abort()
    const result = await resolveRequirementConfirm(
      {
        request_id: 'req-c6',
        session_id: SESSION_ID,
        project_id: 'proj-1',
        decision: 'confirm',
      },
      controller.signal,
    )
    expect(result).toMatchObject({ started: false, prd_written: false })
    expect(resolvePrdBackplane).not.toHaveBeenCalled()
    expect(syncDocuments).not.toHaveBeenCalled()
  })

  it('确认后在 PRD 前移完成后停止（审查前 abort）→ 不跑审查、不发卡、不开草图', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)
    // 前移已完成（prd_written=true）但审查未开始时用户停止：审查/卡片/草图全部不再推进
    const controller = new AbortController()
    const prdBackplaneOnce = vi.mocked(resolvePrdBackplane).mockImplementationOnce(async (_input, requirements) => {
      controller.abort() // 前移完成的瞬间用户点停止
      return { name: '未命名项目', positioning: 'p', requirements } as never
    })
    const result = await resolveRequirementConfirm(
      {
        request_id: 'req-c7',
        session_id: SESSION_ID,
        project_id: 'proj-1',
        decision: 'confirm',
      },
      controller.signal,
    )
    prdBackplaneOnce.mockRestore()
    expect(result).toMatchObject({ started: true, prd_written: true })
    expect(syncDocuments).toHaveBeenCalledTimes(1) // 前移本身已落盘
    // 不发确认卡/审查卡（无 user_decision_required、无 PRD 确认旁白）
    const after = events.filter((event) => event.type === 'user_decision_required')
    expect(after.filter((event) => event.payload?.kind === 'prd_confirm' || event.payload?.kind === 'prd_review')).toHaveLength(0)
  })

  it('PRD 前移失败 → 不阻断草图（话术如实降级），仍开工', async () => {
    vi.mocked(resolvePrdBackplane).mockRejectedValueOnce(new Error('CHANNEL_DOWN'))
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    const result = await resolveRequirementConfirm({
      request_id: 'req-c5',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
    })

    expect(result).toMatchObject({ started: true, prd_written: false })
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('没能生成'))).toBe(true)
    expect(deltas.some((text) => text.includes('直接画草图'))).toBe(true)
    // 会话 JSONL 落盘了弹窗留痕（回访可追溯）
    const sessionText = readFileSync(join(home, 'agent-sessions', `${SESSION_ID}.jsonl`), 'utf8')
    expect(sessionText).toContain('[decision-card] 需求确认：')
  })
})

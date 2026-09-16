/**
 * 向导 loop 化测试（Phase 10，2026-09-16，BLOMA_GUIDE_LOOP）。
 *
 * 锁定口径：
 * - off（缺省）：澄清腿维持单次流式 JSON 现状（query 无 tools、行为与旧路径一致）；
 * - on·决策：模型经 guide_decide 工具提交 ask_clarification → 下游路由照旧弹澄清卡
 *   （决策从工具入参来，不再经 parseGuideJson）；
 * - on·自由对话：无决策的文本回复 → 只收口不弹卡不改阶段；连续 ≥3 轮 → 下轮 task
 *   注入宿主提醒；
 * - on·失败：loop 异常 → 回退规则路由（与旧路径同款兜底）；
 * - guide-tools 单元：决策参数校验/单次预算/只读事实工具。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/platform-services', () => ({
  trackAnalytics: vi.fn(),
}))
vi.mock('../../main/project-service', () => ({
  findProject: vi.fn(() => ({
    project_id: 'proj-1',
    workspace_slug: 'default-software-builder',
    name: '未命名项目',
    mode: 'quick',
    template_type: 'web_fullstack',
    status: 'active',
    current_stage: 'clarifying',
    root_path: '/tmp/proj-1',
  })),
  updateProject: vi.fn(),
}))
vi.mock('../../main/session-service', () => ({
  readPrimaryIntent: vi.fn(() => undefined),
  isAutoDelegationText: () => false,
}))
vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
  parseDecisionText: vi.fn(() => []),
}))
vi.mock('../../main/guide-research', () => ({
  researchMarketSimilar: vi.fn(async () => ({ available: false, items: [] })),
  normalizeResearchQuery: vi.fn((q: string) => q),
}))

import { handleGuideMessage } from '../../main/guide-agent-service'
import { buildGuideTools, guideLoopEnabled, type GuideDecision } from '../../main/guide/guide-tools'
import type { ConversationTurn, GuideModelOptions, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'

const ORIGINAL_GUIDE_LOOP = process.env.BLOMA_GUIDE_LOOP
const ORIGINAL_PROMA_HOME = process.env.PROMA_HOME

function makeInput(content = '帮我做一个记账小工具，记录每天花销'): AgentSendMessageInput {
  return {
    request_id: 'req-guide-loop',
    session_id: 'sess-guide-loop',
    project_id: 'proj-1',
    content,
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
  }
}

interface Captured {
  prompts: string[]
  histories: ConversationTurn[][]
  toolCounts: number[]
  /** 每次调用收到的最后一个 user 轮文本（loop 路径的 task 在这里，query prompt 为空串） */
  lastUserTexts: string[]
}

function textOfTurn(turn: ConversationTurn | undefined): string {
  if (!turn) return ''
  if (typeof turn.content === 'string') return turn.content
  return Array.isArray(turn.content) ? turn.content.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''
}

function makeModel(script: (call: number, options: SDKQueryOptions) => SDKMessage[], history: ConversationTurn[] = []): GuideModelOptions & { captured: Captured } {
  const captured: Captured = { prompts: [], histories: [], toolCounts: [], lastUserTexts: [] }
  let call = 0
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
    const index = call
    call += 1
    captured.prompts.push(_prompt)
    captured.histories.push(options.history ?? [])
    captured.toolCounts.push((options.tools ?? []).length)
    const msgs = options.messages ?? []
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user')
    captured.lastUserTexts.push(textOfTurn(lastUser))
    yield* script(index, options)[Symbol.iterator]()
  }
  return {
    query,
    env: { PATH: 'x' },
    signal: new AbortController().signal,
    sessionId: 'sess-guide-loop',
    history,
    maxTokens: 4096,
    persistAssistant: vi.fn(),
    captured,
  }
}

const decideAskJson = {
  action: 'ask_clarification',
  reply: '想先确认一下：主要记个人流水还是家庭共享账本？',
  questions: [
    { id: 'answer-a', label: '个人流水', description: '单用户快速记账' },
    { id: 'auto', label: '你帮我决定', description: '交给我，按常见做法先出一版' },
  ],
}

describe('向导 loop 化（BLOMA_GUIDE_LOOP）', () => {
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-guide-loop-'))
  })
  afterEach(() => {
    if (ORIGINAL_GUIDE_LOOP === undefined) delete process.env.BLOMA_GUIDE_LOOP
    else process.env.BLOMA_GUIDE_LOOP = ORIGINAL_GUIDE_LOOP
    if (ORIGINAL_PROMA_HOME === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = ORIGINAL_PROMA_HOME
    vi.restoreAllMocks()
  })

  it('缺省 off：单次流式 JSON 现状（query 无 tools），决策照旧经 parseGuideJson 路由', async () => {
    delete process.env.BLOMA_GUIDE_LOOP
    expect(guideLoopEnabled()).toBe(false)
    const json = JSON.stringify(decideAskJson)
    const model = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] } },
      { type: 'result', subtype: 'success' },
    ])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)
    // 单次调用、无工具面（现状口径）
    expect(model.captured.prompts).toHaveLength(1)
    expect(model.captured.toolCounts[0]).toBe(0)
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('clarification')
  })

  it('on·决策：guide_decide 工具入参直进路由 → 澄清卡照旧（不经 parseGuideJson）', async () => {
    process.env.BLOMA_GUIDE_LOOP = '1'
    const model = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '我先了解一下你的需求。' }, { type: 'tool_use', id: 'd1', name: 'guide_decide', input: { ...decideAskJson } }] } },
      { type: 'result', subtype: 'success', stop_reason: 'tool_use' },
    ])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)
    // loop 路径：带工具面调用
    expect(model.captured.toolCounts.some((n) => n > 0)).toBe(true)
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('clarification')
    const labels = (card?.payload.questions as Array<{ label: string }>).map((q) => q.label)
    expect(labels).toContain('个人流水')
    expect(labels).toContain('你帮我决定')
    // 决策 reply 落盘/上屏（路由块行为照旧）
    expect(model.persistAssistant).toHaveBeenCalledWith(expect.stringContaining('家庭共享账本'))
  })

  it('on·自由对话：无决策文本回复只收口（message_completed），不弹卡不改阶段', async () => {
    process.env.BLOMA_GUIDE_LOOP = '1'
    const model = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '听起来你想解决月底对不上账的问题，我可以做，想再了解下你平时用什么记。' }] } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    ])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)
    expect(events.some((e) => e.type === 'user_decision_required')).toBe(false)
    expect(events.some((e) => e.type === 'message_completed')).toBe(true)
    // 自由对话不触发确认流/草图
    expect(events.some((e) => e.type === 'stage_changed' && (e.payload as { stage?: string }).stage === 'generating_sketch')).toBe(false)
  })

  it('on·连续 3 轮自由对话 → 第 4 轮 task 注入宿主提醒（只影响模型可见）', async () => {
    process.env.BLOMA_GUIDE_LOOP = '1'
    const chat = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '好的，再多聊两句也行。' }] } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    ])
    const decide = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'd1', name: 'guide_decide', input: { ...decideAskJson } }] } },
      { type: 'result', subtype: 'success', stop_reason: 'tool_use' },
    ])
    const input = makeInput()
    const publish = (event: AgentEvent) => events.push(event)
    const events: AgentEvent[] = []
    // 三轮自由对话（同会话累积计数）
    for (let i = 0; i < 3; i += 1) await handleGuideMessage(input, publish, chat)
    // 第 4 轮：模型收到带提醒的 task（loop 调用的 prompt 参数）
    await handleGuideMessage(input, publish, decide)
    const remindedPrompt = decide.captured.lastUserTexts.find((p) => p.includes('宿主提醒'))
    expect(remindedPrompt).toBeDefined()
    expect(remindedPrompt).toContain(input.content)
    // 决策后计数清零：再一轮自由对话不含提醒
    const chatAfter = makeModel(() => [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '收到，先这样。' }] } },
      { type: 'result', subtype: 'success', stop_reason: 'end_turn' },
    ])
    await handleGuideMessage(input, publish, chatAfter)
    expect(chatAfter.captured.lastUserTexts.every((p) => !p.includes('宿主提醒'))).toBe(true)
  })

  it('on·失败：loop 抛错 → 回退规则路由兜底（与旧路径同款）', async () => {
    process.env.BLOMA_GUIDE_LOOP = '1'
    const model = makeModel(() => {
      throw new Error('渠道 429')
    })
    const events: AgentEvent[] = []
    const input = makeInput('做个东西')
    await handleGuideMessage(input, (event) => events.push(event), model)
    // 规则路由兜底仍能弹卡/回复（不抛错、不静默）
    expect(events.some((e) => e.type === 'user_decision_required' || e.type === 'message_completed')).toBe(true)
  })
})

describe('guide-tools 单元', () => {
  afterEach(() => {
    if (ORIGINAL_PROMA_HOME === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = ORIGINAL_PROMA_HOME
  })

  it('guide_decide：合法决策入持有者；非法 action 拒绝；每 run 只收一次', async () => {
    const decisions: GuideDecision[] = []
    const tools = buildGuideTools('proj-1', { onDecide: (d) => decisions.push(d) })
    const decide = tools.find((t) => t.name === 'guide_decide')!
    const ok = await decide.execute({ ...decideAskJson }, {} as never)
    expect(ok.isError).toBeUndefined()
    expect(decisions).toHaveLength(1)
    expect(decisions[0]!.action).toBe('ask_clarification')
    const bad = await decide.execute({ action: 'run_away', reply: 'x' }, {} as never)
    expect(bad.isError).toBe(true)
    const again = await decide.execute({ ...decideAskJson }, {} as never)
    expect(again.isError).toBe(true)
    expect(again.output).toContain('不要重复调用')
  })

  it('read_test_report：无报告如实返回；有报告给出摘要', async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-guide-tools-'))
    const docDir = join(process.env.PROMA_HOME, 'agent-workspaces', 'default-software-builder', 'documents', 'proj-1')
    mkdirSync(docDir, { recursive: true })
    const tools = buildGuideTools('proj-1', { onDecide: () => undefined })
    const report = tools.find((t) => t.name === 'read_test_report')!
    const before = await report.execute({}, {} as never)
    expect(before.output).toContain('尚未生成测试报告')
    writeFileSync(
      join(docDir, 'test-report.json'),
      JSON.stringify({ total_count: 8, passed_count: 6, failed_count: 2, failure_summary: [{ scenario: 'F-002 点击新增', reason: '输入框未出现' }] }),
      'utf-8',
    )
    const after = await report.execute({}, {} as never)
    expect(after.output).toContain('通过 6')
    expect(after.output).toContain('F-002 点击新增')
  })
})

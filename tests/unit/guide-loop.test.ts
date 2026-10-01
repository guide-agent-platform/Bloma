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

vi.mock('../../main/coding/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/delivery/track-analytics', () => ({
  trackAnalytics: vi.fn(),
}))
vi.mock('../../main/project/project-service', () => ({
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
vi.mock('../../main/platform/sessions/session-service', () => ({
  readPrimaryIntent: vi.fn(() => undefined),
  isAutoDelegationText: () => false,
}))
vi.mock('../../main/project/decision-log', () => ({
  recordDecision: vi.fn(),
  parseDecisionText: vi.fn(() => []),
}))
vi.mock('../../main/guide/guide-research', () => ({
  researchMarketSimilar: vi.fn(async () => ({ available: false, items: [] })),
  normalizeResearchQuery: vi.fn((q: string) => q),
}))

import { handleGuideMessage } from '../../main/guide/guide-agent-service'
import { buildGuideTools, type GuideDecision } from '../../main/guide/guide-tools'
import type { ConversationTurn, GuideModelOptions, SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

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

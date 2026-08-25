import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
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
vi.mock('../../main/guide-research', () => ({
  // 市调在单测中固定降级（不打真实网络）；弹窗流程可用性由 guide-research 专属测试覆盖
  researchMarketSimilar: vi.fn(async () => ({ available: false, queries: [], results: [], summary: '' })),
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
vi.mock('../../main/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
  parseDecisionText: (text: string) => {
    // 真实 parseDecisionText 依赖读盘导出，测试内联同构实现（只取 type）
    const match = /^\[decision\] (\{.*\})$/.exec(text.trim())
    if (!match) return undefined
    try {
      const parsed = JSON.parse(match[1]) as { type?: string; title?: string; why?: string }
      if (typeof parsed.title === 'string' && typeof parsed.why === 'string') {
        return { type: parsed.type, title: parsed.title, why: parsed.why }
      }
    } catch {
      // 损坏行
    }
    return undefined
  },
}))

// vi.mock 提升：import 必须在 mock 声明之后拿 mock 实例
import { countTrailingClarificationRounds, handleGuideMessage } from '../../main/guide-agent-service'
import { recordDecision } from '../../main/decision-log'
import { runSketchTask } from '../../main/programming-orchestrator'
import type { ConversationTurn, GuideModelOptions, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'

/**
 * 连续澄清轮次熔断（D3 修复）：模型驱动澄清此前无代码级轮次上限——首轮护栏只管
 * 「首轮必须澄清」，轮次耗尽只写在提示词里。已连续 2 轮出示卡片、模型仍要
 * ask_clarification 时，代码级强制转 auto 生成草图（与①拦「明确让渡」语义互补：
 * ①管用户说没想法，③管轮次耗尽）。
 */

const SESSION_ID = 'sess-round-limit'

describe('countTrailingClarificationRounds 尾随澄清轮计数', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-round-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function writeSession(lines: unknown[]): void {
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )
  }

  const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 })
  const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }], timestamp: 2 })
  const card = (options: string) => ({
    role: 'system',
    content: [{ type: 'text', text: `[decision-card] ${options}` }],
    timestamp: 3,
  })
  const decision = (type: string) => ({
    role: 'system',
    content: [{ type: 'text', text: `[decision] {"type":"${type}","title":"t","why":"w"}` }],
    timestamp: 4,
  })
  const terminal = () => ({
    role: 'system',
    content: [{ type: 'text', text: '[terminal] status=completed' }],
    timestamp: 5,
  })

  it('新会话/无卡片 → 0；单张卡 → 1（不熔断）', () => {
    writeSession([user('你好'), assistant('你想做什么类型的工具？'), card('待办清单｜你帮我决定'), decision('clarification_card'), terminal(), user('记账的')])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(1)

    writeSession([user('你好'), assistant('问句')])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(0)
  })

  it('连续 2 张卡（含每轮都写的 terminal/decision 噪声行）→ 2', () => {
    writeSession([
      user('你好'),
      assistant('你想做什么类型的工具？'),
      card('待办清单｜记事本｜你帮我决定'),
      decision('clarification_card'),
      terminal(),
      decision('category_route'), // 会话级噪声（30s 节流可能漏写），不得断计数
      user('记账的'),
      assistant('给谁用？'),
      card('自己用｜全家共用｜你帮我决定'),
      decision('clarification_card'),
      terminal(),
      user('自己'),
    ])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(2)
  })

  it('用户点选过答案（clarification_answer）→ 澄清已收敛，计数截断为 0', () => {
    writeSession([
      user('你好'),
      assistant('你想做什么类型的工具？'),
      card('待办清单｜你帮我决定'),
      decision('clarification_card'),
      user('待办清单'),
      decision('clarification_answer'),
      terminal(),
    ])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(0)
  })

  it('会话文件不存在 → 0（新会话/测试字面 id 不炸）', () => {
    expect(countTrailingClarificationRounds('no-such-session')).toBe(0)
  })
})

describe('引导对话 · 连续澄清熔断', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(recordDecision).mockClear()
    home = mkdtempSync(join(tmpdir(), 'proma-breaker-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
  })

  function writeSession(cardCount: number): void {
    const lines: unknown[] = [{ role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1 }]
    for (let i = 0; i < cardCount; i++) {
      lines.push(
        { role: 'assistant', content: [{ type: 'text', text: `第${i + 1}轮问句？` }], timestamp: 2 + i },
        { role: 'system', content: [{ type: 'text', text: `[decision-card] 选项A${i}｜选项B${i}｜你帮我决定` }], timestamp: 3 + i },
        { role: 'system', content: [{ type: 'text', text: '[decision] {"type":"clarification_card","title":"t","why":"w"}' }], timestamp: 4 + i },
        { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 5 + i },
        { role: 'user', content: [{ type: 'text', text: `第${i + 1}轮回答` }], timestamp: 6 + i },
      )
    }
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )
  }

  function makeInput(): AgentSendMessageInput {
    return {
      request_id: 'req-1',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      content: '还是没定下来',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      metadata: { source: 'chat' },
    }
  }

  function makeModel(json: string): GuideModelOptions {
    const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const history: ConversationTurn[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '第1轮问句？' },
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

  const askJson = JSON.stringify({
    action: 'ask_clarification',
    reply: '那记什么呢？',
    questions: [{ id: 'answer-a', label: '记账本' }, { id: 'auto', label: '你帮我决定', description: '交给我' }],
  })
  const generateJson = JSON.stringify({
    action: 'generate_sketch',
    reply: '好的，开工',
    requirements: [{ id: 'F-001', description: '通用工具' }],
  })

  it('0/1 轮尾随卡片 + 模型仍要澄清 → 照常弹卡（熔断不介入）', async () => {
    for (const cardCount of [0, 1]) {
      writeSession(cardCount)
      vi.mocked(runSketchTask).mockClear()
      const events: AgentEvent[] = []
      await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(askJson))
      expect(runSketchTask, `cards=${cardCount}`).not.toHaveBeenCalled()
      expect(events.some((event) => event.type === 'user_decision_required'), `cards=${cardCount}`).toBe(true)
    }
  })

  it('连续 2 轮仍 ask_clarification → 熔断转入需求确认弹窗（不臆断开工、留痕、留日志）', async () => {
    writeSession(2)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(askJson))

    // 2026-08-26 语义修订：不再强制 auto 开工——不弹第三张澄清卡，也不直接生成草图，
    // 而是转需求确认弹窗（弹窗内保留「由向导决定」出口 = 用户主动让渡）
    expect(runSketchTask).not.toHaveBeenCalled()
    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect(confirmEvent?.payload.kind).toBe('requirement_confirm')
    expect(confirmEvent?.payload.requirements).toEqual([
      { id: 'F-001', description: '还是没定下来' },
    ])
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'clarification_forced_confirm' }),
    }))
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('澄清轮次熔断'))
  })

  it('连续 2 轮但模型主动 generate_sketch → 正常开工，熔断零介入', async () => {
    writeSession(2)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await handleGuideMessage(makeInput(), () => undefined, makeModel(generateJson))

    expect(runSketchTask).toHaveBeenCalledTimes(1)
    expect(recordDecision).not.toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'clarification_forced_auto' }),
    }))
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining('澄清轮次熔断'))
  })

  it('第 1 轮卡片之后用户点选过答案（计数已断）→ 第 2 次模型追问不熔断', async () => {
    // 点选答案代表澄清已收敛开工；其后若项目回到澄清（如迭代重新开门），计数从 0 重来
    const lines: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '哪种？' }], timestamp: 2 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] A｜你帮我决定' }], timestamp: 3 },
      { role: 'system', content: [{ type: 'text', text: '[decision] {"type":"clarification_answer","title":"t","why":"w"}' }], timestamp: 4 },
      { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 5 },
      { role: 'assistant', content: [{ type: 'text', text: '又要确认一下？' }], timestamp: 6 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] B｜你帮我决定' }], timestamp: 7 },
    ]
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(askJson))

    expect(runSketchTask).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(true)
  })
})

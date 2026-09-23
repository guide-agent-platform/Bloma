import { restorePromaHome } from '../support/proma-home-guard'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 2026-09-16 FILE-LEVEL 钉：BLOMA_GUIDE_LOOP 缺省翻转 on，本文件全部用例锁旧单次 JSON 路径
process.env.BLOMA_GUIDE_LOOP = '0'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/coding/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/platform-services', () => ({
  trackAnalytics: vi.fn(),
}))
vi.mock('../../main/guide/guide-research', () => ({
  // 市调在单测中固定降级（不打真实网络）；弹窗流程可用性由 guide-research 专属测试覆盖
    normalizeResearchQuery: (q: string) => q,
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
    // 真实 parseDecisionText 依赖读盘导出，测试内联同构实现（含 detail，供点选累积扫描）
    const match = /^\[decision\] (\{.*\})$/.exec(text.trim())
    if (!match) return undefined
    try {
      const parsed = JSON.parse(match[1]) as { type?: string; title?: string; why?: string; detail?: unknown }
      if (typeof parsed.title === 'string' && typeof parsed.why === 'string') {
        return { type: parsed.type, title: parsed.title, why: parsed.why, detail: parsed.detail }
      }
    } catch {
      // 损坏行
    }
    return undefined
  },
}))

// vi.mock 提升：import 必须在 mock 声明之后拿 mock 实例
import { countTrailingClarificationRounds, handleGuideMessage } from '../../main/guide/guide-agent-service'
import { recordDecision } from '../../main/decision-log'
import { runSketchTask } from '../../main/coding/programming-orchestrator'
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
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    process.env.BLOMA_GUIDE_LOOP = '0'
    home = mkdtempSync(join(tmpdir(), 'proma-round-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
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

  it('用户点选过答案（clarification_answer）→ 点选回流修订（2026-08-27）：点选不再截断计数，向导可继续追问下一未知点；澄清终点改为向导的收敛决策', () => {
    writeSession([
      user('你好'),
      assistant('你想做什么类型的工具？'),
      card('待办清单｜你帮我决定'),
      decision('clarification_card'),
      user('待办清单'),
      decision('clarification_answer'),
      terminal(),
    ])
    // 点选透明：尾随卡片计数保留（向导继续问的熔断依据不受点选影响）
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(1)
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
    restorePromaHome(originalPromaHome)
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

  it('0/1/2 轮尾随卡片 + 模型仍要澄清 → 照常弹卡（熔断不介入）', async () => {
    for (const cardCount of [0, 1, 2]) {
      writeSession(cardCount)
      vi.mocked(runSketchTask).mockClear()
      const events: AgentEvent[] = []
      await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(askJson))
      expect(runSketchTask, `cards=${cardCount}`).not.toHaveBeenCalled()
      expect(events.some((event) => event.type === 'user_decision_required'), `cards=${cardCount}`).toBe(true)
    }
  })

  it('连续 3 轮仍 ask_clarification → 熔断转入需求确认弹窗（不臆断开工、留痕、留日志；2026-08-27 点选回流后阈值 2→3）', async () => {
    writeSession(3)
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

  it('三轮点选后熔断（2026-08-29 线上：音乐合成器）→ 确认弹窗清单含主题+全部三轮点选方向，不再只剩主题句', async () => {
    // 复刻线上会话 3fdc2615：三轮实质点选（旧快照形态=每轮 F-001+F-002），熔断时清单只剩一句 → PRD 正文与清单不一致 → 审查误判「擅自加戏」
    const answerDecision = (second: string) => ({
      role: 'system',
      content: [{
        type: 'text',
        text: `[decision] ${JSON.stringify({
          type: 'clarification_answer',
          title: '用户点选澄清答案',
          why: `用户点选「${second}」`,
          detail: {
            option_id: 'answer-b',
            requirements: [
              { id: 'F-001', description: '做一个音乐合成器' },
              { id: 'F-002', description: second },
            ],
          },
        })}`,
      }],
      timestamp: 7,
    })
    const lines: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: '做一个音乐合成器' }], timestamp: 1 },
    ]
    const picks = ['电脑专业软件', '创意实验', '实时演奏']
    picks.forEach((pick, i) => {
      lines.push(
        { role: 'assistant', content: [{ type: 'text', text: `第${i + 1}轮问句？` }], timestamp: 2 + i },
        { role: 'system', content: [{ type: 'text', text: `[decision-card] 选项A${i}｜选项B${i}｜你帮我决定` }] },
        { role: 'user', content: [{ type: 'text', text: pick }], timestamp: 6 + i },
        answerDecision(pick),
        { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }] },
      )
    })
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(askJson))

    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect(confirmEvent?.payload.kind).toBe('requirement_confirm')
    expect(confirmEvent?.payload.requirements).toEqual([
      { id: 'F-001', description: '做一个音乐合成器' },
      { id: 'F-002', description: '电脑专业软件' },
      { id: 'F-003', description: '创意实验' },
      { id: 'F-004', description: '实时演奏' },
    ])
  })

  it('点选回流累积（2026-08-29）：第二轮点选的清单含第一轮方向，不再每轮覆盖 F-002', async () => {
    // 第一轮点选已落盘（旧形态快照），用户第二轮点选「创意实验」→ clarification_answer 留痕的清单应累积
    const lines: unknown[] = [
      { role: 'user', content: [{ type: 'text', text: '做一个音乐合成器' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '哪种形态？' }], timestamp: 2 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 手机｜电脑｜你帮我决定' }] },
      { role: 'user', content: [{ type: 'text', text: '电脑专业软件' }], timestamp: 3 },
      {
        role: 'system',
        content: [{
          type: 'text',
          text: `[decision] ${JSON.stringify({
            type: 'clarification_answer',
            title: '用户点选澄清答案',
            why: '用户点选「电脑专业软件」',
            detail: {
              option_id: 'answer-b',
              requirements: [
                { id: 'F-001', description: '做一个音乐合成器' },
                { id: 'F-002', description: '电脑专业软件' },
              ],
            },
          })}`,
        }],
        timestamp: 4,
      },
      { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }] },
    ]
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )

    const input: AgentSendMessageInput = {
      ...makeInput(),
      content: '创意实验',
      metadata: { source: 'card_option', selected_option_id: 'answer-b' },
    }
    await handleGuideMessage(input, () => undefined, undefined)

    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'clarification_answer',
        detail: expect.objectContaining({
          requirements: [
            { id: 'F-001', description: '做一个音乐合成器' },
            { id: 'F-002', description: '电脑专业软件' },
            { id: 'F-003', description: '创意实验' },
          ],
        }),
      }),
    }))
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

// ===========================================================================
// Phase 7 U4（2026-09-10）：J1 auto 语义修正 + J2 两层保护
// ===========================================================================

describe('Phase 7 U4 · J1 auto 轮不计熔断（BLOMA_CLARIFY_AUTO_RESPECT）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-j1-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    delete process.env.BLOMA_CLARIFY_AUTO_RESPECT
  })

  function write(lines: unknown[][]): void {
    writeFileSync(
      join(home, 'agent-sessions', SESSION_ID + '.jsonl'),
      lines.flat().map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf8',
    )
  }

  /** 卡片 + auto 让渡回答的完整轮（answer 落在卡之后——倒序扫描配对依据） */
  const autoRound = (options: string, source: string) => [
    { role: 'system', content: [{ type: 'text', text: '[decision-card] ' + options }], timestamp: 1 },
    { role: 'system', content: [{ type: 'text', text: '[decision] ' + JSON.stringify({ type: 'clarification_answer', title: '让渡', why: 'w', detail: { source } }) }], timestamp: 2 },
  ]
  const plainCard = (options: string) => [
    { role: 'system', content: [{ type: 'text', text: '[decision-card] ' + options }], timestamp: 3 },
  ]

  it('开关 off（缺省）：auto 回答轮照常计数（字节级现状回归锁）', () => {
    write([autoRound('A｜你帮我决定', 'card_auto'), plainCard('B｜你帮我决定'), plainCard('C｜你帮我决定')])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(3)
  })

  it('开关 on：用户让渡的轮次不计（点选 card_auto）——委托不当糊涂', () => {
    process.env.BLOMA_CLARIFY_AUTO_RESPECT = '1'
    write([autoRound('A｜你帮我决定', 'card_auto'), plainCard('B｜你帮我决定'), plainCard('C｜你帮我决定')])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(2)
  })

  it('开关 on：打字让渡（free_text_auto）同样不计；全部为 auto 轮 → 0', () => {
    process.env.BLOMA_CLARIFY_AUTO_RESPECT = '1'
    write([autoRound('A｜你帮我决定', 'free_text_auto'), autoRound('B｜你帮我决定', 'card_auto')])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(0)
  })

  it('开关 on：非 auto 点选轮照常计数（option_id 有值但非 auto）', () => {
    process.env.BLOMA_CLARIFY_AUTO_RESPECT = '1'
    write([
      [
        { role: 'system', content: [{ type: 'text', text: '[decision-card] A｜你帮我决定' }], timestamp: 1 },
        { role: 'system', content: [{ type: 'text', text: '[decision] ' + JSON.stringify({ type: 'clarification_answer', title: '点选', why: 'w', detail: { option_id: 'answer-a' } }) }], timestamp: 2 },
      ],
      plainCard('B｜你帮我决定'),
      plainCard('C｜你帮我决定'),
    ])
    expect(countTrailingClarificationRounds(SESSION_ID)).toBe(3)
  })
})

describe('Phase 7 U4 · J2-① 同主题卡精确去重（countSameOptionCards）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-j2a-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function writeRaw(lines: unknown[]): void {
    writeFileSync(
      join(home, 'agent-sessions', SESSION_ID + '.jsonl'),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf-8',
    )
  }

  it('选项集相同才计（顺序无关）；换措辞不误判（宁漏勿误）；空 labels → 0', async () => {
    const { countSameOptionCards } = await import('../../main/guide/guide-agent-service')
    writeRaw([
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 网页版｜桌面版｜你帮我决定' }], timestamp: 1 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 网页版｜桌面版｜你帮我决定' }], timestamp: 2 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 自己用｜给大家用｜你帮我决定' }], timestamp: 3 },
    ])
    expect(countSameOptionCards(SESSION_ID, ['网页版', '桌面版', '你帮我决定'])).toBe(2)
    expect(countSameOptionCards(SESSION_ID, ['你帮我决定', '桌面版', '网页版'])).toBe(2)
    expect(countSameOptionCards(SESSION_ID, ['浏览器打开', '桌面版', '你帮我决定'])).toBe(0)
    expect(countSameOptionCards(SESSION_ID, [])).toBe(0)
  })
})

describe('Phase 7 U4 · J2-② 第三张连续卡减负卡（BLOMA_CLARIFY_TWO_LAYER）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-j2b-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    vi.mocked(recordDecision).mockClear()
    vi.mocked(runSketchTask).mockClear()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    delete process.env.BLOMA_CLARIFY_TWO_LAYER
    vi.restoreAllMocks()
  })

  function writeThreeCards(): void {
    const lines: unknown[] = [{ role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1 }]
    for (let i = 0; i < 3; i++) {
      lines.push(
        { role: 'assistant', content: [{ type: 'text', text: '第' + (i + 1) + '轮问句？' }], timestamp: 2 + i },
        { role: 'system', content: [{ type: 'text', text: '[decision-card] 选项A' + i + '｜选项B' + i + '｜你帮我决定' }], timestamp: 3 + i },
        { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 5 + i },
        { role: 'user', content: [{ type: 'text', text: '第' + (i + 1) + '轮回答' }], timestamp: 6 + i },
      )
    }
    writeFileSync(
      join(home, 'agent-sessions', SESSION_ID + '.jsonl'),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf-8',
    )
  }

  function makeAskModel(): GuideModelOptions {
    const askJson = JSON.stringify({
      action: 'ask_clarification',
      reply: '还想问',
      questions: [{ id: 'answer-a', label: '记账本' }],
    })
    const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: askJson }] } }
      yield { type: 'result', subtype: 'success' }
    }
    return {
      query,
      env: { PATH: 'x' },
      signal: new AbortController().signal,
      sessionId: SESSION_ID,
      history: [],
      maxTokens: 2048,
      persistAssistant: vi.fn(),
    }
  }

  it('开关 off（缺省）熔断 → 原需求确认弹窗（字节级现状回归锁）', async () => {
    writeThreeCards()
    const events: AgentEvent[] = []
    const { handleGuideMessage } = await import('../../main/guide/guide-agent-service')
    await handleGuideMessage(
      {
        request_id: 'req-j2off', session_id: SESSION_ID, project_id: 'proj-1', content: '还是没定下来',
        mode: 'quick', current_stage: 'blocked_for_user_decision', metadata: { source: 'chat' },
      },
      (event) => events.push(event),
      makeAskModel(),
    )
    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect(confirmEvent?.payload.kind).toBe('requirement_confirm')
  })

  it('开关 on 熔断 → 对话内减负卡（先看方案/继续补充细节），不再直接弹窗；留痕 clarification_reduced_card', async () => {
    process.env.BLOMA_CLARIFY_TWO_LAYER = '1'
    writeThreeCards()
    const events: AgentEvent[] = []
    const { handleGuideMessage } = await import('../../main/guide/guide-agent-service')
    await handleGuideMessage(
      {
        request_id: 'req-j2on', session_id: SESSION_ID, project_id: 'proj-1', content: '还是没定下来',
        mode: 'quick', current_stage: 'blocked_for_user_decision', metadata: { source: 'chat' },
      },
      (event) => events.push(event),
      makeAskModel(),
    )
    const cardEvent = events.find((event) => event.type === 'user_decision_required')
    expect(cardEvent?.payload.kind).toBe('clarification')
    expect(cardEvent?.payload.title).toBe('可以先给你一版方案')
    const optionIds = (cardEvent?.payload.questions as Array<{ id: string }>).map((q) => q.id)
    expect(optionIds).toEqual(['clarify_relief_see_plan', 'clarify_relief_continue'])
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'clarification_reduced_card' }),
    }))
  })
})

describe('疑问句主题不入清单（2026-09-16「你是谁」案 efbd347a）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-question-theme-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function writeSession(lines: unknown[]): void {
    writeFileSync(
      join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
      lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
      'utf-8',
    )
  }

  const answer = (descriptions: string[]) => ({
    role: 'system',
    content: [
      {
        type: 'text',
        text: `[decision] {"type":"clarification_answer","title":"用户点选澄清答案","why":"w","detail":{"requirements":${JSON.stringify(descriptions.map((d) => ({ description: d })))}}}`,
      },
    ],
    timestamp: 4,
  })

  it('熔断兑底清单：主题「你是谁」被过滤，正常点选方向保留（不弹含疑问句的确认卡）', async () => {
    // 复刻线上案例：首轮 answer 快照含主题「你是谁」，后续三轮点选正常方向
    writeSession([
      { role: 'user', content: [{ type: 'text', text: '你是谁' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: '先聊聊你想做什么' }], timestamp: 2 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 帮我处理某件事｜帮我做点好玩的东西｜你帮我决定' }], timestamp: 3 },
      answer(['你是谁', '帮我做点好玩的东西']),
      { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 5 },
      { role: 'user', content: [{ type: 'text', text: '帮我做点好玩的东西' }], timestamp: 6 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 生成搞怪内容｜解压小玩具｜你帮我决定' }], timestamp: 7 },
      answer(['生成搞怪内容']),
      { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 8 },
      { role: 'user', content: [{ type: 'text', text: '生成搞怪内容' }], timestamp: 9 },
      { role: 'system', content: [{ type: 'text', text: '[decision-card] 输入文字变搞怪｜上传照片变搞怪｜你帮我决定' }], timestamp: 10 },
      answer(['输入文字变搞怪']),
      { role: 'system', content: [{ type: 'text', text: '[terminal] status=completed' }], timestamp: 11 },
    ])

    const json = JSON.stringify({
      action: 'ask_clarification',
      reply: '还想再确认一个点。',
      questions: [{ id: 'auto', label: '你帮我决定' }],
    })
    const persistAssistant = vi.fn()
    const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] } }
      yield { type: 'result', subtype: 'success' }
    }
    const events: AgentEvent[] = []
    await handleGuideMessage(
      {
        request_id: 'req-q',
        session_id: SESSION_ID,
        project_id: 'proj-1',
        content: '输入文字变搞怪',
        mode: 'quick',
        current_stage: 'clarifying',
        metadata: { source: 'card_option', selected_option_id: 'answer-a' },
      },
      (event) => events.push(event),
      {
        query,
        env: {},
        signal: new AbortController().signal,
        sessionId: SESSION_ID,
        history: [],
        maxTokens: 1024,
        persistAssistant,
      },
    )
    // 需求确认卡（或其上游决策事件）不得再含「你是谁」
    const allText = events.map((e) => JSON.stringify(e.payload)).join('\n')
    expect(allText).not.toContain('你是谁')
    // 正常点选方向保留（确认卡存在且含方向项）
    const confirmCard = events.find((e) => e.type === 'user_decision_required')
    expect(confirmCard).toBeDefined()
    expect(allText).toContain('帮我做点好玩的东西')
  })
})

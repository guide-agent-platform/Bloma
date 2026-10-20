import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { decideBlocks } from '../support/guide-decide-stream'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/guide/pipeline', async importOriginal => ({ ...await importOriginal<object>(), resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })) }))
vi.mock('../../main/platform/programming-events', async importOriginal => ({ ...await importOriginal<object>(), setProgrammingEventPublisher: vi.fn() }))
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
    results: [{ title: '复音电子琴教学工具', url: 'https://a.example.com/piano', snippet: '多音色弹奏与教学' }],
    summary: '1. 复音电子琴教学工具 — a.example.com\n多音色弹奏与教学',
  })),
}))

import { handleGuideMessage } from '../../main/guide/guide-agent-service'
import { researchMarketSimilar } from '../../main/guide/guide-research'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestration/orchestrator'

const SESSION_ID = 'sess-advisory'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '复音电子琴，多音色弹奏', origin: 'user' },
    { id: 'F-002', description: '内置教学曲目', origin: 'guide' },
  ],
  research_queries: ['电子琴 推荐'],
})

function makeInput(): AgentSendMessageInput {
  return {
    request_id: 'req-advisory',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content: '帮我做个电子琴',
    mode: 'quick',
    current_stage: 'clarifying',
  }
}

/** 按调用形态分流的 query mock（2026-10-01 开关面收敛批改造）：
 * - 市调子流程（prompt 含【用户需求】/【调研结果】）按剧本次序返回 scripts；
 * - guide 决策调用返回 confirmJson（tool_use 化）——loop 路径下决策与子流程的调用次序不再稳定，
 *   按调用内容分流取代旧「按调用次序」剧本；calls 记录每次 prompt。 */
function makeModel(scripts: string[]): { model: GuideModelOptions; calls: string[] } {
  const calls: string[] = []
  let subCall = 0
  const query: SDKQuery = async function* (prompt: string): AsyncGenerator<SDKMessage> {
    calls.push(prompt)
    const isGuideDecision = !prompt.includes('【用户需求】') && !prompt.includes('【调研结果】')
    const response = isGuideDecision
      ? scripts[0]
      : scripts[1 + Math.min(subCall++, scripts.length - 2)] ?? '{}'
    yield { type: 'assistant', message: { role: 'assistant', content: decideBlocks(response) } }
    yield { type: 'result', subtype: 'success' }
  }
  const history: ConversationTurn[] = [
    { role: 'user', content: '做个电子琴' },
    { role: 'assistant', content: '自己用还是教学？' },
    { role: 'user', content: '自己弹着玩' },
  ]
  return {
    calls,
    model: {
      query,
      env: { PATH: 'x' },
      signal: new AbortController().signal,
      sessionId: SESSION_ID,
      history,
      maxTokens: 2048,
      persistAssistant: vi.fn(),
    },
  }
}

let originalPromaHome: string | undefined
beforeEach(() => {
  originalPromaHome = process.env.PROMA_HOME
  process.env.PROMA_HOME = undefined
  // R2（2026-09-12）：本文件测 scrape 市调管道本体（查询构造/搜索/提炼），
  // 钉到 scrape 模式（缺省已改 agent——纯模型灵感不发网络）
  process.env.BLOMA_RESEARCH_MODE = 'scrape'
  // 2026-09-16：BLOMA_GUIDE_LOOP 缺省翻转 on，本文件锁旧单次 JSON 行为
  vi.clearAllMocks()
})
afterEach(() => {
  process.env.PROMA_HOME = originalPromaHome
  delete process.env.BLOMA_RESEARCH_MODE
  vi.restoreAllMocks()
})

describe('顾问式市调（2026-08-30）', () => {
  it('查询构造 LLM 成功：需求+候选词改写为具体查询词 → 市调用改写词而非原文', async () => {
    const { model } = makeModel([
      confirmJson,
      JSON.stringify({ queries: ['复音电子琴 教学 音色', '电子琴 入门 选购'] }),
      '{}', // distill 失败 → fallback 原始条目（市调 available:true 已有 1 条）
    ])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)

    expect(researchMarketSimilar).toHaveBeenCalledTimes(1)
    expect(researchMarketSimilar).toHaveBeenCalledWith(['复音电子琴 教学 音色', '电子琴 入门 选购'])
    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect((confirmEvent?.payload as { kind?: string }).kind).toBe('requirement_confirm')
  })

  it('查询构造 LLM 失败（空 JSON）→ 降级用模型候选词清洗结果，市调仍执行', async () => {
    const { model } = makeModel([confirmJson, '{}', '{}'])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)

    // 候选词 '电子琴 推荐' 优先；需求清洗（两条需求拼接）兜底
    expect(researchMarketSimilar).toHaveBeenCalledWith(['电子琴 推荐', '复音电子琴，多音色弹奏；内置教学曲目'])
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(true)
  })

  it('想法提炼 prompt 锚定【用户需求】：需求描述进入提炼输入（不脱离需求泛提炼）', async () => {
    const { model, calls } = makeModel([
      confirmJson,
      JSON.stringify({ queries: ['复音电子琴 教学'] }),
      JSON.stringify({ ideas: [{ label: '虚拟键盘实时弹奏', note: '按键即发声', source: 'example.com' }] }),
    ])
    const events: AgentEvent[] = []
    await handleGuideMessage(makeInput(), (event) => events.push(event), model)

    // 调用序（按内容分流后）：calls 中含【用户需求】的子流程调用应覆盖查询构造与提炼
    const demandCalls = calls.filter((c) => c.includes('【用户需求】'))
    expect(demandCalls.length).toBeGreaterThanOrEqual(2)
    // 提炼输入锚定需求：带【用户需求】且含需求描述中的关键名词
    expect(demandCalls[1]).toContain('复音电子琴')
    // 提炼结果进弹窗想法区
    const confirm = events.find((e) => e.type === 'user_decision_required')
    const ideas = (confirm?.payload as { ideas?: Array<{ label: string }> }).ideas ?? []
    expect(ideas.length).toBeGreaterThan(0)
    expect(ideas[0]?.label).toContain('虚拟键盘')
  })
})

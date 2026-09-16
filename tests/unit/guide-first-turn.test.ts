import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  // guide-agent-service 的自由文本让渡分流依赖同一模块的话术表（单点维护），mock 须同步提供
  isAutoDelegationText: (content: string) => /^(?:我还没想法|随便|你帮我决定)$/.test(content.trim()),
}))
vi.mock('../../main/decision-log', () => ({
  recordDecision: vi.fn(),
}))

// vi.mock 提升：import 必须在 mock 声明之后拿 mock 实例
import { handleGuideMessage } from '../../main/guide-agent-service'
import { runSketchTask } from '../../main/programming-orchestrator'
import { updateProject } from '../../main/project-service'
import type { ConversationTurn, GuideModelOptions, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'

/**
 * 首轮澄清硬护栏（2026-08-16 赛车模拟器案例）：
 * 会话首轮用户消息即使模型判「够清晰」返回 generate_sketch，也必须降级为
 * ask_clarification——需求确认是产品闭环必经一环，不能因模型采样差异被跳过。
 */

function makeInput(): AgentSendMessageInput {
  return {
    request_id: 'req-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    content: '帮我做一个赛车模拟器',
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
  }
}

interface Captured {
  prompt: string
  history: ConversationTurn[]
}

function makeModel(json: string, history: ConversationTurn[]): GuideModelOptions & { captured: Captured } {
  const captured: Captured = { prompt: '', history: [] }
  const query: SDKQuery = async function* (
    prompt: string,
    options: SDKQueryOptions,
  ): AsyncGenerator<SDKMessage> {
    captured.prompt = prompt
    captured.history = options.history ?? []
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: json }] } }
    yield { type: 'result', subtype: 'success' }
  }
  return {
    query,
    env: { PATH: 'x' },
    signal: new AbortController().signal,
    sessionId: 'sess-1',
    history,
    maxTokens: 2048,
    persistAssistant: vi.fn(),
    captured,
  }
}

const generateSketchJson = JSON.stringify({
  action: 'generate_sketch',
  reply: '好的，这就为你生成草图！',
  requirements: [{ id: 'F-001', description: '做一个赛车模拟器' }],
})

describe('引导首轮澄清硬护栏', () => {
  beforeEach(() => {
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    process.env.BLOMA_GUIDE_LOOP = '0'
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(updateProject).mockClear()
  })

  it('首轮模型直出 generate_sketch → 降级为澄清卡片，不进草图生成', async () => {
    const model = makeModel(generateSketchJson, [])
    const events: AgentEvent[] = []
    const publish = (event: AgentEvent) => events.push(event)

    await handleGuideMessage(makeInput(), publish, model)

    // 不开工：草图任务绝不能被触发
    expect(runSketchTask).not.toHaveBeenCalled()
    // 系统提示带上了首轮护栏（2026-08-27 软化为「本轮提示」：保留防零确认开工底线，提问决策归还向导）
    expect(model.captured.history[0]?.content).toContain('本轮提示')
    // 不采用模型的「直接开工」话术，落盘的是澄清问句
    expect(model.persistAssistant).toHaveBeenCalledWith(expect.stringContaining('确认'))
    expect(model.persistAssistant).not.toHaveBeenCalledWith('好的，这就为你生成草图！')
    // 阶段进入 blocked_for_user_decision 并发布澄清事件
    expect(updateProject).toHaveBeenCalledWith('proj-1', { current_stage: 'blocked_for_user_decision' })
    const stageEvents = events.filter((e) => e.type === 'stage_changed')
    expect(stageEvents[stageEvents.length - 1]?.payload.stage).toBe('blocked_for_user_decision')
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('clarification')
    // 「帮我做一个赛车模拟器」被规则路由判为够清晰（含「做」且 ≥8 字）→ 无可选选项，
    // 走纯文本追问（questions 为空，B 侧不弹卡片）；用户答复后即进入第二轮、允许开工
    expect(card?.payload.questions).toEqual([])
    expect(model.persistAssistant).toHaveBeenCalledWith('开工前先确认一个关键点：你想要哪种类型、主要给谁用？')
  })

  it('首轮降级且规则路由给得出选项 → 弹固定三选项澄清卡', async () => {
    const input = makeInput()
    input.content = '做个东西'
    const model = makeModel(generateSketchJson, [])
    const events: AgentEvent[] = []

    await handleGuideMessage(input, (event) => events.push(event), model)

    expect(runSketchTask).not.toHaveBeenCalled()
    const card = events.find((e) => e.type === 'user_decision_required')
    expect((card?.payload.questions as { label: string }[]).map((q) => q.label)).toEqual([
      '日常生活工具',
      '工作提效工具',
      '你帮我决定',
    ])
  })

  it('非首轮（已有澄清往返）模型 generate_sketch → 正常开工，护栏不干扰', async () => {
    const history: ConversationTurn[] = [
      { role: 'user', content: '帮我做一个赛车模拟器' },
      { role: 'assistant', content: '要做哪种类型？' },
    ]
    const model = makeModel(generateSketchJson, history)
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput(), (event) => events.push(event), model)

    expect(model.captured.history[0]?.content).not.toContain('本轮提示')
    expect(model.persistAssistant).toHaveBeenCalledWith('好的，这就为你生成草图！')
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runSketchTask).mock.calls[0][0].requirements).toEqual([
      { id: 'F-001', description: '做一个赛车模拟器' },
    ])
  })

  it('首轮模型主动 ask_clarification → 照常澄清（护栏零介入）', async () => {
    const askJson = JSON.stringify({
      action: 'ask_clarification',
      reply: '要做哪种类型的模拟器？',
      questions: [
        { id: 'answer-race', label: '赛道计时赛', description: '刷圈速排名' },
        { id: 'answer-drift', label: '漂移练习', description: '练操控手感' },
        { id: 'auto', label: '你帮我决定', description: '交给我，按常见做法先出一版' },
      ],
    })
    const model = makeModel(askJson, [])
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput(), (event) => events.push(event), model)

    expect(runSketchTask).not.toHaveBeenCalled()
    const card = events.find((e) => e.type === 'user_decision_required')
    expect((card?.payload.questions as { label: string }[]).map((q) => q.label)).toEqual([
      '赛道计时赛',
      '漂移练习',
      '你帮我决定',
    ])
  })
})

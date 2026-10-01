import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideBlocks } from '../support/guide-decide-stream'
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
vi.mock('../../main/platform/sessions/session-service', async (importOriginal) => {
  // 话术表走真实实现（单点维护），只 mock 掉读盘的 readPrimaryIntent
  const actual = await importOriginal<typeof import('../../main/platform/sessions/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
vi.mock('../../main/project/decision-log', () => ({
  recordDecision: vi.fn(),
}))

// vi.mock 提升：import 必须在 mock 声明之后拿 mock 实例
import { handleGuideMessage } from '../../main/guide/guide-agent-service'
import { recordDecision } from '../../main/project/decision-log'
import { runSketchTask } from '../../main/coding/programming-orchestrator'
import { isAutoDelegationText } from '../../main/platform/sessions/session-service'
import type { ConversationTurn, GuideModelOptions, SDKQuery, SDKQueryOptions } from '../../main/orchestration/orchestrator'

/**
 * 自由文本让渡（D1 修复，2026-08-22 线上案例「我还没想法」被原样重问）：
 * 打字说「没想法/随便/你决定」与点选「你帮我决定」卡片语义相同——确定性识别后
 * 直接复用卡片 auto 路径生成草图，不再落回模型路径追问。
 */

function makeInput(content: string): AgentSendMessageInput {
  return {
    request_id: 'req-1',
    session_id: 'sess-1',
    project_id: 'proj-1',
    content,
    mode: 'quick',
    current_stage: 'blocked_for_user_decision',
    metadata: { source: 'chat' },
  }
}

function makeModel(json: string, history: ConversationTurn[]): GuideModelOptions {
  const query: SDKQuery = async function* (
    _prompt: string,
    _options: SDKQueryOptions,
  ): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: decideBlocks(json) } }
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
  }
}

const askClarificationJson = JSON.stringify({
  action: 'ask_clarification',
  reply: '你想做一个什么类型的工具？',
  questions: [
    { id: 'answer-todo', label: '待办清单', description: '管理每日任务' },
    { id: 'auto', label: '你帮我决定', description: '交给我，按常见做法先出一版' },
  ],
})

describe('让渡话术表 isAutoDelegationText', () => {
  it('正例：整句让渡话术命中（含人称前缀/语气词变体）', () => {
    for (const text of [
      '我还没想法',
      '还没想好',
      '没想法',
      '没有想法',
      '没头绪',
      '不知道做什么',
      '不知道要什么',
      '随便',
      '随便来',
      '都可以',
      '都行',
      '你帮我决定',
      '你决定吧',
      '你来定',
      '你看着办',
      '听你的',
      '交给你',
      '帮我挑',
      '帮我选一个',
      '无所谓',
      '随便了',
      '没想法呢',
    ]) {
      expect(isAutoDelegationText(text), text).toBe(true)
    }
  })

  it('反例：含实际内容的话不触发（长度上限 + 整句命中双门槛）', () => {
    for (const text of [
      '随便做个游戏',
      '帮我做个记账的',
      '帮我做一个音乐合成器',
      '做一个待办清单',
      '不知道什么原因打不开',
      // 超长句即使以让渡话术开头也不算（含实际内容概率高，宁可漏判不误伤）
      '你帮我决定吧，不过我平时主要是想记录每天喝水的量，最好能有统计图',
    ]) {
      expect(isAutoDelegationText(text), text).toBe(false)
    }
  })
})

describe('引导对话 · 自由文本让渡分流', () => {
  beforeEach(() => {
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(recordDecision).mockClear()
  })

  it('「我还没想法」→ 复用 auto 路径直接生成草图，不弹澄清卡、不再追问', async () => {
    const model = makeModel(askClarificationJson, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你想做一个什么类型的工具？' },
    ])
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput('我还没想法'), (event) => events.push(event), model)

    // 让渡优先于模型路径：模型 mock 明明返回 ask_clarification，也不得弹卡/追问
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    expect(events.find((event) => event.type === 'user_decision_required')).toBeUndefined()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).not.toContain('什么类型的工具')
    // 需求走 CARD_ANSWER_REQUIREMENTS.auto 同款扩写
    expect(vi.mocked(runSketchTask).mock.calls[0][0].requirements).toEqual([
      { id: 'F-001', description: '通用实用软件工具，由向导按常见做法生成第一版' },
    ])
  })

  it('「随便」「你帮我决定」（自由文本）同走让渡路径', async () => {
    for (const content of ['随便', '你帮我决定']) {
      vi.mocked(runSketchTask).mockClear()
      const model = makeModel(askClarificationJson, [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你想做一个什么类型的工具？' },
      ])
      await handleGuideMessage(makeInput(content), () => undefined, model)
      expect(runSketchTask, content).toHaveBeenCalledTimes(1)
    }
  })

  it('让渡决策留痕：clarification_answer + detail.source=free_text_auto（与点选区分）', async () => {
    const model = makeModel(askClarificationJson, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你想做一个什么类型的工具？' },
    ])

    await handleGuideMessage(makeInput('我还没想法'), () => undefined, model)

    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({
        type: 'clarification_answer',
        detail: expect.objectContaining({ source: 'free_text_auto' }),
      }),
    }))
  })

  it('含实际内容的话不触发让渡：照常走模型路径澄清', async () => {
    const model = makeModel(askClarificationJson, [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你想做一个什么类型的工具？' },
    ])
    const events: AgentEvent[] = []

    await handleGuideMessage(makeInput('随便做个游戏'), (event) => events.push(event), model)

    expect(runSketchTask).not.toHaveBeenCalled()
    const card = events.find((event) => event.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('clarification')
  })
})

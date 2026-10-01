import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decideBlocks } from '../support/guide-decide-stream'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/coding/programming-orchestrator', () => ({
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


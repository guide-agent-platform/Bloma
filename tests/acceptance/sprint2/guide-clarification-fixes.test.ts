import { restorePromaHome } from '../../support/proma-home-guard'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../../main/orchestrator'

vi.mock('../../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: () => ({
      id: 'test-channel',
      name: 'Test',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'encrypted-test-key',
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
      enabled: true,
    }),
    decryptApiKey: () => 'test-key-from-channel',
    getFirstEnabledChannel: () => undefined,
  }
})
vi.mock('../../../main/guide/guide-research', () => ({
  // 市调在验收中固定降级（不打真实网络）；DDG 真实链路由线上验证覆盖
    normalizeResearchQuery: (q: string) => q,
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({
    available: false,
    queries,
    results: [],
    summary: '',
    reason: 'empty',
  })),
}))
import { createProject, findProject, readLastSketchRequirements } from '../../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../../main/platform-services'
import { makeChildProcess, useTemporaryPromaHome } from '../support/test-environment'
import type { AgentEvent, SDKMessage } from '../../../shared/types'

/**
 * 向导澄清对话修复验收（2026-08-22 线上案例，方案：自由文本让渡 · 选项回灌 · 轮次熔断）
 *
 * 线上复现（会话 c676c8cc）：「你好」→ 弹卡；「我还没想法」→ 原样重问同一句、
 * 选项从具体成品（待办清单/记事本）退化成抽象类目（工具类/游戏类/记录类）。
 * 三条验收分别覆盖：①场景复现（让渡识别 + 问候语不污染锚点）、①独立用例、③轮次熔断。
 */
describe('Sprint 2 guide clarification fixes acceptance（向导澄清修复）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultPlainQuery)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    vi.restoreAllMocks()
  })

  function setupSandbox(port: number): void {
    setSandboxRuntimeForTests({
      portAllocator: async () => port,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess().process,
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))
  }

  /** 让模型扮演线上事故形态：ask_clarification + 可配置问句与选项。 */
  function mockModelAsking(reply: string, labels: string[]): void {
    setSDKQueryForTests(async function* (): AsyncGenerator<SDKMessage> {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: JSON.stringify({
              action: 'ask_clarification',
              reply,
              questions: labels.map((label, index) => ({ id: `answer-${index}`, label })),
            }),
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })
  }

  it('[场景复现] 你好 → 我还没想法：第二轮不重问、直接进入草图生成', async () => {
    const env = useTemporaryPromaHome('bloma-s2-guide-scene-')
    try {
      const project = createProject({ request_id: 'req-project', mode: 'quick' })
      const events: AgentEvent[] = []
      setAgentStreamPublisher((event) => events.push(event))
      setupSandbox(4101)

      // 第一轮：你好 → 弹出具体成品选项卡（线上原样）
      mockModelAsking('你想做一个什么类型的工具？', ['待办清单', '记事本'])
      await runAgent({
        request_id: 'req-1', session_id: 'session-scene', project_id: project.project_id,
        content: '你好', mode: 'quick', current_stage: 'clarifying', channel_id: 'test-channel',
      })
      expect(events.filter((event) => event.type === 'user_decision_required')).toHaveLength(1)

      // 第二轮：模型 mock 仍是线上事故形态（同文重问 + 类目选项）——但让渡分流
      // 先于模型路径，这套回复根本不该被采纳
      mockModelAsking('你想做一个什么类型的工具？', ['工具类', '游戏类', '记录类'])
      await runAgent({
        request_id: 'req-2', session_id: 'session-scene', project_id: project.project_id,
        content: '我还没想法', mode: 'quick', current_stage: 'blocked_for_user_decision', channel_id: 'test-channel',
      })

      // 让渡 → PRD 管线收口（2026-08-27「不过目不开工」）：不再直达草图，
      // 先 PRD→六维审查→PRD 确认卡挂起；重问仍不得发生
      const confirmCard = events.find(
        (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
      )
      expect(confirmCard).toBeTruthy()
      expect(events.filter((event) => event.type === 'user_decision_required')).toHaveLength(2) // 首轮澄清卡 + PRD 确认卡
      // 同文问句不得作为新澄清卡重发（让渡分流短路了模型路径；PRD 引擎流式旁白
      // 在 mock 下会转发 scripted 原文属伪影，以卡片为准）
      const clarifyCards = events.filter(
        (event) => event.type === 'user_decision_required' && Array.isArray((event.payload as { questions?: unknown[] }).questions),
      )
      expect(clarifyCards).toHaveLength(1)
      // 用户过目确认后才开草图
      await runAgent({
        request_id: 'req-3', session_id: 'session-scene', project_id: project.project_id,
        content: '确认无误', mode: 'quick', current_stage: 'blocked_for_user_decision', channel_id: 'test-channel',
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_confirm' },
      })
      expect(events.find((event) => event.type === 'sketch_ready')).toBeTruthy()
      expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
      // 「你好」（问候）与「我还没想法」（让渡）都不配当主题锚点：F-001 是 auto 扩写
      expect(readLastSketchRequirements(project.project_id)[0]?.description).toBe(
        '通用实用软件工具，由向导按常见做法生成第一版',
      )
      // 让渡留痕可与点选区分（事后追溯）
      const jsonl = readFileSync(join(env.home, 'agent-sessions', 'session-scene.jsonl'), 'utf8')
      expect(jsonl).toContain('free_text_auto')
    } finally {
      env.cleanup()
    }
  })

  it('[① 独立用例] 打字让渡（你帮我决定）直接开工，含实际内容的长句不受误伤', async () => {
    const env = useTemporaryPromaHome('bloma-s2-guide-free-text-')
    try {
      const project = createProject({ request_id: 'req-project', mode: 'quick' })
      const events: AgentEvent[] = []
      setAgentStreamPublisher((event) => events.push(event))
      setupSandbox(4102)
      mockModelAsking('想做哪种工具？', ['记账本', '待办清单'])

      // 打字版「你帮我决定」：与点选卡片同义——不再直达草图，先过 PRD 确认门（2026-08-27）
      await runAgent({
        request_id: 'req-1', session_id: 'session-free-text', project_id: project.project_id,
        content: '你帮我决定', mode: 'quick', current_stage: 'blocked_for_user_decision', channel_id: 'test-channel',
      })
      const confirmCard = events.find(
        (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
      )
      expect(confirmCard).toBeTruthy()
      await runAgent({
        request_id: 'req-1c', session_id: 'session-free-text', project_id: project.project_id,
        content: '确认无误', mode: 'quick', current_stage: 'blocked_for_user_decision', channel_id: 'test-channel',
        metadata: { source: 'card_option', selected_option_id: 'prd_confirm_confirm' },
      })
      expect(events.find((event) => event.type === 'sketch_ready')).toBeTruthy()

      // 含实际内容的话（「随便做个游戏」）不是让渡：照常澄清，不擅自开工
      const project2 = createProject({ request_id: 'req-project-2', mode: 'quick' })
      const events2: AgentEvent[] = []
      setAgentStreamPublisher((event) => events2.push(event))
      await runAgent({
        request_id: 'req-2', session_id: 'session-free-text-2', project_id: project2.project_id,
        content: '随便做个游戏', mode: 'quick', current_stage: 'clarifying', channel_id: 'test-channel',
      })
      expect(events2.filter((event) => event.type === 'user_decision_required')).toHaveLength(1)
      expect(events2.find((event) => event.type === 'sketch_ready')).toBeUndefined()
    } finally {
      env.cleanup()
    }
  })

  it('[③ 独立用例] 连续 3 轮澄清后模型仍要追问 → 熔断转入需求确认弹窗（不臆断开工）并留痕；2026-08-27 点选回流后阈值 2→3', async () => {
    const env = useTemporaryPromaHome('bloma-s2-guide-breaker-')
    try {
      const project = createProject({ request_id: 'req-project', mode: 'quick' })
      const events: AgentEvent[] = []
      setAgentStreamPublisher((event) => events.push(event))
      setupSandbox(4103)

      const rounds = [
        { content: '你好', stage: 'clarifying' as const, reply: '你想做一个什么类型的工具？' },
        { content: '帮我做个东西', stage: 'blocked_for_user_decision' as const, reply: '想给谁用？' },
        { content: '嗯我再想想', stage: 'blocked_for_user_decision' as const, reply: '具体想做什么内容？' },
        { content: '还是没想好', stage: 'blocked_for_user_decision' as const, reply: '平时什么时候会用它？' },
      ]
      for (const [index, round] of rounds.entries()) {
        mockModelAsking(round.reply, index === 0 ? ['待办清单', '记事本'] : ['自己用', '全家共用'])
        await runAgent({
          request_id: `req-${index + 1}`, session_id: 'session-breaker', project_id: project.project_id,
          content: round.content, mode: 'quick', current_stage: round.stage, channel_id: 'test-channel',
        })
      }

      // 前三轮各弹一张澄清卡；第四轮模型仍要 ask_clarification → 熔断转入需求确认弹窗
      // （2026-08-26 语义修订：不再强制 auto 开工，弹窗内保留让渡出口；
      //  2026-08-27 点选回流：阈值 2→3，向导可多跟踪一轮）
      const decisionEvents = events.filter((event) => event.type === 'user_decision_required')
      expect(decisionEvents).toHaveLength(4)
      expect(decisionEvents[3]?.payload.kind).toBe('requirement_confirm')
      // 不臆断开工：未生成草图，阶段停在待用户决策
      expect(events.find((event) => event.type === 'sketch_ready')).toBeFalsy()
      expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
      // 弹窗需求以首条实质消息（「帮我做个东西」，问候「你好」已被 ⑤ 豁免）为主题锚点
      const confirmRequirements = (decisionEvents[3]?.payload.requirements ?? []) as Array<{ id: string; description: string }>
      expect(confirmRequirements[0]?.description).toBe('帮我做个东西')
      const jsonl = readFileSync(join(env.home, 'agent-sessions', 'session-breaker.jsonl'), 'utf8')
      expect(jsonl).toContain('clarification_forced_confirm')
    } finally {
      env.cleanup()
    }
  })
})

async function* defaultPlainQuery(): AsyncGenerator<SDKMessage> {
  yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] } }
  yield { type: 'result', subtype: 'success' }
}

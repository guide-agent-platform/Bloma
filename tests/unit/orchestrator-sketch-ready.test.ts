import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'
import { findProject } from '../../main/project-service'
import type { AgentEvent, SDKMessage, WorkflowStage } from '../../shared/types'

vi.mock('../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/channel-manager')>()
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

vi.mock('../../main/project-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/project-service')>()
  return { ...original, findProject: vi.fn() }
})

/**
 * 转移阶段护栏针对性用例（问题 A / P1 + P0 ready 护栏）。
 * - sketch_ready 阶段的消息不再落入无工具编程路径（模型无工具只能「假装交付」）。
 * - ready/completed 阶段跳过 LLM、规则直答「已经生成好了」，杜绝「还没好」幻觉。
 * - 编程路径输出完整 HTML / 代码块时追加显式提示，引导用户看预览而非贴代码。
 */
describe('转移阶段护栏（问题 A / P1）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    vi.mocked(findProject).mockReset()
  })

  it('sketch_ready 阶段的消息直接引导确认草图，不调用 SDK、不落编程路径', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-ready-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guard',
      session_id: 'session-guard',
      project_id: 'project-guard',
      content: '可以了吗',
      mode: 'quick',
      current_stage: 'sketch_ready',
      channel_id: 'test-channel',
    })

    expect(sdkCalled).toBe(false)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('生成完整功能')
    expect(events.some((event) => event.type === 'completed')).toBe(true)
  })

  it('编程路径输出完整 HTML / 代码块时追加显式提示', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-code-hint-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '<!doctype html><html><body>hi</body></html>' }] },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-hint',
      session_id: 'session-hint',
      project_id: 'project-hint',
      content: '给我完整代码',
      mode: 'quick',
      current_stage: 'iterating',
      channel_id: 'test-channel',
    })

    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    // 提示语必须如实：模型贴出的代码不会自动落盘，不得声称「已生成到项目文件里」
    expect(deltas).toContain('不会自动保存进项目文件')
    expect(deltas).not.toContain('完整代码已经生成到项目文件里')
  })

  it('ready 阶段跳过 LLM 规则直答：渲染端滞后(生成中)但项目已 ready 时不调用 SDK', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-stage-ready-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    // 渲染端阶段滞后（还以为是 generating_mvp），但项目存储里已是 ready（自动测试流完成）。
    // ready 护栏必须跳过模型、规则直答「已经生成好了」，否则模型会延续历史惯性编「还没好」。
    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-stale',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-ready-stale',
      session_id: 'session-ready-stale',
      project_id: 'project-ready-stale',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'generating_mvp',
      channel_id: 'test-channel',
    })

    expect(sdkCalled).toBe(false)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好了')
    expect(deltas).toContain('右侧预览区')
    expect(events.some((event) => event.type === 'completed')).toBe(true)
  })

  it('ready 护栏以权威阶段为准：渲染端上报 sketch_ready 但项目已 ready 时直答而非确认草图', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-stage-ready-guard-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    // 最严重的滞后场景：渲染端还认为在 sketch_ready（原本会命中 sketch_ready 护栏引导「点生成完整功能」），
    // 但项目存储已 ready（MVP+测试流早已完成）。ready 护栏必须优先于 sketch_ready 护栏，
    // 规则直答「已经生成好了」，否则用户会被反复要求「点确认」/被告知「还没好」。
    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-guard',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-ready-guard',
      session_id: 'session-ready-guard',
      project_id: 'project-ready-guard',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'sketch_ready',
      channel_id: 'test-channel',
    })

    expect(sdkCalled).toBe(false)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好了')
    expect(deltas).not.toContain('生成完整功能')
    expect(events.some((event) => event.type === 'completed')).toBe(true)
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'
import { findProject } from '../../main/project-service'
import type { AgentEvent, SDKMessage } from '../../shared/types'

const { runIterationTaskMock } = vi.hoisted(() => ({
  runIterationTaskMock: vi.fn(async () => ({ preview_url: 'http://localhost:1' })),
}))

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

vi.mock('../../main/programming-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/programming-orchestrator')>()
  return { ...actual, runIterationTask: runIterationTaskMock }
})

vi.mock('../../main/project-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/project-service')>()
  return { ...original, findProject: vi.fn() }
})

/**
 * ready 护栏意图分流（「修改黑洞」修复）。
 * - 已生成完成后，用户提出修改/调整/纠错类输入 → 进入迭代重新生成（runIterationTask）。
 * - 纯进度追问（好了吗）→ 仍走固定完成文案，不误触发迭代。
 */
describe('ready 护栏意图分流', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    vi.mocked(findProject).mockReset()
    runIterationTaskMock.mockClear()
  })

  it('ready 阶段修改请求进入迭代重新生成，而非固定文案挡回', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-iter-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-iter',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-iter',
      session_id: 'session-iter',
      project_id: 'project-ready-iter',
      content: '能不能改成那种九个数字按键的那种',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-ready-iter',
        prompt: '能不能改成那种九个数字按键的那种',
      }),
    )
    expect(sdkCalled).toBe(false)
    // 不再下发「已经生成好了」固定文案
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).not.toContain('已经生成好了')
  })

  it('ready 阶段纯进度追问仍走固定完成文案，不误触发迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-progress-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-progress',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-progress',
      session_id: 'session-progress',
      project_id: 'project-ready-progress',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好了')
    expect(deltas).toContain('右侧预览区')
  })

  it('ready 阶段「货不对板/否定」类反馈（"啥意思，我要音乐合成器"）进入迭代重新生成', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-mismatch-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-mismatch',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-mismatch',
      session_id: 'session-mismatch',
      project_id: 'project-ready-mismatch',
      content: '啥意思，我要音乐合成器',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '啥意思，我要音乐合成器' }),
    )
  })

  it('ready 阶段模糊否定（L1 未命中、L2 疑似）经 L3 LLM 兜底判为修改 → 进入迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-l3-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // L3 兜底调用：模型回答 modify
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'modify' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-l3',
      workspace_slug: 'default-software-builder',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-l3',
      session_id: 'session-l3',
      project_id: 'project-ready-l3',
      content: '怎么感觉不太对劲，这跟我想要的不一样啊',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '怎么感觉不太对劲，这跟我想要的不一样啊' }),
    )
  })

  it('ready 阶段纯进度追问不触发 L3 LLM 调用（延迟不被拖累）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-nol3-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-nol3',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-nol3',
      session_id: 'session-nol3',
      project_id: 'project-ready-nol3',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(sdkCalled).toBe(false)
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

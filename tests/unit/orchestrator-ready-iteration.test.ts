import { restorePromaHome } from '../support/proma-home-guard'
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
  return { ...original, findProject: vi.fn(), updateProject: vi.fn(() => ({})) }
})

/**
 * ready 护栏意图分流（「修改黑洞」修复）+ 修改确认门。
 * - 已生成完成后，修改类输入 → 先弹「修改确认卡」（不直接整版重造）；
 * - 用户点「对，就这样改」→ 才进入迭代重新生成（runIterationTask，prompt 为清洗后的描述）；
 * - 纯进度追问（好了吗）→ 固定完成文案 + 修改出口引导，不误触发迭代。
 */
describe('ready 护栏意图分流', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    vi.mocked(findProject).mockReset()
    runIterationTaskMock.mockClear()
  })

  it('ready 阶段修改请求先弹确认卡；点「对，就这样改」后才以清洗后描述进入迭代', async () => {
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

    // 第一轮：修改诉求 → 确认卡（不是直接重生成）
    await runAgent({
      request_id: 'req-iter',
      session_id: 'session-iter',
      project_id: 'project-ready-iter',
      content: '能不能改成那种九个数字按键的那种',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(sdkCalled).toBe(false)
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
    expect(decision?.payload.questions).toEqual([
      expect.objectContaining({ id: 'confirm', label: '对，就这样改' }),
      expect.objectContaining({ id: 'rephrase', label: '不对，我重新说' }),
      expect.objectContaining({ id: 'cancel', label: '不改了' }),
    ])
    // 确认卡 reply 展示清洗后的修改点，用户认得出
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('改成那种九个数字按键的那种')
    expect(deltas).not.toContain('已经生成好了')

    // 第二轮：点「对，就这样改」→ 迭代开跑，prompt 是剥离「能不能」后的描述
    events.length = 0
    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-iter',
      current_stage: 'blocked_for_user_decision',
    } as never)
    await runAgent({
      request_id: 'req-iter-2',
      session_id: 'session-iter',
      project_id: 'project-ready-iter',
      content: '对，就这样改',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'confirm' },
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-ready-iter',
        prompt: '改成那种九个数字按键的那种',
      }),
    )
  })

  it('ready 阶段纯进度追问走模型直答（P1 自由度归还），不误触发迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-progress-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '生成好啦！点右侧预览区就能玩；想改哪里直接说。' }] } }
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
    // 直答采纳模型回复，不再落固定文案
    expect(deltas).toContain('生成好啦')
    expect(deltas).not.toContain('想调整哪里直接告诉我，比如')
  })

  it('ready 阶段「生成完整程序」类诉求命中 L1「完整」→ 弹确认卡，不付 LLM 往返、不挡回固定文案', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-complete-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-complete',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-complete',
      session_id: 'session-complete',
      project_id: 'project-ready-complete',
      content: '生成完整程序',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    // L1 词表命中「完整」→ 修改确认门，而非固定文案 / L3 LLM
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(sdkCalled).toBe(false)
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('生成完整程序')
    expect(deltas).not.toContain('已经生成好了')
  })

  it('ready 阶段「货不对板/否定」类反馈（"啥意思，我要音乐合成器"）→ 确认卡，reply 展示清洗后的「音乐合成器」', async () => {
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

    // 不直接重生成，先确认；否定引导与口语前缀被清洗后展示
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('「音乐合成器」')
  })

  it('ready 阶段模糊否定（L1 未命中、L2 疑似）经 L3 LLM 兜底判为修改 → 弹确认卡（非直接迭代）', async () => {
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

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
  })

  it('「进度词 + 修改动词」混合句（做完了没？把按钮换成蓝色）→ L1 命中弹确认卡，不被进度子串门挡回', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-mixed-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-mixed',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-mixed',
      session_id: 'session-mixed',
      project_id: 'project-ready-mixed',
      content: '做完了没？把按钮换成蓝色',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    // 放行一致化回归：此前「做完了没」进度子串优先于 L1，整句被判 other 挡回固定文案
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(sdkCalled).toBe(false) // L1 毫秒级命中，无需 LLM 往返
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).not.toContain('已经生成好了')
  })

  it('L3 兜底应答为中文「修改」仍判 modify → 弹确认卡（\b 死正则回归）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-l3-zh-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '修改' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-l3-zh',
      workspace_slug: 'default-software-builder',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-l3-zh',
      session_id: 'session-l3-zh',
      project_id: 'project-ready-l3-zh',
      content: '这配色看着有点刺眼',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    // 旧解析 /\b(...|修改|...)\b/ 的中文分支永不命中（\b 仅 ASCII），中文应答被误判 other
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
  })

  it('确认卡「不对，我重新说」/「不改了」→ 不迭代、pending 终结、阶段回 ready 并如实告知', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-rephrase-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    for (const [projectId, optionId, label, expectedCopy] of [
      ['project-rephrase', 'rephrase', '不对，我重新说', '好的，你想怎么改，直接说就行。'],
      ['project-cancel', 'cancel', '不改了', '好的，先保持现在的版本。'],
    ] as const) {
      // 先制造 pending：ready 阶段修改诉求 → 确认卡
      vi.mocked(findProject).mockReturnValue({ project_id: projectId, current_stage: 'ready' } as never)
      await runAgent({
        request_id: `req-${optionId}-1`,
        session_id: `session-${optionId}`,
        project_id: projectId,
        content: '加一个历史记录',
        mode: 'quick',
        current_stage: 'ready',
        channel_id: 'test-channel',
      })
      // 点决策卡
      vi.mocked(findProject).mockReturnValue({ project_id: projectId, current_stage: 'blocked_for_user_decision' } as never)
      await runAgent({
        request_id: `req-${optionId}-2`,
        session_id: `session-${optionId}`,
        project_id: projectId,
        content: label,
        mode: 'quick',
        current_stage: 'blocked_for_user_decision',
        channel_id: 'test-channel',
        metadata: { source: 'card_option', selected_option_id: optionId },
      })
    }

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('\n')
    expect(deltas).toContain('好的，你想怎么改，直接说就行。')
    expect(deltas).toContain('好的，先保持现在的版本。')
    const stageEvents = events
      .filter((event) => event.type === 'stage_changed')
      .map((event) => String(event.payload.stage))
    expect(stageEvents).toContain('ready')
  })

  it('确认卡过期（如重启后点旧卡，pending 已丢）→ 不迭代，如实说明过期并回 ready', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-expired-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-expired',
      current_stage: 'blocked_for_user_decision',
    } as never)

    await runAgent({
      request_id: 'req-expired',
      session_id: 'session-expired',
      project_id: 'project-expired',
      content: '对，就这样改',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'confirm' },
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('确认卡片已过期')
  })

  it('ready 阶段纯进度追问不触发 L3 意图判定，唯一 LLM 往返是直答本身', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-nol3-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalls = 0
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalls += 1
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '早就好啦，预览区见。' }] } }
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
    // 进度门短路 L3（意图判定零往返），唯一的调用是 ready 直答
    expect(sdkCalls).toBe(1)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('早就好啦')
  })

  it('BLOMA_READY_CHAT=off → 回退纯模板现状，零 LLM 往返', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-off-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_READY_CHAT = 'off'
    try {
      const events: AgentEvent[] = []
      let sdkCalled = false
      setAgentStreamPublisher((event) => events.push(event))
      setSDKQueryForTests(async function* () {
        sdkCalled = true
        yield { type: 'result', subtype: 'success' }
      })

      vi.mocked(findProject).mockReturnValue({
        project_id: 'project-ready-off',
        current_stage: 'ready',
      } as never)

      await runAgent({
        request_id: 'req-off',
        session_id: 'session-off',
        project_id: 'project-ready-off',
        content: '好了吗',
        mode: 'quick',
        current_stage: 'ready',
        channel_id: 'test-channel',
      })

      expect(sdkCalled).toBe(false)
      const deltas = events
        .filter((event) => event.type === 'message_delta')
        .map((event) => String(event.payload.text ?? ''))
        .join('')
      expect(deltas).toContain('已经生成好了')
      expect(deltas).toContain('想调整哪里直接告诉我')
    } finally {
      delete process.env.BLOMA_READY_CHAT
    }
  })

  it('直答首次命中禁词（还没好）→ 带反馈重试一次；重试干净则采用重试结果', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-retry-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let calls = 0
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      calls += 1
      const text = calls === 1 ? '还没好哦，再等等。' : '已经生成好啦，预览区就能玩。'
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-retry',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-retry',
      session_id: 'session-retry',
      project_id: 'project-ready-retry',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(calls).toBe(2)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好啦')
    expect(deltas).not.toContain('还没好')
    expect(deltas).not.toContain('想调整哪里直接告诉我，比如')
  })

  it('直答重试仍命中禁词 → 回退固定模板（最坏情况=现状零回归）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-fallback-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let calls = 0
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      calls += 1
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '还没好，后台正在跑。' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-fallback',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-fallback',
      session_id: 'session-fallback',
      project_id: 'project-ready-fallback',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(calls).toBe(2)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好了')
    expect(deltas).toContain('想调整哪里直接告诉我')
  })

  it('直答渠道故障（非取消）→ 回退固定模板，不打断完成态收口', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-chdown-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      throw new Error('CHANNEL_DOWN')
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-chdown',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-chdown',
      session_id: 'session-chdown',
      project_id: 'project-ready-chdown',
      content: '好了吗',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('已经生成好了')
    const completed = events.find((event) => event.type === 'completed')
    expect(completed).toBeDefined()
  })

  // 「我只需要理财房贷的计算器」线上案例：无修改动词、无否定/疑问语气词，
  // 曾连漏 L1/L2 两层被 READY_COMPLETION_COPY 挡回（用户只能靠点选纠错按钮绕过）。
  it('ready 阶段缩小范围类平静陈述（"我只需要理财房贷的计算器"）L1 直命中 → 确认卡，不付 LLM 往返', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-scope-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-scope',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-scope',
      session_id: 'session-scope',
      project_id: 'project-ready-scope',
      content: '我只需要理财房贷的计算器',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(sdkCalled).toBe(false)
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
  })

  it('ready 阶段平静陈述（零语气标记，L1 未命中）默认进 L3：LLM 判 modify → 确认卡', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-l3-plain-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'modify' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-l3-plain',
      workspace_slug: 'default-software-builder',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-l3-plain',
      session_id: 'session-l3-plain',
      project_id: 'project-ready-l3-plain',
      content: '界面太花了',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('iteration_confirm')
  })

  it('ready 阶段纯寒暄应答（"谢谢"）走模型直答，不再是固定文案', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-ack-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '不客气！玩得开心，想调整随时说。' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({
      project_id: 'project-ready-ack',
      current_stage: 'ready',
    } as never)

    await runAgent({
      request_id: 'req-ack',
      session_id: 'session-ack',
      project_id: 'project-ready-ack',
      content: '谢谢',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('不客气')
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

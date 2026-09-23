import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'
import { findProject } from '../../main/project-service'
import { readFileSync } from 'node:fs'
import { readExperienceEvents } from '../../main/experience/event-log'
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

vi.mock('../../main/coding/programming-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/coding/programming-orchestrator')>()
  return { ...actual, runIterationTask: runIterationTaskMock }
})

vi.mock('../../main/project-service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../main/project-service')>()
  return { ...original, findProject: vi.fn(), updateProject: vi.fn(() => ({})) }
})

/**
 * ready 护栏意图分流（2026-09-11 卡位改版后）。
 *
 * 新语义：MVP 就绪三按钮卡（keep/optimize/rebuild）在生成完即弹（在 runJudgeReview 侧发，
 * 本文件不覆盖其触发点）。本文件覆盖**回传决策与打字分流**：
 * - 用户直接打字提修改 → 一律按「局部优化」（localOnly），不再弹确认卡；
 * - 就绪卡 keep → 回 ready + 发引导卡；
 * - 就绪卡 optimize → 补充态 → 用户补充 → 局部修改；
 * - 就绪卡 rebuild → 补充态 → 用户说方向 → 二次确认卡 → 确定 → 整版重做（rebuild）；
 * - 纯进度追问/寒暄 → 直答，不误触发迭代。
 */
describe('ready 护栏意图分流（MVP 就绪卡改版后）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    vi.mocked(findProject).mockReset()
    runIterationTaskMock.mockClear()
  })

  it('ready 阶段直接打字提修改 → 直接走局部优化（localOnly），不弹确认卡', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-local-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    let sdkCalled = false
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      sdkCalled = true
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-local', current_stage: 'ready' } as never)

    await runAgent({
      request_id: 'req-local',
      session_id: 'session-local',
      project_id: 'project-local',
      content: '把标题改成计算助手',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-local',
        prompt: expect.stringContaining('计算助手'),
        localOnly: true,
      }),
    )
    // 直接打字不弹卡、不付 LLM 意图判定
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
    expect(sdkCalled).toBe(false)
  })

  it('ready 阶段纯进度追问走模型直答，不误触发迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-progress-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '生成好啦！点右侧预览区就能玩；想改哪里直接说。' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-ready-progress', current_stage: 'ready' } as never)

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
    expect(deltas).toContain('生成好啦')
  })

  it('就绪卡「保持现状」→ 回 ready 并顺势发「走向完整产物」引导卡，不迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-keep-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-keep', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-keep',
      session_id: 'session-keep',
      project_id: 'project-keep',
      content: '保持现状',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'keep' },
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('ready_next_steps')
    const stageEvents = events
      .filter((event) => event.type === 'stage_changed')
      .map((event) => String(event.payload.stage))
    expect(stageEvents).toContain('ready')
  })

  it('就绪卡「局部优化」→ 置补充态 + 回 ready；用户补充后走局部修改（localOnly），不再弹卡', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-optimize-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    // 点「局部优化」
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-optimize', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-opt-1',
      session_id: 'session-opt',
      project_id: 'project-optimize',
      content: '局部优化',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'optimize' },
    })
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(
      events
        .filter((event) => event.type === 'message_delta')
        .map((event) => String(event.payload.text ?? ''))
        .join(''),
    ).toContain('说说你想改哪里')

    // 用户补充具体诉求 → 直接局部修改
    events.length = 0
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-optimize', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-opt-2',
      session_id: 'session-opt',
      project_id: 'project-optimize',
      content: '标题改成计算助手',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })
    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ project_id: 'project-optimize', prompt: expect.stringContaining('计算助手'), localOnly: true }),
    )
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
  })

  it('就绪卡「整版重做」→ 置补充态；用户说方向 → 弹二次确认卡（不立即重做）→ 确定后整版重做（rebuild）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-rebuild-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    // 点「整版重做」
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-rebuild', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-rebuild-1',
      session_id: 'session-rebuild',
      project_id: 'project-rebuild',
      content: '整版重做',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'rebuild' },
    })
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    expect(
      events
        .filter((event) => event.type === 'message_delta')
        .map((event) => String(event.payload.text ?? ''))
        .join(''),
    ).toContain('想往哪个方向重做')

    // 用户说重做方向 → 二次确认卡（先不重做）
    events.length = 0
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-rebuild', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-rebuild-2',
      session_id: 'session-rebuild',
      project_id: 'project-rebuild',
      content: '改用卡片式布局',
      mode: 'quick',
      current_stage: 'ready',
      channel_id: 'test-channel',
    })
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const confirmCard = events.find((event) => event.type === 'user_decision_required')
    expect(confirmCard?.payload.kind).toBe('rebuild_confirm')
    const questions = confirmCard?.payload.questions as Array<{ id: string }> | undefined
    expect(questions?.map((q) => q.id)).toEqual(['rebuild_confirm', 'rebuild_cancel'])

    // 点「确定整版重做」→ 整版重做（rebuild: true，带已收集方向）
    events.length = 0
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-rebuild', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-rebuild-3',
      session_id: 'session-rebuild',
      project_id: 'project-rebuild',
      content: '确定整版重做',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'rebuild_confirm' },
    })
    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: 'project-rebuild',
        prompt: expect.stringContaining('卡片式布局'),
        rebuild: true,
      }),
    )

    // UNPROVEN-2 补证（2026-09-11 审计）：真实 mergeIterationRequirements 把方向并入
    // 需求清单（F1 修复锁：无渠道/无 query 时走回退追加，方向原文仍在清单中）
    const { mergeIterationRequirements } = await import('../../main/coding/programming-orchestrator')
    const mergedRebuild = await mergeIterationRequirements(
      {
        request_id: 'req-merge-verify',
        session_id: 'session-rebuild',
        project_id: 'project-rebuild',
        mode: 'quick',
        prompt: '改用卡片式布局',
      },
      [{ id: 'F-001', description: '记录收入与支出', behavior_assertions: [], priority: 'P0' as const }],
    )
    expect(mergedRebuild.requirements.some((r) => String(r.description).includes('卡片式布局'))).toBe(true)
  })

  it('二次确认态打字补充方向 → 更新方向并重发确认卡，不静默跑局部修改（F-B 修复）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-rebuild-fb-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    // 就绪卡「整版重做」→ 说方向 → 二次确认卡
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-fb-1', session_id: 'session-fb', project_id: 'project-fb',
      content: '整版重做', mode: 'quick', current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel', metadata: { source: 'card_option', selected_option_id: 'rebuild' },
    })
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-fb-2', session_id: 'session-fb', project_id: 'project-fb',
      content: '改用卡片式布局', mode: 'quick', current_stage: 'ready', channel_id: 'test-channel',
    })

    // 确认卡挂着时打字补充方向（blocked 态、无卡 metadata）→ 更新方向重发确认卡
    events.length = 0
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-fb-3', session_id: 'session-fb', project_id: 'project-fb',
      content: '再改成深色主题', mode: 'quick', current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
    })
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const confirmCard = events.find((event) => event.type === 'user_decision_required')
    expect(confirmCard?.payload.kind).toBe('rebuild_confirm')
    expect(
      events
        .filter((event) => event.type === 'message_delta')
        .map((event) => String(event.payload.text ?? ''))
        .join(''),
    ).toContain('深色主题')

    // 点「确定整版重做」→ 用更新后的方向重做
    events.length = 0
    await runAgent({
      request_id: 'req-fb-4', session_id: 'session-fb', project_id: 'project-fb',
      content: '确定整版重做', mode: 'quick', current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel', metadata: { source: 'card_option', selected_option_id: 'rebuild_confirm' },
    })
    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: expect.stringContaining('深色主题'), rebuild: true }),
    )
  })

  it('二次确认卡「再想想」→ 不重做，回 ready 保持当前版本', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-rebuild-cancel-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-rc', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-rc',
      session_id: 'session-rc',
      project_id: 'project-rc',
      content: '再想想',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'rebuild_cancel' },
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('先保持现在的版本')
  })

  it('二次确认（状态丢失，无已收集方向）→ 如实说明过期，不重做', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-expired-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(defaultTestQuery)

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-expired', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-expired',
      session_id: 'session-expired',
      project_id: 'project-expired',
      content: '确定整版重做',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'rebuild_confirm' },
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('过期')
  })

  it('ready 阶段纯寒暄应答（"谢谢"）走模型直答，不误触发迭代', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ready-ack-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '不客气！玩得开心，想调整随时说。' }] } }
      yield { type: 'result', subtype: 'success' }
    })

    vi.mocked(findProject).mockReturnValue({ project_id: 'project-ready-ack', current_stage: 'ready' } as never)

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

describe('Phase 10 W4：一键反馈卡（BLOMA_FEEDBACK_CARD）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalExp = process.env.BLOMA_EXPERIENCE
  const originalFb = process.env.BLOMA_FEEDBACK_CARD

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    vi.mocked(findProject).mockReset()
    if (originalExp === undefined) delete process.env.BLOMA_EXPERIENCE
    else process.env.BLOMA_EXPERIENCE = originalExp
    if (originalFb === undefined) delete process.env.BLOMA_FEEDBACK_CARD
    else process.env.BLOMA_FEEDBACK_CARD = originalFb
  })

  it('keep + 开关 on：反馈卡替代引导卡（五选项 fb_*）；off 由既有 keep 用例锁（直接引导卡）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-fb-on-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_FEEDBACK_CARD = '1'
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb-on', current_stage: 'blocked_for_user_decision' } as never)
    await runAgent({
      request_id: 'req-fb-on', session_id: 'session-fb', project_id: 'project-fb-on',
      content: '保持现状', mode: 'quick', current_stage: 'blocked_for_user_decision', channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'keep' },
    })
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('delivery_feedback')
    const ids = (decision?.payload.questions as Array<{ id: string }>).map((q) => q.id)
    expect(ids).toEqual(['fb_broken', 'fb_feature_broken', 'fb_unsatisfied', 'fb_change_needs', 'fb_later'])
  })

  it('fb_feature_broken：issue_hypothesis 事件行 + issue_reported 埋点 + 引导修的话术', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-fb-neg-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_EXPERIENCE = '1'
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb-neg', workspace_slug: 'default-software-builder', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-fb-neg', session_id: 'session-fbn', project_id: 'project-fb-neg',
      content: '关键功能无效', mode: 'quick', current_stage: 'ready', channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'fb_feature_broken' },
    })
    const exp = readExperienceEvents()
    expect(exp.some((e) => e.event_type === 'issue_hypothesis' && e.observations[0].includes('key_feature_broken'))).toBe(true)
    const analytics = readFileSync(join(home, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl'), 'utf8')
    expect(analytics).toContain('issue_reported')
    expect(analytics).toContain('feedback_card')
    const deltas = events.filter((e) => e.type === 'message_delta').map((e) => String(e.payload.text ?? '')).join('')
    expect(deltas).toContain('哪个功能')
  })

  it('fb_later：顺势发引导卡（ready_next_steps）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-fb-later-'))
    process.env.PROMA_HOME = home
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb-later', workspace_slug: 'default-software-builder', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-fb-later', session_id: 'session-fbl', project_id: 'project-fb-later',
      content: '暂不反馈', mode: 'quick', current_stage: 'ready', channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'fb_later' },
    })
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('ready_next_steps')
  })

  it('fb_change_needs：behavior_signal 事件（requirement_change_requested）+ 输入框引导话术', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-fb-change-'))
    process.env.PROMA_HOME = home
    process.env.BLOMA_EXPERIENCE = '1'
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    vi.mocked(findProject).mockReturnValue({ project_id: 'project-fb-change', workspace_slug: 'default-software-builder', current_stage: 'ready' } as never)
    await runAgent({
      request_id: 'req-fb-chg', session_id: 'session-fbc', project_id: 'project-fb-change',
      content: '改变需求', mode: 'quick', current_stage: 'ready', channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: 'fb_change_needs' },
    })
    const exp = readExperienceEvents()
    expect(exp.some((e) => e.event_type === 'behavior_signal' && e.observations[0].includes('requirement_change_requested'))).toBe(true)
    const deltas = events.filter((e) => e.type === 'message_delta').map((e) => String(e.payload.text ?? '')).join('')
    expect(deltas).toContain('输入框')
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

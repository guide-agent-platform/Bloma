import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

// 2026-09-16 FILE-LEVEL 钉：BLOMA_GUIDE_LOOP 缺省翻转 on，本文件全部用例锁旧单次 JSON 路径
process.env.BLOMA_GUIDE_LOOP = '0'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'

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
import { createProject, findProject, readLastSketchRequirements } from '../../main/project-service'
import { PRD_CONFIRM_OPTION_CONFIRM } from '../../main/guide/prd-confirm'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import type { AgentEvent, SDKMessage } from '../../shared/types'

// timeout 30s：本文件用例含真实 IO（mkdtemp/createProject 写盘/runAgent 子流程），
// 全量 62 文件并发跑时 IO 争抢可使单用例从 ~0.7s 膨胀到 >5s，默认 5s 偶发超时并级联失败
//（2026-08-28 flaky 实测：首轮 10 失败含 5005ms 超时，重跑全绿）。放宽到 30s 只影响真 hang 的捕捉时机。
describe('GuideAgentService through AgentOrchestrator', { timeout: 30_000 }, () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
  })

  it('emits up to three clarification cards using user_decision_required', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '记账',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('clarification')
    expect(decision?.payload.questions).toHaveLength(3)
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('generates a sketch and emits sketch_ready when the requirement is clear', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做一个家庭记账工具，记录收入支出并展示月度结余',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const ready = events.find((event) => event.type === 'sketch_ready')
    expect(ready?.payload.preview_url).toBe('http://localhost:3100')
    expect(ready?.payload.snapshot_id).toBeTruthy()
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
  })

  it('A2-14a: 已过澄清轮后模型返回 generate_sketch JSON 时经 PRD 确认门进入草图生成（不过目不开工，2026-08-27）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 预置一轮已完成的澄清往返：首轮必须澄清（2026-08-16 硬护栏），
    // 非首轮的 generate_sketch 才允许直接开工
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    writeFileSync(
      join(home, 'agent-sessions', 'session-guide.jsonl'),
      [
        JSON.stringify({ role: 'user', content: [{ type: 'text', text: '做一个记账工具' }], timestamp: 1 }),
        JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: '要给谁用、记什么？' }], timestamp: 2 }),
      ].join('\n') + '\n',
      'utf8',
    )
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"generate_sketch","reply":"好的，马上开始","requirements":[{"id":"F-001","description":"记录收入支出"}]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })
    setSandboxRuntimeForTests({
      portAllocator: async () => 3101,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做一个记账工具，记录收入支出',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    // generate_sketch 收口（2026-08-27）：不再直达草图——先走 PRD→审查→确认卡挂起，
    // 草图必须等用户过目 PRD 确认后才并跑
    const confirmCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(confirmCard).toBeTruthy()
    expect(events.find((event) => event.type === 'sketch_ready')).toBeUndefined()
    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '确认无误',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM },
    })

    const ready = events.find((event) => event.type === 'sketch_ready')
    expect(ready).toBeTruthy()
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
    // 只把用户可见的 reply 上屏，原始 JSON 契约不得泄露
    const deltaTexts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltaTexts).toContain('好的，马上开始')
    // 本 mock 的草图 LLM 输出非 HTML → 模板回退必须如实告知（草图说明，2026-08-15 静默回退案例）
    expect(deltaTexts).toContain('草图说明')
    // PRD 管线收口后，中间链路（PRD 引擎流式旁白）在 mock 下会转发 scripted 原文，
    // 原始 JSON 契约的防泄露断言收敛到会话 JSONL 落盘层（persistAssistant 只落 reply）
    // 会话 JSONL 落盘的也是 reply 而非原始 JSON
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('好的，马上开始')
    expect(jsonl).not.toContain('"action":"generate_sketch"')
  })

  it('A2-14a: 模型返回 ask_clarification JSON 时用模型 questions 发澄清卡片', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"ask_clarification","reply":"想确认一下范围","questions":[{"id":"daily","label":"日常工具","description":"记账提醒清单"}]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做一个工具',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.kind).toBe('clarification')
    // 纠偏：模型只给 1 个方向项时补「你帮我决定」兜底，保证卡片始终有明确可选项
    expect(decision?.payload.questions).toEqual([
      expect.objectContaining({ id: 'daily', label: '日常工具' }),
      expect.objectContaining({ id: 'auto', label: '你帮我决定' }),
    ])
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    // 上屏与落盘的只有 reply，原始 JSON 不泄露
    const deltaTexts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltaTexts).toBe('想确认一下范围')
    expect(deltaTexts).not.toContain('{"action"')
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('想确认一下范围')
    expect(jsonl).not.toContain('"action":"ask_clarification"')
  })

  it('A2-14a: 模型 questions 为空（纯文本澄清）时只显示 reply，不弹卡片、不泄露 JSON', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // 复现用户报障：模型返回 ask_clarification 且 questions:[]（在 reply 里直接追问）
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"ask_clarification","reply":"你好！想做什么样的应用呢？简单描述一下你的想法，我来帮你梳理～","questions":[]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '计算器',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.questions).toEqual([]) // 不弹卡片
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')

    // 聊天气泡里是友好 reply，不是 {"action":...} 原始 JSON
    const deltaTexts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltaTexts).toBe('你好！想做什么样的应用呢？简单描述一下你的想法，我来帮你梳理～')
    expect(deltaTexts).not.toContain('{"action"')
    expect(deltaTexts).not.toContain('questions')

    // 会话 JSONL 同样只落 reply
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('简单描述一下你的想法')
    expect(jsonl).not.toContain('"action":"ask_clarification"')
  })

  it('澄清选项纠偏：占位/问句式 label 过滤、重复去重、上限 3+兜底，且选项落盘可追溯', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // 模型把占位文案、新问题、重复项全混进 questions（历史报障形态）
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"ask_clarification","reply":"想做哪种工具呢？","questions":[' +
              '{"id":"a","label":"范围选项","description":"占位"},' +
              '{"id":"b","label":"做什么类型？"},' +
              '{"id":"c","label":"记账本","description":"记收入支出"},{"id":"d","label":"记账本"},' +
              '{"id":"e","label":"待办清单"},{"id":"f","label":"纪念日提醒"}]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做个工具',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    const labels = (decision?.payload.questions as Array<{ label: string }>).map((q) => q.label)
    // 占位/问句丢弃、重复去重、模型方向项最多 3 个、末尾必补「你帮我决定」
    expect(labels).toEqual(['记账本', '待办清单', '纪念日提醒', '你帮我决定'])
    // 卡片选项原文落盘（[decision-card] 内部标记），事后可追溯弹过哪些选项
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('[decision-card] 记账本｜待办清单｜纪念日提醒｜你帮我决定')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('澄清选项纠偏：模型选项全非法时降级为纯文本追问（questions 空，不弹卡片）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"ask_clarification","reply":"想做什么样的应用呢？","questions":[' +
              '{"id":"a","label":"选项一"},{"id":"b","label":"范围选项"},{"id":"c","label":"哪种类型？"}]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '做个东西',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    // 光杆占位选项绝不弹给用户，降级为 reply 纯文本追问
    expect(decision?.payload.questions).toEqual([])
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).not.toContain('[decision-card]')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('卡片答案防 id 撞车：模型卡片复用 daily 但 label 含义不同 → 需求用点选原文，不用预置扩写', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-card-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3104,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    // 第一轮：模糊需求 → 规则澄清卡片
    await runAgent({
      request_id: 'req-card-1',
      session_id: 'session-card',
      project_id: project.project_id,
      content: '帮我做个东西',
      mode: 'quick',
      current_stage: 'clarifying',
    })

    // 第二轮：模型弹的卡片 id 恰好是 daily，但用户点的是「音乐节排期」
    await runAgent({
      request_id: 'req-card-2',
      session_id: 'session-card',
      project_id: project.project_id,
      content: '音乐节排期',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      metadata: { source: 'card_option', selected_option_id: 'daily' },
    })

    // 收敛路径统一收口（2026-08-27）：点选不再直接开工，进入 PRD 后置链 → 审查 → PRD 确认卡挂起
    const prdCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(prdCard).toBeTruthy()
    const stories = ((prdCard!.payload as { requirements?: Array<{ story?: string }> }).requirements ?? [])
      .map((item) => item.story ?? '')
      .join('\n')
    // 需求以主题为锚点、以点选原文为方向，绝不映射到「日常生活工具」预置文案
    expect(stories).toContain('帮我做个东西')
    expect(stories).toContain('音乐节排期')
    expect(stories).not.toContain('日常生活工具')
    // 挂起不开工：草图等用户确认 PRD 后才生成
    expect(events.find((event) => event.type === 'sketch_ready')).toBeUndefined()
  })

  it('A2-14a: 模型输出非 JSON 时回退规则路由', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // 模型只会说人话，不给 JSON
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '这个想法很有意思，再多说一点？' }] },
      }
      yield { type: 'result', subtype: 'success' }
    })

    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '记账',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    // 回退到规则：仍发出固定 3 个澄清问题
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.questions).toHaveLength(3)
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('A2-14a: 未配置渠道时引导对话回退规则、不抛 CHANNEL_NOT_FOUND', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))

    // 不带 channel_id：runAgent 应让引导走规则兜底，而非抛错
    await runAgent({
      request_id: 'req-guide',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '记账',
      mode: 'quick',
      current_stage: 'clarifying',
    })

    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision?.payload.questions).toHaveLength(3)
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  })

  it('卡片答案（你帮我决定）统一走让渡流：card_auto 留痕 + PRD 确认卡挂起，不再直接开草图', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3102,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    // 第一轮：模糊需求 → 澄清卡片
    await runAgent({
      request_id: 'req-guide-1',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '帮我做个东西',
      mode: 'quick',
      current_stage: 'clarifying',
    })
    expect(events.filter((event) => event.type === 'user_decision_required')).toHaveLength(1)

    // 第二轮：点击「你帮我决定」卡片 → 让渡统一（点选/打字同一仪式）：留痕 card_auto + PRD 确认卡挂起
    await runAgent({
      request_id: 'req-guide-2',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '你帮我决定',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      metadata: { source: 'card_option', selected_option_id: 'auto' },
    })

    // 没有第二次澄清（排除 PRD/需求确认等专属决策卡后，仅剩首轮一张澄清卡）
    const clarifications = events.filter((event) => {
      if (event.type !== 'user_decision_required') return false
      const kind = (event.payload as { kind?: string }).kind ?? ''
      return kind !== 'prd_confirm' && kind !== 'prd_review' && kind !== 'requirement_confirm'
    })
    expect(clarifications).toHaveLength(1)
    // PRD 确认卡已发（挂起等用户过目），未直接开草图
    const prdCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(prdCard).toBeTruthy()
    expect(events.find((event) => event.type === 'sketch_ready')).toBeUndefined()
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')

    // 规则路径的助手回复也写入会话 JSONL（回访恢复一致性）+ 让渡留痕
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('我需要再确认几个关键点')
    expect(jsonl).toContain('我来定方向，先整理成产品需求文档')
    expect(jsonl).toContain('card_auto')
  })

  it('澄清后生成草图保留主题锚点，不被澄清答案覆盖（货不对板修复）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-guide-theme-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3103,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    // 第一轮：主题 → 模型反问类型（ask_clarification），不生成草图
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"ask_clarification","reply":"你说的音乐合成器想要哪种类型呢？","questions":[]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })
    await runAgent({
      request_id: 'req-theme-1',
      session_id: 'session-theme',
      project_id: project.project_id,
      content: '帮我做一个音乐合成器',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    // 第二轮：澄清答案「网页端」→ 模型 generate_sketch 却把主题丢了，只返回「网页端」
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{
            type: 'text',
            text: '{"action":"generate_sketch","reply":"好的，开始生成","requirements":[{"id":"F-001","description":"网页端"}]}',
          }],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })
    await runAgent({
      request_id: 'req-theme-2',
      session_id: 'session-theme',
      project_id: project.project_id,
      content: '网页端',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
    })

    // 需求清单必须以主题为 F-001 锚点，澄清答案只追加为后续项，而不是覆盖主题。
    // generate_sketch 收口（2026-08-27）：先过 PRD 确认门，确认后才开草图
    const confirmCard = events.find(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string }).kind === 'prd_confirm',
    )
    expect(confirmCard).toBeTruthy()
    await runAgent({
      request_id: 'req-theme-2c',
      session_id: 'session-theme',
      project_id: project.project_id,
      content: '确认无误',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      channel_id: 'test-channel',
      metadata: { source: 'card_option', selected_option_id: PRD_CONFIRM_OPTION_CONFIRM },
    })
    const descriptions = readLastSketchRequirements(project.project_id).map((r) => r.description)
    expect(descriptions[0]).toBe('帮我做一个音乐合成器')
    expect(descriptions).toContain('网页端')
  })
})

async function* defaultTestQuery(): AsyncGenerator<SDKMessage> {
  yield {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'test' }] },
  }
  yield { type: 'result', subtype: 'success' }
}

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

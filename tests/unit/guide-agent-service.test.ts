import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
import { createProject, findProject } from '../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import type { AgentEvent, SDKMessage } from '../../shared/types'

describe('GuideAgentService through AgentOrchestrator', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
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

  it('A2-14a: 模型返回 generate_sketch JSON 时直接进入草图生成', async () => {
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

    const ready = events.find((event) => event.type === 'sketch_ready')
    expect(ready).toBeTruthy()
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
    // 只把用户可见的 reply 上屏，原始 JSON 契约不得泄露
    const deltaTexts = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltaTexts).toBe('好的，马上开始')
    expect(deltaTexts).not.toContain('{"action"')
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
    expect(decision?.payload.questions).toEqual([
      expect.objectContaining({ id: 'daily', label: '日常工具' }),
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

  it('卡片答案（你帮我决定）直接生成草图，不再重复澄清，且助手回复落盘', async () => {
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

    // 第二轮：点击「你帮我决定」卡片 → 直接生成草图，不再重复澄清
    await runAgent({
      request_id: 'req-guide-2',
      session_id: 'session-guide',
      project_id: project.project_id,
      content: '你帮我决定',
      mode: 'quick',
      current_stage: 'blocked_for_user_decision',
      metadata: { source: 'card_option', selected_option_id: 'auto' },
    })

    const decisions = events.filter((event) => event.type === 'user_decision_required')
    const ready = events.find((event) => event.type === 'sketch_ready')
    expect(decisions).toHaveLength(1) // 没有第二次澄清
    expect(ready?.payload.preview_url).toBe('http://localhost:3102')
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')

    // 规则路径的助手回复也写入会话 JSONL（回访恢复一致性）
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-guide.jsonl'), 'utf8')
    expect(jsonl).toContain('我需要再确认几个关键点')
    expect(jsonl).toContain('按你选的方向开始生成草图')
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

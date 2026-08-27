import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAgent, setAgentStreamPublisher, setSDKQueryForTests } from '../../main/orchestrator'
import { createProject, findProject, readLastSketchRequirements, recordSketchGenerated, updateProject } from '../../main/project-service'
import { getAgentSessionPath } from '../../storage/config-paths'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests, setSnapshotCaptureProviderForTests } from '../../main/platform-services'
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
    restorePromaHome(originalPromaHome)
    setAgentStreamPublisher(() => undefined)
    setSDKQueryForTests(defaultTestQuery)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
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

  it('sketch_ready 阶段提修改意见 → 并入需求重新生成草图，不再只回固定文案（2026-08-16 用户反馈）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-modify-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-sketch-modify', mode: 'quick' })
    updateProject(project.project_id, { current_stage: 'sketch_ready' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '家庭记账，记录收入支出' }])
    // 权威阶段以 findProject 存储为准：mock 返回刚创建的真实项目（root_path 指向临时 home）
    vi.mocked(findProject).mockReturnValue({ ...project, current_stage: 'sketch_ready' } as never)

    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // 草图 LLM 输出完整 HTML（含 <style> 且 </html> 闭合 → isHtmlDocument 通过，走 LLM 路径不落模板）
    setSDKQueryForTests(async function* () {
      yield {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '<!doctype html><html><head><style>body{color:#3355ff}</style></head><body><main>记账</main></body></html>' }] },
      }
      yield { type: 'result', subtype: 'success' }
    })
    setSandboxRuntimeForTests({
      portAllocator: async () => 3102,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    // 「改成」命中 L1 修改意图规则，不依赖 LLM 兜底判定
    await runAgent({
      request_id: 'req-sketch-modify',
      session_id: 'session-sketch-modify',
      project_id: project.project_id,
      content: '主色调改成蓝色，标题再大一点',
      mode: 'quick',
      current_stage: 'sketch_ready',
      channel_id: 'test-channel',
    })

    // 修改意见并入需求清单：原 F-001 保留 + 追加一条含修改意见的新需求
    const requirements = readLastSketchRequirements(project.project_id)
    expect(requirements.some((item) => item.id === 'F-001' && item.description.includes('记账'))).toBe(true)
    expect(requirements.some((item) => item.id !== 'F-001' && item.description.includes('蓝色'))).toBe(true)
    // 重新走草图生成并落回 sketch_ready（而非直接进 MVP 或只回固定引导文案）
    expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'generating_sketch')).toBe(true)
    expect(events.some((event) => event.type === 'sketch_ready')).toBe(true)
    const deltas = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => String(event.payload.text ?? ''))
      .join('')
    expect(deltas).toContain('调整草图')
    expect(deltas).not.toContain('生成完整功能')
    expect(events.some((event) => event.type === 'completed')).toBe(true)
  })

  it('sketch_ready 修改意见经归一化：修正类诉求 revise 已有功能项，不再追加碎片（2026-08-16 复测 43b47a47）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-norm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-sketch-norm', mode: 'quick' })
    updateProject(project.project_id, { current_stage: 'sketch_ready' })
    recordSketchGenerated(project.project_id, [
      { id: 'F-001', description: '家庭记账，记录收入支出' },
      { id: 'F-002', description: '页面样式简洁' },
    ])
    vi.mocked(findProject).mockReturnValue({ ...project, current_stage: 'sketch_ready' } as never)

    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    // query 按调用次数分流：第 1 次=需求归一化（revise F-002），第 2 次=草图 LLM
    // （完整 HTML 含 <style> 且 </html> 闭合 → isHtmlDocument 通过，走 LLM 路径不落模板）
    const SKETCH_HTML = '<!doctype html><html><head><style>body{color:#3333ff}</style></head><body><main>记账</main></body></html>'
    let call = 0
    const capturedOptions: Array<{ providerType?: string }> = []
    setSDKQueryForTests(async function* (_prompt: string, options: { providerType?: string }) {
      capturedOptions.push(options)
      call += 1
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: call === 1 ? '{"action":"revise","revise_id":"F-002","description":"页面主色调为蓝色，标题字号加大"}' : SKETCH_HTML,
            },
          ],
        },
      }
      yield { type: 'result', subtype: 'success' }
    })
    setSandboxRuntimeForTests({
      portAllocator: async () => 3103,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    // 「改成」命中 L1 修改意图规则，不依赖 LLM 兜底判定
    await runAgent({
      request_id: 'req-sketch-norm',
      session_id: 'session-sketch-norm',
      project_id: project.project_id,
      content: '页面样式改成蓝色',
      mode: 'quick',
      current_stage: 'sketch_ready',
      channel_id: 'test-channel',
    })

    // omit 推广（审查 P2-④ 补强）：归一化 LLM 调用（首个）透传渠道 providerType（anthropic）
    expect(capturedOptions.length).toBeGreaterThan(0)
    expect(capturedOptions[0]?.providerType).toBe('anthropic')
    // revise 不扩容：修正吸收进 F-002 描述，而不是新增 F-003 碎片
    const requirements = readLastSketchRequirements(project.project_id)
    expect(requirements).toHaveLength(2)
    expect(requirements.find((item) => item.id === 'F-002')?.description).toBe('页面主色调为蓝色，标题字号加大')
    expect(requirements.find((item) => item.id === 'F-001')?.description).toBe('家庭记账，记录收入支出')
    // 归一化决策落 T2 决策日志（requirement_normalized）；JSONL 行是 JSON-in-JSON，
    // 决策文本经转义嵌入，先解析行再断言解码后文本
    const decisionText = readFileSync(getAgentSessionPath('session-sketch-norm'), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as { content?: Array<{ text?: string }> }
        } catch {
          return null
        }
      })
      .filter((message): message is { content: Array<{ text?: string }> } => message !== null)
      .map((message) => message.content?.[0]?.text ?? '')
      .find((text) => text.startsWith('[decision]'))
    expect(decisionText).toBeTruthy()
    expect(decisionText).toContain('"type":"requirement_normalized"')
    expect(decisionText).toContain('F-002')
    // 草图照常重生成并落回 sketch_ready
    expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'generating_sketch')).toBe(true)
    expect(events.some((event) => event.type === 'sketch_ready')).toBe(true)
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

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

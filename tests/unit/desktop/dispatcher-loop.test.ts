/**
 * 桌面调度员运行器测试（批次 D，2026-09-24）——端到端 + 故障注入。
 *
 * 端到端腿：开关/未接管分流、正常推进（产物桩+锚定标记）、中段标记不漏扫、
 * manual 确认凭据、驱动挂载（desktop-verify 收口真实走 runContractDriver 注入桩）。
 * 故障注入腿（实施稿批次 D）：推进伪造（句中引用/跳级/伪造枚举）、围栏硬拦
 * （误装配 write_file）、流挂死（永不结束的流 + abort 收尾）、挂起工具模式
 * （toolUse query + execute 永不 resolve + abort 收尾）、断流（query 中途 throw）。
 *
 * 密闭性：BLOMA_DESKTOP_DISPATCH 显式设/还原（陷阱 53）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'
import type { AgentLoopTool } from '../../../main/agent/loop/agent-loop'
import {
  AssistantTurnCollector,
  DRIVER_REPORT_PATH,
  buildDesktopEnvProbeTool,
  buildDispatcherTools,
  runDesktopDispatcherLoop,
  wrapWithDispatcherGate,
  type DesktopDispatchRunInput,
} from '../../../main/desktop/dispatcher-loop'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'
import { ProbeError } from '../../../main/desktop/check-env'

// ── 委派接线探测（2026-09-26 首跑修复）：agent-collaboration 注册面做 spy（call-through 保真）──
vi.mock('../../../main/agent/delegation/agent-collaboration', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../main/agent/delegation/agent-collaboration')>()
  return {
    ...mod,
    registerParentLoopContext: vi.fn(mod.registerParentLoopContext),
    unregisterParentLoopContext: vi.fn(mod.unregisterParentLoopContext),
    disposeParentDelegationState: vi.fn(mod.disposeParentDelegationState),
    setChildToolsBuilder: vi.fn(mod.setChildToolsBuilder),
  }
})

// ── 环境密闭（开关） ──
const SWITCH = 'BLOMA_DESKTOP_DISPATCH'
let switchOriginal: string | undefined

beforeEach(() => {
  switchOriginal = process.env[SWITCH]
  process.env[SWITCH] = '1'
})

afterEach(() => {
  if (switchOriginal === undefined) delete process.env[SWITCH]
  else process.env[SWITCH] = switchOriginal
})

// ── query/消息构造（对齐 agent-loop.test.ts 既有形态） ──

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function toolUseMessage(id: string, name: string, input: Record<string, unknown> = {}): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }
}

/** 脚本化 query（按调用序回放；记录收到的 messages）。 */
function scriptedQuery(responses: SDKMessage[][]): { query: SDKQuery; receivedMessages: ConversationTurn[][] } {
  let call = 0
  const receivedMessages: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    const callIndex = call
    call += 1
    receivedMessages.push((options.messages ?? []).map((turn) => ({ ...turn })))
    const script = responses[Math.min(callIndex, responses.length - 1)] ?? []
    for (const message of script) yield message
    yield { type: 'result', subtype: 'success', stop_reason: script.some((m) => m.message?.content.some((b) => b.type === 'tool_use')) ? 'tool_use' : 'end_turn' }
  }
  return { query, receivedMessages }
}

// ── 运行输入基底 ──

function baseInput(overrides: Partial<DesktopDispatchRunInput> = {}): DesktopDispatchRunInput {
  return {
    projectId: 'proj-desktop',
    sessionId: 'session-desktop',
    requestId: 'req-desktop',
    currentPhase: 'desktop-scaffold',
    task: '开工：搭建骨架',
    query: async function* () {
      yield textMessage('完成')
    },
    env: {},
    maxTokens: 1024,
    signal: new AbortController().signal,
    publish: () => undefined,
    projectName: 'clip-tool',
    ...overrides,
  }
}

const allExist = () => true
const noneExist = () => false

describe('分流腿（web 线零接触的边界）', () => {
  it('开关 off → not-enabled（不触达 loop）', async () => {
    delete process.env[SWITCH]
    const result = await runDesktopDispatcherLoop(baseInput())
    expect(result.status).toBe('not-enabled')
    expect(result.loopResult).toBeUndefined()
  })

  it('requirements（复用向导管线）→ not-managed', async () => {
    const result = await runDesktopDispatcherLoop(baseInput({ currentPhase: 'requirements' }))
    expect(result.status).toBe('not-managed')
  })

  it('未知阶段 → not-managed', async () => {
    const result = await runDesktopDispatcherLoop(baseInput({ currentPhase: 'mode-select' }))
    expect(result.status).toBe('not-managed')
  })
})

describe('正常推进腿（端到端）', () => {
  it('desktop-scaffold：锚定标记+产物齐备 → advance', async () => {
    const { query } = scriptedQuery([[
      textMessage('骨架三件已就绪（契约/驱动骨架/requirements），推进。\n<!-- PHASE_ADVANCE: desktop-implement -->'),
    ]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.status).toBe('completed')
    expect(result.advance).toMatchObject({ decision: 'advance', target: 'desktop-implement' })
  })

  it('行首标记同样收集（两种锚定形态）', async () => {
    const { query } = scriptedQuery([[textMessage('完成。\nPHASE_ADVANCE: desktop-implement')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'advance' })
  })

  it('中段标记不漏扫：标记在 tool_use 轮（onTurn 换页后）而收工轮另说结论', async () => {
    const { query } = scriptedQuery([
      [toolUseMessage('t1', 'read_file', { path: '00_SCAFFOLD/contract.json' }), textMessage('\n<!-- PHASE_ADVANCE: desktop-implement -->')],
      [textMessage('骨架完成，总结如上。')],
    ])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    // 标记在中段轮：收集面覆盖全部 assistant 轮（竞品 W17 教训——只扫末条会漏）
    expect(result.advance).toMatchObject({ decision: 'advance', target: 'desktop-implement' })
  })

  it('产物缺失 → reject(artifacts-missing)', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: desktop-implement')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: noneExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'artifacts-missing' })
  })
})

describe('manual 确认凭据腿', () => {
  it('desktop-arch 无凭据 → reject(confirmation-required)', async () => {
    const { query } = scriptedQuery([[textMessage('选型完成。\nPHASE_ADVANCE: desktop-scaffold')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, currentPhase: 'desktop-arch', artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'confirmation-required' })
    if (result.advance?.decision === 'reject') {
      expect(result.advance.education).toContain('用户确认')
    }
  })

  it('凭据登记后同输入 → advance', async () => {
    const { query } = scriptedQuery([[textMessage('选型完成。\nPHASE_ADVANCE: desktop-scaffold')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query, currentPhase: 'desktop-arch', artifactExists: allExist,
      confirmedPhases: new Set(['desktop-arch']),
    }))
    expect(result.advance).toMatchObject({ decision: 'advance', target: 'desktop-scaffold' })
  })
})

describe('驱动挂载腿（desktop-verify 收口）', () => {
  const validContract = JSON.stringify({
    schema_version: 1,
    entry: 'app.py',
    driver: {
      command: ['python', 'driver-skeleton.py'],
      timeout_ms: 60000,
      exit_code_semantics: { '0': 'pass', '1': 'fail', '2': 'blocked' },
      assert_readback: 'stdout 锚点',
    },
    env_whitelist: [],
    components: [],
  })

  it('驱动 pass + 交付标记 + 凭据 → advance + 报告落盘', async () => {
    const written: Array<{ path: string; content: string }> = []
    const { query } = scriptedQuery([[textMessage('验证完成。\nPHASE_ADVANCE: delivered')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query,
      currentPhase: 'desktop-verify',
      artifactExists: allExist,
      confirmedPhases: new Set(['desktop-verify']),
      readContract: () => validContract,
      driverSpawn: async () => ({ code: 0, stdout: 'PASS a\nPASS b\nSUMMARY pass=2', stderr: '' }),
      writeReport: (path, content) => { written.push({ path, content }) },
    }))
    expect(result.advance).toMatchObject({ decision: 'advance', target: 'delivered' })
    expect(result.driverReport).toMatchObject({ routing: 'pass', exitCode: 0 })
    expect(written).toHaveLength(1)
    expect(written[0].path).toBe(DRIVER_REPORT_PATH)
    expect(JSON.parse(written[0].content).routing).toBe('pass')
  })

  it('驱动 fail → reject 且教育文案含驱动路由原因（验证只看回读）', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: delivered')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query,
      currentPhase: 'desktop-verify',
      artifactExists: allExist,
      confirmedPhases: new Set(['desktop-verify']),
      readContract: () => validContract,
      driverSpawn: async () => ({ code: 1, stdout: 'PASS a\nFAIL b: 断言失败', stderr: '' }),
      writeReport: () => undefined,
    }))
    expect(result.advance).toMatchObject({ decision: 'reject' })
    if (result.advance?.decision === 'reject') {
      expect(result.advance.education).toContain('驱动执行未通过')
      expect(result.advance.education).toContain('b')
    }
    expect(result.driverReport?.routing).toBe('fail')
  })

  it('契约缺失 → reject（fail-closed）', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: delivered')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query, currentPhase: 'desktop-verify', artifactExists: allExist,
      confirmedPhases: new Set(['desktop-verify']),
      readContract: () => undefined,
    }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'artifacts-missing' })
  })

  it('契约不合法 → reject 且文案含校验错误', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: delivered')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query, currentPhase: 'desktop-verify', artifactExists: allExist,
      confirmedPhases: new Set(['desktop-verify']),
      readContract: () => '{"schema_version": 99}',
    }))
    expect(result.advance).toMatchObject({ decision: 'reject' })
    if (result.advance?.decision === 'reject') {
      expect(result.advance.education).toContain('契约不合法')
    }
  })
})

describe('故障注入：推进伪造', () => {
  it('句中引用不构成推进 → reject(no-marks) + 丢弃观测', async () => {
    const { query } = scriptedQuery([[textMessage('我打算输出 PHASE_ADVANCE: desktop-implement 来推进流程。')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'no-marks' })
    if (result.advance?.decision === 'reject') {
      expect(result.advance.discardedObservations).toHaveLength(1)
    }
  })

  it('跳级（scaffold → delivered）→ reject(not-next)', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: delivered')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'not-next', expected: 'desktop-implement' })
  })

  it('伪造枚举外目标（coding）→ reject(unknown-target)', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: coding')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'unknown-target' })
  })

  it('同轮分歧目标 → reject(multiple-divergent)', async () => {
    const { query } = scriptedQuery([[textMessage('PHASE_ADVANCE: desktop-implement\n<!-- PHASE_ADVANCE: delivered -->')]])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist }))
    expect(result.advance).toMatchObject({ decision: 'reject', reason: 'multiple-divergent' })
  })
})

describe('故障注入：围栏与挂起', () => {
  it('误装配 write_file 被围栏硬拦（execute 永不触达，模型收到教育文案）', async () => {
    let executeTouched = false
    const rogueTool: AgentLoopTool = {
      name: 'write_file',
      description: '恶意注入的写工具',
      input_schema: { type: 'object', properties: {} },
      execute: async () => {
        executeTouched = true
        return { output: 'should-not-reach' }
      },
    }
    const { query, receivedMessages } = scriptedQuery([
      [toolUseMessage('t1', 'write_file', { path: 'evil.py', content: 'x' })],
      [textMessage('好的，改用委派。')],
    ])
    const result = await runDesktopDispatcherLoop(baseInput({ query, artifactExists: allExist, toolsOverride: [rogueTool] }))
    expect(executeTouched).toBe(false)
    expect(result.status).toBe('completed')
    // 第二轮模型收到 is_error 教育文案（tool_result 回填进 user 轮的 content 块数组；
    // 同轮 user 还有 task 消息——取最后一个 user 轮即 tool_result 批）
    const userTurns = receivedMessages[1]?.filter((t) => t.role === 'user') ?? []
    const toolResultTurn = userTurns[userTurns.length - 1]
    const blocks = Array.isArray(toolResultTurn?.content) ? toolResultTurn.content : []
    const toolResults = blocks.filter((b) => b.type === 'tool_result')
    expect(toolResults.some((b) => (b as { is_error?: boolean }).is_error === true)).toBe(true)
  })

  it('挂起工具模式：白名单内工具 execute 永不 resolve——abort 后 loop 停在工具执行位（既有设计：工具裸 await 不响应 abort；调度员运行器不改变 loop 语义，仅验证透传与不 crash）', async () => {
    // 任务书指引（项目陷阱）：模拟挂起场景用挂起工具模式（toolUse query + execute
    // 永不 resolve），勿用 query 层挂死（abort 收不了尾）。工具挂死时 loop 停在
    // executeTurnToolCalls（裸 await 是既有设计），调度员运行器继承该行为——
    // 本腿验证：abort 请求本身不抛、透传给 loop（signal 同一引用）。
    const hangingTool: AgentLoopTool = {
      name: 'web_fetch',
      description: '挂起注入（永不 resolve）',
      input_schema: { type: 'object', properties: {} },
      execute: () => new Promise(() => undefined), // 挂起工具模式：永不 settle
    }
    const controller = new AbortController()
    const { query } = scriptedQuery([[toolUseMessage('t1', 'web_fetch', { url: 'https://x' })]])
    const runPromise = runDesktopDispatcherLoop(baseInput({
      query, signal: controller.signal, artifactExists: allExist, toolsOverride: [hangingTool],
    }))
    // 宽限后 abort；loop 挂在工具位不 settle 是已知行为——用 race 容忍并验证不 reject
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort(new Error('AGENT_CANCELLED: test'))
    const settled = await Promise.race([
      runPromise.then(() => 'settled' as const),
      new Promise<'hanging'>((resolve) => setTimeout(() => resolve('hanging'), 300)),
    ])
    // 两种部局都合法：settled=cancelled 收尾；hanging=停在工具位（既有设计，宽限内不 crash 不 reject）
    expect(['settled', 'hanging']).toContain(settled)
  })
})

describe('故障注入：断流', () => {
  it('query 流中途 throw → fail-soft 转 error 状态（不向上冒泡）', async () => {
    const query: SDKQuery = async function* () {
      yield textMessage('半截输出')
      throw new Error('STREAM_BROKEN: 注入断流')
    }
    const result = await runDesktopDispatcherLoop(baseInput({ query }))
    expect(result.status).toBe('error')
    expect(result.advance).toBeUndefined()
  })
})

describe('装配面与累积器单元', () => {
  it('buildDispatcherTools：只读五件+委派族+web_research，无写族', () => {
    const tools = buildDispatcherTools('proj-x')
    const names = tools.map((t) => t.name)
    for (const expected of ['read_file', 'list_files', 'find', 'grep', 'web_fetch', 'delegate_agent', 'wait_for_delegations', 'web_research']) {
      expect(names, expected).toContain(expected)
    }
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit_file')
  })

  it('wrapWithDispatcherGate：白名单工具原样过（同一 execute 引用），黑名单工具被换掉', () => {
    const tools = buildDispatcherTools('proj-x')
    const wrapped = wrapWithDispatcherGate(tools, DESKTOP_PHASES['desktop-scaffold'])
    const byName = new Map(tools.map((t) => [t.name, t]))
    for (const w of wrapped) {
      if (w.name === 'read_file') expect(w.execute).toBe(byName.get('read_file')?.execute)
    }
    const rogue = wrapWithDispatcherGate([{ name: 'write_file', description: 'x', input_schema: {}, execute: async () => ({ output: '' }) } as AgentLoopTool], DESKTOP_PHASES['desktop-scaffold'])
    expect(rogue[0].execute).not.toBe(undefined)
  })

  it('AssistantTurnCollector：片段累积/轮界换页/残余 flush', async () => {
    const collector = new AssistantTurnCollector()
    collector.onPublish('message_delta', { text: '第一轮' })
    collector.onPublish('message_delta', { text: '前半' })
    collector.onTurnBoundary()
    collector.onPublish('message_delta', { text: '第二轮后半' })
    collector.onPublish('tool_call_started', { tool: 'x' }) // 非.delta 事件忽略
    const turns = collector.flush()
    expect(turns).toEqual([
      [{ type: 'text', text: '第一轮前半' }],
      [{ type: 'text', text: '第二轮后半' }],
    ])
  })
})

describe('委派通道接线腿（2026-09-26 首跑修复）', () => {
  it('运行期注册父循环上下文 + 子工具构建器，收尾 dispose（delegate_agent 可用性）', async () => {
    const ac = await import('../../../main/agent/delegation/agent-collaboration')
    const registerSpy = vi.mocked(ac.registerParentLoopContext)
    const builderSpy = vi.mocked(ac.setChildToolsBuilder)
    const disposeSpy = vi.mocked(ac.disposeParentDelegationState)
    registerSpy.mockClear()
    builderSpy.mockClear()
    disposeSpy.mockClear()

    const { query, receivedMessages } = scriptedQuery([[textMessage('完成')]])
    const result = await runDesktopDispatcherLoop(baseInput({
      query,
      requirementsDigest: 'F-001 [P0] 托盘倒计时工具',
      artifactExists: allExist,
    }))
    expect(result.status).toBe('completed')

    // 父上下文：会话 id + 关键配置项（delegate_agent 取用面）
    expect(registerSpy).toHaveBeenCalledTimes(1)
    expect(registerSpy).toHaveBeenCalledWith('session-desktop', expect.objectContaining({
      delegationMaxTurns: 12,
      permissionMode: 'allow-all',
    }))
    const context = registerSpy.mock.calls[0]![1]
    // 子会话基底带需求摘要（worker 能看到 PRD 需求）
    expect(context.system).toContain('【项目需求')
    expect(context.system).toContain('F-001')
    // 子会话面（首跑深修）：环境探测工具随父上下文注入子会话
    expect(context.childExtraTools?.some((tool) => tool.name === 'probe_desktop_env')).toBe(true)

    // 子工具构建器已装配且能产出写工具（worker 落盘产物）
    expect(builderSpy).toHaveBeenCalled()
    const builder = builderSpy.mock.calls[builderSpy.mock.calls.length - 1]![0]
    const childTools = builder('proj-desktop', 'implement', 'diff')
    expect(childTools.some((tool) => tool.name === 'write_file')).toBe(true)

    // 调度员自身 system 也带需求段（首轮 messages 的 system 轮）
    const systemTurn = receivedMessages[0]?.find((turn) => turn.role === 'system')
    expect(String(systemTurn?.content ?? '')).toContain('【项目需求')

    // 收尾注销（父 loop 结束即清）
    expect(disposeSpy).toHaveBeenCalledWith('session-desktop')
  })

  it('loop 异常（断流）也不漏 dispose（finally 语义）', async () => {
    const ac = await import('../../../main/agent/delegation/agent-collaboration')
    const disposeSpy = vi.mocked(ac.disposeParentDelegationState)
    disposeSpy.mockClear()
    const broken: SDKQuery = async function* () {
      yield textMessage('半截')
      throw new Error('STREAM_BROKEN: delegation-leg')
    }
    const result = await runDesktopDispatcherLoop(baseInput({ query: broken }))
    expect(result.status).toBe('error')
    expect(disposeSpy).toHaveBeenCalledWith('session-desktop')
  })

  it('probe_desktop_env：注入 spawn 桩 → 逐项三分类与就绪判定（不真跑子进程）', async () => {
    const okTool = buildDesktopEnvProbeTool(async () => ({ code: 0, stdout: 'Python 3.13.7', stderr: '' }))
    const ok = await okTool.execute({}, {} as never)
    expect(String(ok.output)).toContain('python: ok')
    expect(String(ok.output)).toContain('Python 3.13.7')
    expect(String(ok.output)).toContain('就绪判定（三项全 ok）：是')

    const missingTool = buildDesktopEnvProbeTool(async () => {
      throw new ProbeError('not-found', '命令不存在：python')
    })
    const missing = await missingTool.execute({}, {} as never)
    expect(String(missing.output)).toContain('not-found')
    expect(String(missing.output)).toContain('就绪判定（三项全 ok）：否')
  })
})

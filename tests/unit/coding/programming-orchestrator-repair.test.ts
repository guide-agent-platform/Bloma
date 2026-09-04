import { restorePromaHome } from '../../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoopPostTesting, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, findProject, updateProject } from '../../../main/project-service'
import { recordSketchGenerated } from '../../../main/project-service'
import { syncDocuments } from '../../../main/document-engine'
import { createChannel } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/platform-services'
import { CircuitBreakSettledError } from '../../../main/recovery-service'
import { getAgentSessionPath } from '../../../storage/config-paths'
import type { AgentEvent } from '../../../shared/types'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'
import type { GwtTestResult } from '../../../main/gwt-service'

/**
 * P2 失败回流 · 入口 A（PR-B）：runAgentLoopPostTesting GWT 首败 → 定向修复轮 →
 * 全量重验 → 收敛走 judge 正常链 / 不收敛走现状熔断（陷阱 37 一字不改）。
 *
 * mock 面：runAgentLoop（修复轮窄 loop，脚本化 completed/cancelled/抛错）+
 * runGwtScenarios（两阶段：首验 failed / 重验 passed 或仍 failed）+
 * circuitBreakRollback（受控 rolled_back，记录入参做现状口径回归锁）。
 * writeTestReport / 决策日志 / learnings 真实落盘（临时 PROMA_HOME），断言裸关键词（陷阱 33）。
 */

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  runGwtScenarios: vi.fn(),
  circuitBreakRollback: vi.fn(),
}))

vi.mock('../../../main/coding/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/agent-loop')>()
  return { ...actual, runAgentLoop: mocks.runAgentLoop }
})

vi.mock('../../../main/gwt-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/gwt-service')>()
  return { ...actual, runGwtScenarios: mocks.runGwtScenarios }
})

vi.mock('../../../main/recovery-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/recovery-service')>()
  return { ...actual, circuitBreakRollback: mocks.circuitBreakRollback }
})

function gwtFailed(): GwtTestResult {
  return {
    total_count: 2,
    passed_count: 1,
    failed_count: 1,
    failure_summary: [
      { scenario: 'F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法', reason: '断言未通过——触发状态：capture-input 未命中；可见元素 12→12（无变化）' },
    ],
    unverified: ['F-009 图表区域应呈现月度分布'],
  }
}

function gwtPassed(): GwtTestResult {
  return { total_count: 2, passed_count: 2, failed_count: 0, failure_summary: [], unverified: ['F-009 图表区域应呈现月度分布'] }
}

function loopCompleted() {
  return {
    status: 'completed' as const,
    turns: 3,
    finalText: '已修复搜索过滤逻辑',
    toolCalls: [{ name: 'edit_file', turn: 1 }],
  }
}

/** 语义审查腿 query：抛错（LLM 失败）→ semantic skipped 不阻断（既有降级口径）。 */
function junkQuery(): SDKQuery {
  return async function* (_prompt: string, _options: SDKQueryOptions) {
    throw new Error('LLM_FAILED (repair test junk query)')
  }
}

describe('runAgentLoopPostTesting × 修复轮（P2 失败回流入口 A）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const originalBudget = process.env.BLOMA_REPAIR_BUDGET
  let events: AgentEvent[] = []
  let projectId = ''
  let sessionId = ''
  let channelId = ''

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-repair-'))
    delete process.env.BLOMA_REPAIR_BUDGET
    events = []
    mocks.runAgentLoop.mockReset()
    mocks.runGwtScenarios.mockReset()
    mocks.circuitBreakRollback.mockReset()
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
    setProgrammingEventPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 4321,
      healthCheck: async () => true,
      processFactory: () => ({ stdout: { on: () => undefined }, stderr: { on: () => undefined }, once: () => undefined, kill: () => true }) as unknown as ChildProcess,
    })
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    const project = createProject({ request_id: 'req-repair', mode: 'quick' })
    projectId = project.project_id
    sessionId = `s-repair-${Math.random().toString(36).slice(2, 8)}`
    updateProject(projectId, { via_agent_loop: true, agent_loop_status: 'completed' })
    recordSketchGenerated(projectId, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-repair', session_id: sessionId, project_id: projectId, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const channel = createChannel({
      name: 'repair-test',
      provider_type: 'anthropic',
      base_url: 'https://test.invalid',
      api_key: 'test-key',
      models: [{ id: 'm1', name: 'test-model', enabled: true, supports_tools: true }],
    })
    channelId = channel.id
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    if (originalBudget === undefined) delete process.env.BLOMA_REPAIR_BUDGET
    else process.env.BLOMA_REPAIR_BUDGET = originalBudget
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
  })

  function decisionLines(): string {
    const path = getAgentSessionPath(sessionId)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  function baseInput() {
    return {
      request_id: 'req-repair',
      session_id: sessionId,
      project_id: projectId,
      mode: 'quick' as const,
      preview_url: 'http://127.0.0.1:4321',
      loop: { status: 'completed' as const, turns: 5, finalText: '', toolCalls: [] },
      query: junkQuery(),
      channel_id: channelId,
    }
  }

  it('首败 → 修复轮 → 全量重验通过 → 走 judge 正常链收敛 ready，计数清零', async () => {
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed()) // 首验
      .mockResolvedValueOnce(gwtPassed()) // 修复后全量重验
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    const result = await runAgentLoopPostTesting(baseInput())

    // 修复轮真实起跑：runAgentLoop 被调一次（system 含修复模式段、task 是修复卡）
    expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1)
    const loopInput = mocks.runAgentLoop.mock.calls[0][0] as { system: string; task: string; maxTurns: number }
    expect(loopInput.system).toContain('修复模式')
    expect(loopInput.task).toContain('## 修复任务')
    expect(loopInput.task).toContain('F-005')
    expect(loopInput.maxTurns).toBe(12) // quick 修复轮缺省
    // 两阶段 GWT：首验 + 全量重验（D2，非子集）
    expect(mocks.runGwtScenarios).toHaveBeenCalledTimes(2)
    // 收敛 → 正常链：无熔断、无让渡卡，走到 judge 且 verdict ready
    expect(mocks.circuitBreakRollback).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
    expect(result.verdict).toBe('ready')
    expect(findProject(projectId).current_stage).toBe('ready')
    // 成功清零（与旧管道 attempt 口径对齐）
    expect(findProject(projectId).test_repair_count).toBe(0)
    // 决策日志（裸关键词，陷阱 33）：started + converged completed
    const log = decisionLines()
    expect(log).toContain('repair_round_started')
    expect(log).toContain('repair_round_completed')
  })

  it('修复后仍失败 → 现状熔断口径一字不改：circuitBreakRollback 参数一致 + 让渡 blocked', async () => {
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed()) // 首验与重验都失败
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    const result = await runAgentLoopPostTesting(baseInput())

    expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1)
    // 陷阱 37 回归锁：熔断入参与现状完全一致（reason 文案 / 三元组 / publish 通道）
    expect(mocks.circuitBreakRollback).toHaveBeenCalledTimes(1)
    const args = mocks.circuitBreakRollback.mock.calls[0][0] as Record<string, unknown>
    expect(args.project_id).toBe(projectId)
    expect(args.request_id).toBe('req-repair')
    expect(args.session_id).toBe(sessionId)
    expect(args.reason).toBe('终验未通过（Agent Loop 路径，loop 内修复预算已用尽）')
    expect(typeof args.publish).toBe('function')
    // 无健康快照走向：让渡 blocked（现状口径）
    expect(result.verdict).toBe('blocked')
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
    expect(findProject(projectId).blocked_action).toBe('test_repair')
    // 让渡卡带上重验后的最新失败清单（现状 failureTitle 逻辑）
    const card = events.find((event) => event.type === 'user_decision_required')
    expect(card?.payload.title).toContain('F-005')
    // 修复轮消耗计数：1（未收敛不清零）
    expect(findProject(projectId).test_repair_count).toBe(1)
  })

  it('修复后仍失败且熔断回滚成功 → throw CircuitBreakSettledError（现状口径另一半）', async () => {
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: true, outcome: 'rolled_back' })

    await expect(runAgentLoopPostTesting(baseInput())).rejects.toThrow(CircuitBreakSettledError)
    // 回滚路径不发让渡卡（现状口径）
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
  })

  it('预算耗尽（quick 上限 1 已用）→ 不起修复轮，落 repair_budget_exhausted，直接现状熔断', async () => {
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())

    const result = await runAgentLoopPostTesting(baseInput())

    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.runGwtScenarios).toHaveBeenCalledTimes(1)
    expect(mocks.circuitBreakRollback).toHaveBeenCalledTimes(1)
    expect(result.verdict).toBe('blocked')
    expect(decisionLines()).toContain('repair_budget_exhausted')
    expect(decisionLines()).not.toContain('repair_round_started')
  })

  it('longterm 预算缺省 2：已用 1 仍起修复轮；已用 2 不起', async () => {
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed())
      .mockResolvedValueOnce(gwtPassed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    const result = await runAgentLoopPostTesting({ ...baseInput(), mode: 'longterm' })
    expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1)
    expect(result.verdict).toBe('ready')

    // 第二段：已用 2 → 预算耗尽不起修复轮
    mocks.runAgentLoop.mockClear()
    mocks.runGwtScenarios.mockReset()
    updateProject(projectId, { test_repair_count: 2 })
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())
    await runAgentLoopPostTesting({ ...baseInput(), mode: 'longterm' })
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
  })

  it('BLOMA_REPAIR_BUDGET 覆盖生效：quick 已用 1，上限提为 2 → 仍起修复轮', async () => {
    process.env.BLOMA_REPAIR_BUDGET = '2'
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed())
      .mockResolvedValueOnce(gwtPassed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    const result = await runAgentLoopPostTesting(baseInput())
    expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1)
    expect(result.verdict).toBe('ready')
  })

  it('signal 已 abort → 不起修复轮、不发卡、不落收尾决策（陷阱 42）', async () => {
    const controller = new AbortController()
    controller.abort()
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())

    await expect(runAgentLoopPostTesting({ ...baseInput(), signal: controller.signal })).rejects.toThrow('AGENT_CANCELLED')
    // post-testing 入口即取消：无修复轮、无熔断、无让渡卡、无任何 repair 决策
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.circuitBreakRollback).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
    expect(decisionLines()).not.toContain('repair_round')
  })

  it('修复轮 cancelled（loop 返回 cancelled）→ throw AGENT_CANCELLED，不发卡不落收尾决策（U5/陷阱 42）', async () => {
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())
    mocks.runAgentLoop.mockResolvedValue({ status: 'cancelled', turns: 2, finalText: '', toolCalls: [] })

    await expect(runAgentLoopPostTesting(baseInput())).rejects.toThrow('AGENT_CANCELLED')
    expect(mocks.circuitBreakRollback).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'user_decision_required')).toBe(false)
    // started 已落（事实），但无 completed/exhausted 收尾决策、无让渡
    const log = decisionLines()
    expect(log).toContain('repair_round_started')
    expect(log).not.toContain('repair_round_completed')
    expect(log).not.toContain('repair_budget_exhausted')
  })

  it('修复轮 loop 抛错 → 不阻断交付链，按现状熔断收口（fail-open）', async () => {
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())
    mocks.runAgentLoop.mockRejectedValue(new Error('LLM_TIMEOUT'))

    const result = await runAgentLoopPostTesting(baseInput())
    expect(result.verdict).toBe('blocked')
    expect(mocks.circuitBreakRollback).toHaveBeenCalledTimes(1)
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
  })

  it('无 query（存量 resume 场景）→ 不起修复轮，静默走现状熔断', async () => {
    mocks.runGwtScenarios.mockResolvedValueOnce(gwtFailed())
    const { query: _omit, ...withoutQuery } = baseInput()

    const result = await runAgentLoopPostTesting(withoutQuery)
    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(result.verdict).toBe('blocked')
    expect(decisionLines()).not.toContain('repair_round_started')
  })

  it('修复轮启动旁白如实告知（走既有 assistant 文案流，零新组件）', async () => {
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed())
      .mockResolvedValueOnce(gwtPassed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    await runAgentLoopPostTesting(baseInput())
    const delta = events.find((event) => event.type === 'message_delta' && typeof event.payload.text === 'string' && (event.payload.text as string).includes('定向修复'))
    expect(delta).toBeTruthy()
    expect((delta?.payload.text as string)).toContain('1/1')
  })
})

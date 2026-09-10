import { restorePromaHome } from '../../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoopPostTesting, resumeBlockedFlow, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, findProject, updateProject } from '../../../main/project-service'
import { recordSketchGenerated } from '../../../main/project-service'
import { syncDocuments, readLoopCheckpointDocument, writeLoopCheckpointDocument } from '../../../main/document-engine'
import { createChannel } from '../../../main/channel-manager'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/platform-services'
import { CircuitBreakSettledError } from '../../../main/recovery-service'
import { getAgentSessionPath } from '../../../storage/config-paths'
import { writeTestReport } from '../../../main/gwt-service'
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
  runBuildGate: vi.fn(),
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

vi.mock('../../../main/coding/build-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/build-gate')>()
  return { ...actual, runBuildGate: mocks.runBuildGate }
})

// L0/L1 门禁（2026-09-07）：本文件测 P2 回流编排本身，门禁真实行为由
// artifact-ui-gate/gwt-ui-gate-merge/vision-audit-gate 三个专项单测覆盖；
// 此处 mock 成通过态（fixture 预览页无真控件，真跑 L0 会合法判败改变流程）。
vi.mock('../../../main/coding/artifact-ui-gate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/coding/artifact-ui-gate')>()
  return { ...actual, uiGateEnabled: vi.fn(() => true), runArtifactUiGate: vi.fn(async () => ({ status: 'passed', failures: [] })) }
})
vi.mock('../../../main/coding/vision-audit-gate', () => ({
  runVisionAuditGate: vi.fn(async () => ({ status: 'skipped', digest: '测试态：视觉审计跳过' })),
}))

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
    delete process.env.BLOMA_LOOP_CHECKPOINT
    events = []
    mocks.runAgentLoop.mockReset()
    mocks.runGwtScenarios.mockReset()
    mocks.circuitBreakRollback.mockReset()
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
    mocks.runBuildGate.mockReset()
    mocks.runBuildGate.mockResolvedValue({ status: 'skipped', durationMs: 1 })
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
    delete process.env.BLOMA_LOOP_CHECKPOINT
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
  })

  function decisionLines(): string {
    const path = getAgentSessionPath(sessionId)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  function readAnalyticsEvents(): Array<Record<string, unknown>> {
    const wsRoot = join(process.env.PROMA_HOME!, 'agent-workspaces')
    const out: Array<Record<string, unknown>> = []
    for (const slug of readdirSync(wsRoot)) {
      const f = join(wsRoot, slug, 'analytics.jsonl')
      if (!existsSync(f)) continue
      for (const l of readFileSync(f, 'utf8').split('\n').filter(Boolean)) {
        try { out.push(JSON.parse(l)) } catch { /* 跳过坏行 */ }
      }
    }
    return out
  }

  function testCompletedEvents() {
    return readAnalyticsEvents().filter((e) => e.event_type === 'test_completed') as Array<{
      payload: { round?: string; total_count?: number; passed_count?: number; failed_count?: number; via?: string; failures?: Array<{ scenario?: string; reason?: string; source?: string }>; comparison?: { baseline?: string; resolved?: string[]; persistent?: string[]; new_failures?: string[] } }
    }>
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
    // 就绪引导卡（2026-09-06「终点不是 MVP」）：ready 收敛发 next_steps 卡（非让渡卡）
    const decisionEvents = events.filter((event) => event.type === 'user_decision_required')
    expect(decisionEvents.every((event) => (event.payload as { kind?: string }).kind === 'ready_next_steps')).toBe(true)
    expect(result.verdict).toBe('ready')
    expect(findProject(projectId).current_stage).toBe('ready')
    // 成功清零（与旧管道 attempt 口径对齐）
    expect(findProject(projectId).test_repair_count).toBe(0)
    // 决策日志（裸关键词，陷阱 33）：started + converged completed
    const log = decisionLines()
    expect(log).toContain('repair_round_started')
    expect(log).toContain('repair_round_completed')
    // test_completed 结构化证据（2026-09-09）：首验 initial + 重验 after_repair 各一条
    const testEvents = testCompletedEvents()
    expect(testEvents).toHaveLength(2)
    expect(testEvents[0].payload.round).toBe('initial')
    expect(testEvents[0].payload.failed_count).toBe(1)
    expect(testEvents[0].payload.via).toBe('agent_loop_post_testing')
    // B0 深挖补强（2026-09-09）：failures 带 reason（熔断回滚清 test-report 后唯一可回溯源）
    expect(testEvents[0].payload.failures?.[0]).toMatchObject({ scenario: expect.any(String), reason: expect.any(String) })
    expect(testEvents[1].payload.round).toBe('after_repair')
    expect(testEvents[1].payload.failed_count).toBe(0)
    expect(testEvents[1].payload.total_count).toBe(2)
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
    // Phase 7 U1 H4：熔断 failureNote 升级四段式（功能→现象→影响→替代；无开关直接上）
    const cbArgs = mocks.circuitBreakRollback.mock.calls[0][0] as { failureNote?: string }
    expect(cbArgs.failureNote).toContain('【功能】')
    expect(cbArgs.failureNote).toContain('【现象】')
    expect(cbArgs.failureNote).toContain('【影响】')
    expect(cbArgs.failureNote).toContain('【替代】')
    expect(cbArgs.failureNote).toContain('F-005')
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

  it('W2-D3：终验失败 source 分类——loop 自测已知未修 → known_failure；从未自测 → coverage_gap', async () => {
    const scenario = gwtFailed().failure_summary[0]!.scenario
    // 场景一：loop 自测过且上次就挂该场景 → known_failure（B0 错误放行口径）
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed()) // 首验与重验都挂
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    await runAgentLoopPostTesting({
      ...baseInput(),
      loop: {
        status: 'completed',
        turns: 8,
        finalText: '',
        toolCalls: [],
        validation: {
          gwt_runs: 2,
          api_contract_runs: 0,
          last_gwt_failures: [scenario],
          gwt_all_passed: false,
          api_all_passed: true,
          security_all_passed: false,
          file_revisions: {},
        },
      },
    })
    let events = testCompletedEvents()
    expect(events[0].payload.failures?.[0]).toMatchObject({ scenario, source: 'known_failure' })
    expect(events[0].payload.comparison).toMatchObject({
      baseline: 'loop_last_run',
      persistent: [scenario],
      resolved: [],
      new_failures: [],
    })
    // after_repair 仍挂 → 基线切上轮终验，persistent 口径一致
    expect(events[1].payload.comparison).toMatchObject({ baseline: 'prev_round', persistent: [scenario] })
    expect(events[1].payload.failures?.[0]).toMatchObject({ source: 'known_failure' })

    // 场景二（新会话状态重置）：loop 从未自测 → coverage_gap
    mocks.runGwtScenarios.mockReset().mockResolvedValue(gwtFailed())
    mocks.runAgentLoop.mockReset().mockResolvedValue(loopCompleted())
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
    await runAgentLoopPostTesting({
      ...baseInput(),
      loop: {
        status: 'completed',
        turns: 8,
        finalText: '',
        toolCalls: [],
        validation: {
          gwt_runs: 0,
          api_contract_runs: 0,
          last_gwt_failures: [],
          gwt_all_passed: false,
          api_all_passed: true,
          security_all_passed: false,
          file_revisions: {},
        },
      },
    })
    events = testCompletedEvents()
    // analytics append-only：两场景同测试内累积，取最后一条 initial（场景二）
    const initial = events.filter((e) => e.payload.round === 'initial').at(-1)!
    expect(initial.payload.failures?.[0]).toMatchObject({ source: 'coverage_gap' })
  })

  it('Phase 7 U1 H1：BLOMA_DELIVERY_STATUS on → 熔断让渡路径如实落 partial（F-005 败、F-001 P0 干净）；off 零写入', async () => {
    // 开关 off（缺省）：字节级现状——project 无 delivery_status 键
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed()) // 首验与重验都失败
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    await runAgentLoopPostTesting(baseInput())
    expect(findProject(projectId).delivery_status).toBeUndefined()

    // 开关 on：同一失败形态 → P0=F-001（主题锚点）无关联失败 → partial（有独立可用任务）
    vi.stubEnv('BLOMA_DELIVERY_STATUS', '1')
    try {
      await runAgentLoopPostTesting(baseInput())
      expect(findProject(projectId).delivery_status).toBe('partial')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('W2-F1：BLOMA_LOOP_CHECKPOINT on → 修复尝试入账本 + 修复卡带证据包（候选指纹+此前尝试）', async () => {
    process.env.BLOMA_LOOP_CHECKPOINT = '1'
    process.env.BLOMA_REPAIR_BUDGET = '2'
    // 预置第 1 轮尝试记录 + 已用 1 轮 → 本轮 round=2，修复卡应含历史
    const scenario = gwtFailed().failure_summary[0]!.scenario
    writeLoopCheckpointDocument(projectId, {
      version: 1,
      project_id: projectId,
      updated_at: new Date().toISOString(),
      runtime: {
        session_id: sessionId,
        at_turn: 20,
        trigger: 'final',
        decisions: [],
        progress_files: { 'src/app.js': 'aaa-100' },
        validation: {
          gwt_runs: 1,
          api_contract_runs: 0,
          last_gwt_failures: [scenario],
          gwt_all_passed: false,
          api_all_passed: true,
          security_all_passed: false,
          file_revisions: { 'src/app.js': 'aaa-100' },
          candidate_fingerprint: 'fp-aaaa-1',
        },
      },
      repair_attempts: [
        {
          round: 1,
          at: new Date().toISOString(),
          task_locations: [scenario],
          files_touched: ['src/app.js'],
          outcome: { resolved: [], persistent: [scenario], new_failures: [], converged: false },
        },
      ],
    })
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed()) // 首验与重验都失败
    mocks.runAgentLoop.mockResolvedValue({ ...loopCompleted(), toolCalls: [{ name: 'edit_file', turn: 1, path: 'src/app.js' }] })

    await runAgentLoopPostTesting(baseInput())

    // 修复卡带证据包：候选指纹 + 此前尝试（勿重复同样补丁）
    const loopInput = mocks.runAgentLoop.mock.calls[0][0] as { task: string; onCheckpoint?: unknown }
    expect(loopInput.task).toContain('修复证据包')
    expect(loopInput.task).toContain('fp-aaaa-1')
    expect(loopInput.task).toContain('第1轮 改 src/app.js')
    expect(loopInput.task).toContain('持续 1')
    // 修复轮 onCheckpoint 已接线（检查点投影持久化）
    expect(typeof loopInput.onCheckpoint).toBe('function')
    // 账本：追加了本轮（round=2）尝试，files_touched 来自修复 loop 工具调用 path
    const doc = readLoopCheckpointDocument(projectId)
    expect(doc?.repair_attempts).toHaveLength(2)
    expect(doc?.repair_attempts[1]).toMatchObject({ round: 2, files_touched: ['src/app.js'] })
    expect(doc?.repair_attempts[1]?.outcome.persistent).toEqual([scenario])
  })

})
describe('PR-C：build-gate 接入 + blocked 卡先修再验（入口 B）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let events: AgentEvent[] = []
  let projectId = ''
  let sessionId = ''
  let channelId = ''

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-repair-c-'))
    events = []
    mocks.runAgentLoop.mockReset()
    mocks.runGwtScenarios.mockReset()
    mocks.circuitBreakRollback.mockReset()
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
    mocks.runBuildGate.mockReset()
    setProgrammingEventPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 4322,
      healthCheck: async () => true,
      processFactory: () => ({ stdout: { on: () => undefined }, stderr: { on: () => undefined }, once: () => undefined, kill: () => true }) as unknown as ChildProcess,
    })
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    const project = createProject({ request_id: 'req-repair-c', mode: 'quick' })
    projectId = project.project_id
    sessionId = `s-repairc-${Math.random().toString(36).slice(2, 8)}`
    updateProject(projectId, { via_agent_loop: true, agent_loop_status: 'completed', blocked_action: 'test_repair' })
    recordSketchGenerated(projectId, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-repair-c', session_id: sessionId, project_id: projectId, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const channel = createChannel({
      name: 'repair-c-test',
      provider_type: 'anthropic',
      base_url: 'https://test.invalid',
      api_key: 'test-key',
      models: [{ id: 'm1', name: 'test-model', enabled: true, supports_tools: true }],
    })
    channelId = channel.id
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
  })

  function decisionLines(): string {
    const path = getAgentSessionPath(sessionId)
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  }

  it('buildGate failed → 修复卡追加 build 任务（GWT + build 混合），修复后重跑构建门禁留痕', async () => {
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed())
      .mockResolvedValueOnce(gwtPassed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    // 修复后 buildGate 重验：passed（PR-2b 清偿：构建失败 → 修复轮尝试修一次 → 重验留痕）
    mocks.runBuildGate.mockResolvedValue({ status: 'passed', outfile: 'dist/app.js', durationMs: 5 })

    const result = await runAgentLoopPostTesting({
      request_id: 'req-repair-c',
      session_id: sessionId,
      project_id: projectId,
      mode: 'quick',
      preview_url: 'http://127.0.0.1:4322',
      loop: { status: 'completed', turns: 5, finalText: '', toolCalls: [] },
      query: junkQuery(),
      channel_id: channelId,
      buildGate: { status: 'failed', detail: 'Could not resolve "./utils/format" (src/app.js:41)', durationMs: 3 },
    })

    expect(result.verdict).toBe('ready')
    // 修复卡 = GWT 任务 + build 任务（共 2 项）
    const loopInput = mocks.runAgentLoop.mock.calls[0][0] as { task: string }
    expect(loopInput.task).toContain('共 2 项')
    expect(loopInput.task).toContain('构建失败')
    expect(loopInput.task).toContain('Could not resolve')
    // 修复轮结束后重跑构建门禁验证（结果只留痕，不影响 GWT 收敛判定）
    expect(mocks.runBuildGate).toHaveBeenCalledTimes(1)
    const log = decisionLines()
    expect(log).toContain('repair_round_completed')
    expect(log).toContain('build_gate_after')
    expect(log).toContain('passed')
  })

  it('buildGate passed → 修复卡无 build 任务，不重跑构建门禁', async () => {
    mocks.runGwtScenarios
      .mockResolvedValueOnce(gwtFailed())
      .mockResolvedValueOnce(gwtPassed())
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())

    await runAgentLoopPostTesting({
      request_id: 'req-repair-c',
      session_id: sessionId,
      project_id: projectId,
      mode: 'quick',
      preview_url: 'http://127.0.0.1:4322',
      loop: { status: 'completed', turns: 5, finalText: '', toolCalls: [] },
      query: junkQuery(),
      channel_id: channelId,
      buildGate: { status: 'passed', outfile: 'dist/app.js', durationMs: 3 },
    })

    const loopInput = mocks.runAgentLoop.mock.calls[0][0] as { task: string }
    expect(loopInput.task).toContain('共 1 项')
    expect(loopInput.task).not.toContain('构建失败')
    expect(mocks.runBuildGate).not.toHaveBeenCalled()
  })

  it("blocked 卡「继续修」：先修再验（先消费 test-report 失败快照起修复轮，再走终验）", async () => {
    // 铺上次让渡时的失败快照（test-report.json）
    writeTestReport({ request_id: 'req-repair-c', session_id: sessionId, project_id: projectId, result: gwtFailed() })
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    // 终验：修复后产物全过（终验里入口 A 预算已耗尽不再修，直接走 judge）
    mocks.runGwtScenarios.mockResolvedValue(gwtPassed())

    await resumeBlockedFlow(
      {
        request_id: 'req-repair-c', session_id: sessionId, project_id: projectId,
        mode: 'quick', decision: 'continue', content: '',
        query: junkQuery(),
        channel_id: channelId,
      },
      () => undefined,
    )

    // 先修：修复卡来自 test-report.json 失败快照（含 F-005 场景）
    expect(mocks.runAgentLoop).toHaveBeenCalledTimes(1)
    const loopInput = mocks.runAgentLoop.mock.calls[0][0] as { task: string }
    expect(loopInput.task).toContain('F-005')
    // 再验：终验跑全量 GWT → 收敛
    expect(mocks.runGwtScenarios).toHaveBeenCalled()
    const log = decisionLines()
    expect(log).toContain('repair_round_started')
    expect(log).toContain('blocked_resume')
    expect(findProject(projectId).current_stage).toBe('ready')
  })

  it('blocked 卡「继续修」：无失败快照（test-report 缺失）→ 行为=现状直接终验，不起修复轮', async () => {
    mocks.runGwtScenarios.mockResolvedValue(gwtPassed())

    await resumeBlockedFlow(
      {
        request_id: 'req-repair-c', session_id: sessionId, project_id: projectId,
        mode: 'quick', decision: 'continue', content: '',
        query: junkQuery(),
        channel_id: channelId,
      },
      () => undefined,
    )

    expect(mocks.runAgentLoop).not.toHaveBeenCalled()
    expect(mocks.runGwtScenarios).toHaveBeenCalled()
    expect(findProject(projectId).current_stage).toBe('ready')
  })
})

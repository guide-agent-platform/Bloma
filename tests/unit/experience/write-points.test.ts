import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GwtTestResult } from '../../../main/gwt-service'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestrator'
import { runJudgeReview, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, updateProject, recordSketchGenerated, findProject } from '../../../main/project-service'
import { syncDocuments } from '../../../main/document-engine'
import { setSafeStorageAdapter } from '../../../main/safe-storage'
import { createChannel } from '../../../main/channel-manager'
import { setSandboxRuntimeForTests, clearSandboxRuntimeForTests } from '../../../main/platform-services'

/**
 * T-1 写点集成测试（用户计划 §3.1.2 变异要求的落点）：
 * - 写点①（入口 A 修复预算耗尽熔断）：runAgentLoopPostTesting 预算已尽 + GWT 有失败
 *   → registerCandidateCard spy 收到 coding/gwt/* 与 unknown/outcome/unexpected_exit；
 * - 写点②（裁判退回）：runJudgeReview 退回流 → spy 收到 coding/judge/*；
 * - 负断言：GWT 全过路径不产 gwt/outcome 卡（正常成功零写卡）；
 * - 源码锚：编排器内 recordFailureCards( 恰好 4 处——删除任一写点此断言必红（变异门）。
 * mock 面复制 tests/unit/coding/programming-orchestrator-repair.test.ts 的成熟 harness。
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
vi.mock('../../../main/experience/experience-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/experience/experience-service')>()
  return { ...actual, registerCandidateCard: vi.fn(async (card: unknown) => card) }
})

import { registerCandidateCard } from '../../../main/experience/experience-service'
import { runAgentLoopPostTesting } from '../../../main/coding/programming-orchestrator'

function gwtFailed(): GwtTestResult {
  return {
    total_count: 2,
    passed_count: 1,
    failed_count: 1,
    failure_summary: [
      { scenario: 'F-005 当在搜索框输入关键词时，历史列表应显示匹配的想法', reason: '断言未通过——触发状态：capture-input 未命中' },
    ],
  }
}
function gwtPassed(): GwtTestResult {
  return { total_count: 2, passed_count: 2, failed_count: 0, failure_summary: [] }
}
function loopCompleted() {
  return { status: 'completed', turns: 2, finalText: '修好了', toolCalls: [] }
}
function junkQuery(): SDKQuery {
  return async function* (_p: string, _o: SDKQueryOptions) {
    throw new Error('LLM_FAILED (write-point test)')
  }
}

function spyTags(): string[] {
  return vi.mocked(registerCandidateCard).mock.calls.map((call) => (call[0] as { tag: string }).tag)
}

describe('T-1 写点集成（账本门面 spy 断言）', () => {
  const originalHome = process.env.PROMA_HOME
  let projectId = ''
  let sessionId = ''
  let channelId = ''

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-wp-'))
    vi.mocked(registerCandidateCard).mockClear()
    mocks.runAgentLoop.mockReset()
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    mocks.runGwtScenarios.mockReset()
    mocks.circuitBreakRollback.mockReset()
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
    mocks.runBuildGate.mockReset()
    mocks.runBuildGate.mockResolvedValue({ status: 'skipped', durationMs: 1 })
    setProgrammingEventPublisher(() => undefined)
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    setSandboxRuntimeForTests({
      portAllocator: async () => 4321,
      healthCheck: async () => true,
      processFactory: () =>
        ({ stdout: { on: () => undefined }, stderr: { on: () => undefined }, once: () => undefined, kill: () => true }) as unknown as ChildProcess,
    })
    const project = createProject({ request_id: 'req-wp', mode: 'quick' })
    projectId = project.project_id
    sessionId = `s-wp-${Math.random().toString(36).slice(2, 8)}`
    updateProject(projectId, { via_agent_loop: true, agent_loop_status: 'completed' })
    recordSketchGenerated(projectId, [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-005', description: '当在搜索框输入关键词时，历史列表应显示匹配的想法' },
    ])
    syncDocuments({ request_id: 'req-wp', session_id: sessionId, project_id: projectId, checkpoint: 'mvp_before_generation' })
    const root = findProject(projectId).root_path
    writeFileSync(join(root, 'index.html'), '<html><body><p>记录收入与支出</p></body></html>', 'utf8')
    const channel = createChannel({
      name: 'wp-test',
      provider_type: 'anthropic',
      base_url: 'https://test.invalid',
      api_key: 'test-key',
      models: [{ id: 'm1', name: 'test-model', enabled: true, supports_tools: true }],
    })
    channelId = channel.id
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalHome
    clearSandboxRuntimeForTests()
  })

  function baseInput() {
    return {
      request_id: 'req-wp',
      session_id: sessionId,
      project_id: projectId,
      mode: 'quick' as const,
      preview_url: 'http://127.0.0.1:4321',
      loop: { status: 'completed' as const, turns: 5, finalText: '', toolCalls: [] },
      query: junkQuery(),
      channel_id: channelId,
    }
  }

  it('写点①：修复预算耗尽熔断 → GWT 场景卡 + unexpected_exit 结局卡成对落账本', async () => {
    updateProject(projectId, { test_repair_count: 1 }) // quick 预算缺省 1，已耗尽
    mocks.runGwtScenarios.mockResolvedValue(gwtFailed())
    await runAgentLoopPostTesting(baseInput())
    await new Promise((r) => setImmediate(r))
    const tags = spyTags()
    expect(tags.some((t) => t.startsWith('coding/gwt/'))).toBe(true)
    expect(tags).toContain('unknown/outcome/unexpected_exit')
  })

  it('负断言：GWT 全过的健康路径不产 gwt/outcome 卡', async () => {
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios.mockResolvedValue(gwtPassed())
    await runAgentLoopPostTesting(baseInput())
    await new Promise((r) => setImmediate(r))
    const tags = spyTags()
    expect(tags.some((t) => t.startsWith('coding/gwt/') || t.startsWith('unknown/outcome/'))).toBe(false)
  })

  it('写点②：裁判退回流每轮退回产 coding/judge/* 卡', async () => {
    // 另建新最小项目（无背板→硬约束①必败）：复刻 judge-review.test.ts 的确定性退回场景
    const p2 = createProject({ request_id: 'req-wp2', mode: 'quick' })
    const result = await runJudgeReview({ request_id: 'req-wp2', session_id: sessionId, project_id: p2.project_id })
    await new Promise((r) => setImmediate(r))
    expect(result.verdict.verdict).toBe('return')
    expect(spyTags().some((t) => t.startsWith('coding/judge/'))).toBe(true)
  })

  it('源码锚：编排器 recordFailureCards( 恰好 4 处（删写点必红=变异门）', () => {
    const source = readFileSync(join(process.cwd(), 'main/coding/programming-orchestrator.ts'), 'utf8')
    expect((source.match(/recordFailureCards\(/g) ?? []).length).toBe(4)
  })
})

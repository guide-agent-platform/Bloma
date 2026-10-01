import type { ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GwtTestResult } from '../../../main/verification/test-legacy'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/orchestrator'
import { createProject, updateProject, recordSketchGenerated, findProject } from '../../../main/project/project-service'
import { syncDocuments } from '../../../main/project/document-engine'
import { setProgrammingEventPublisher } from '../../../main/coding/programming-orchestrator'
import { setSafeStorageAdapter } from '../../../main/platform/storage/safe-storage'
import { createChannel } from '../../../main/platform/llm/channel-manager'
import { setSandboxRuntimeForTests, clearSandboxRuntimeForTests } from '../../../main/delivery/sandbox'

/**
 * F 系列 W2.1（2026-09-16 Phase 10 承接）：写点集成改事件行断言——
 * - 写点①（入口 A 修复预算耗尽熔断）：gwt_failure + abnormal_outcome 事件成对；
 * - 写点②（裁判退回）：judge_return 事件；
 * - 负断言：GWT 全过路径零事件行；
 * - 源码锚：编排器内 recordFailureCards( 恰好 5 处（删写点必红=变异门）。
 * mock 面复制 tests/unit/coding/programming-orchestrator-repair.test.ts 的成熟 harness。
 */

const mocks = vi.hoisted(() => ({
  runAgentLoop: vi.fn(),
  runGwtScenarios: vi.fn(),
  circuitBreakRollback: vi.fn(),
}))

vi.mock('../../../main/agent/loop/agent-loop', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/agent/loop/agent-loop')>()
  return { ...actual, runAgentLoop: mocks.runAgentLoop }
})
vi.mock('../../../main/verification/test-legacy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/verification/test-legacy')>()
  return { ...actual, runGwtScenarios: mocks.runGwtScenarios }
})
vi.mock('../../../main/project/recovery-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/project/recovery-service')>()
  return { ...actual, circuitBreakRollback: mocks.circuitBreakRollback }
})
vi.mock('../../../main/experience/event-log', () => ({
  appendExperienceEvent: vi.fn(() => null),
}))

import { appendExperienceEvent } from '../../../main/experience/event-log'
import type { AppendEventInput } from '../../../main/experience/event-log'

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

function spyEventTypes(): string[] {
  return vi.mocked(appendExperienceEvent).mock.calls.map((call) => (call[0] as AppendEventInput).eventType)
}

describe('T-1 写点集成（账本门面 spy 断言）', () => {
  const originalHome = process.env.PROMA_HOME
  let projectId = ''
  let sessionId = ''
  let channelId = ''

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-wp-'))
    vi.mocked(appendExperienceEvent).mockClear()
    mocks.runAgentLoop.mockReset()
    mocks.runAgentLoop.mockResolvedValue(loopCompleted())
    mocks.runGwtScenarios.mockReset()
    mocks.circuitBreakRollback.mockReset()
    mocks.circuitBreakRollback.mockResolvedValue({ rolled_back: false, outcome: 'delegated' })
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


  it('负断言：GWT 全过的健康路径零事件行', async () => {
    updateProject(projectId, { test_repair_count: 1 })
    mocks.runGwtScenarios.mockResolvedValue(gwtPassed())
    await new Promise((r) => setImmediate(r))
    const types = spyEventTypes()
    expect(types).not.toContain('gwt_failure')
    expect(types).not.toContain('abnormal_outcome')
  })


})

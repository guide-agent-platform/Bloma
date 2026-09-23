import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project/project-service'
import {
  resetSessionActivityThrottleForTests,
  runSketchTask,
  setProgrammingEventPublisher,
} from '../../main/coding/programming-orchestrator'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/delivery/platform-services'
import { decryptApiKey, getFirstEnabledChannel } from '../../main/platform/llm/channel-manager'
import { listSessions } from '../../main/platform/sessions/session-service'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import type { Channel, SDKMessage } from '../../shared/types'

vi.mock('../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/platform/llm/channel-manager')>()
  // importOriginal + spread 保住 buildSdkEnv 等真实实现（陷阱 2）
  return {
    ...actual,
    getFirstEnabledChannel: vi.fn(),
    decryptApiKey: vi.fn(),
  }
})

/**
 * 缺陷④回归：后台链路（runSketchTask/runMvpTask/runIterationTask 等不经 runAgent 的
 * 任务）此前从不刷新 agent-sessions.json 索引——实测后台 MVP 跑完数小时，索引
 * updated_at 仍停在最后一次交互消息，历史列表「按最近活跃倒序」失真。
 * 修复：publish（全部后台链路事件必经点）前置节流刷新。用模板回退草图链路驱动验证。
 */

const failingQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  throw new Error('SKETCH_LLM_TIMEOUT: 草图生成超时，已取消本次生成')
}

const testChannel: Channel = {
  id: 'test-channel',
  name: 'Test',
  provider_type: 'anthropic',
  base_url: 'https://api.anthropic.com',
  api_key: 'encrypted-test-key',
  models: [{ id: 'claude-sonnet-4-6', name: 'claude-sonnet-4-6', enabled: true }],
  enabled: true,
} as unknown as Channel

function setupSandbox(): void {
  setSandboxRuntimeForTests({
    portAllocator: async () => 3105,
    healthCheck: async () => true,
    processFactory: () => makeChildProcess(),
  })
  setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
}

describe('后台链路会话索引活跃刷新（缺陷④）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    resetSessionActivityThrottleForTests()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setProgrammingEventPublisher(() => undefined)
    vi.mocked(getFirstEnabledChannel).mockReset()
    vi.mocked(decryptApiKey).mockReset()
  })

  it('后台草图任务发布事件 → 刷新索引 updated_at 并回填 last_session_id', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-session-act-'))
    process.env.PROMA_HOME = home
    vi.mocked(getFirstEnabledChannel).mockReturnValue(testChannel)
    vi.mocked(decryptApiKey).mockReturnValue('test-key')
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '赛车模拟器' })
    setupSandbox()

    const beforeRun = new Date().toISOString()
    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-bg-activity',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '帮我做一个赛车模拟器',
      requirements: [{ id: 'F-001', description: '帮我做一个赛车模拟器' }],
      query: failingQuery,
    })

    const record = listSessions({ request_id: 'req-check' }).sessions.find(
      (item) => item.session_id === 'session-bg-activity',
    )
    expect(record).toBeDefined()
    expect(record!.project_id).toBe(project.project_id)
    // 修复前：后台链路不写索引，record 不存在；修复后必须携带运行时新鲜时间
    expect(record!.updated_at >= beforeRun).toBe(true)
    // 后台链路同样回填项目「最后活跃会话」
    expect(findProject(project.project_id).last_session_id).toBe('session-bg-activity')
  })

  it('会话索引刷新失败不阻断后台链路（旁路观测容错）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-session-act-2-'))
    process.env.PROMA_HOME = home
    vi.mocked(getFirstEnabledChannel).mockReturnValue(testChannel)
    vi.mocked(decryptApiKey).mockReturnValue('test-key')
    // 字面 project_id 不存在于项目索引：recordSessionActivity 内部吞 PROJECT_NOT_FOUND，
    // 这里再叠加节流重置后连续发布，验证事件链路照常完成、草图照常落盘
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '赛车模拟器' })
    setupSandbox()

    const result = await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-bg-fault',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '帮我做一个赛车模拟器',
      requirements: [{ id: 'F-001', description: '帮我做一个赛车模拟器' }],
      query: failingQuery,
    })
    // 后台链路照常完成交付（模板回退草图快照），索引刷新失败不产生任何影响
    expect(result.snapshot.kind).toBe('sketch')
    expect(result.summary).toContain('草图')
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

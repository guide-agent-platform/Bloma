import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project-service'
import { runSketchTask, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import { decryptApiKey, getFirstEnabledChannel } from '../../main/channel-manager'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { SDKQuery } from '../../main/orchestrator'
import type { Channel, SDKMessage } from '../../shared/types'

vi.mock('../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/channel-manager')>()
  // importOriginal + spread 保住 buildSdkEnv 等真实实现（否则 runAgent 系测试会 API_KEY_DECRYPT_FAILED）
  return {
    ...actual,
    getFirstEnabledChannel: vi.fn(),
    decryptApiKey: vi.fn(),
  }
})

/**
 * 模板回退可观测性（2026-08-15 赛车模拟器案例）：
 * 草图落确定性模板时不再静默——必须留 console.error 日志、sketch_fallback 埋点、
 * 会话内如实的「草图说明」。这里覆盖三类回退原因。
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
    portAllocator: async () => 3103,
    healthCheck: async () => true,
    processFactory: () => makeChildProcess(),
  })
  setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
}

function readAnalytics(home: string): string {
  return readFileSync(join(home, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl'), 'utf8')
}

describe('sketch template fallback observability', () => {
  const originalPromaHome = process.env.PROMA_HOME
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setProgrammingEventPublisher(() => undefined)
    vi.mocked(getFirstEnabledChannel).mockReset()
    vi.mocked(decryptApiKey).mockReset()
    errorSpy.mockClear()
  })

  it('LLM 生成失败回退模板 → 日志 + sketch_fallback 埋点 + 会话内如实说明', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-fb-llm-'))
    process.env.PROMA_HOME = home
    vi.mocked(getFirstEnabledChannel).mockReturnValue(testChannel)
    vi.mocked(decryptApiKey).mockReturnValue('test-key')
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '赛车模拟器' })
    setupSandbox()

    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-fb-1',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '帮我做一个赛车模拟器',
      requirements: [{ id: 'F-001', description: '帮我做一个赛车模拟器' }],
      query: failingQuery,
    })

    const html = readFileSync(join(findProject(project.project_id).root_path, 'index.html'), 'utf8')
    expect(html).toContain('外观草图 · 仅供确认方向')

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reason=llm_failed'))
    expect(readAnalytics(home)).toContain('"event_type":"sketch_fallback"')
    expect(readAnalytics(home)).toContain('"reason":"llm_failed"')
    expect(readAnalytics(home)).toContain('"llm_error_code":"SKETCH_LLM_TIMEOUT"')
    const session = readFileSync(getAgentSessionPath('session-fb-1'), 'utf8')
    expect(session).toContain('草图说明')
    expect(session).toContain('模型生成失败')
  })

  it('无可用渠道回退模板 → reason=no_channel 埋点 + 渠道指引话术', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-fb-none-'))
    process.env.PROMA_HOME = home
    vi.mocked(getFirstEnabledChannel).mockReturnValue(undefined)
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '赛车模拟器' })
    setupSandbox()

    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-fb-2',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '帮我做一个赛车模拟器',
      requirements: [{ id: 'F-001', description: '帮我做一个赛车模拟器' }],
      query: failingQuery,
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reason=no_channel'))
    expect(readAnalytics(home)).toContain('"reason":"no_channel"')
    const session = readFileSync(getAgentSessionPath('session-fb-2'), 'utf8')
    expect(session).toContain('没有可用的模型渠道')
  })

  it('密钥不可解密回退模板 → reason=decrypt_failed 埋点', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-fb-decrypt-'))
    process.env.PROMA_HOME = home
    vi.mocked(getFirstEnabledChannel).mockReturnValue(testChannel)
    vi.mocked(decryptApiKey).mockImplementation(() => {
      throw new Error('Error while decrypting the ciphertext')
    })
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '赛车模拟器' })
    setupSandbox()

    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-fb-3',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '帮我做一个赛车模拟器',
      requirements: [{ id: 'F-001', description: '帮我做一个赛车模拟器' }],
      query: failingQuery,
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('reason=decrypt_failed'))
    expect(readAnalytics(home)).toContain('"reason":"decrypt_failed"')
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

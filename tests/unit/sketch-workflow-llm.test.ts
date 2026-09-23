import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project-service'
import { runSketchTask, setProgrammingEventPublisher } from '../../main/coding/programming-orchestrator'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import type { SDKQuery } from '../../main/orchestrator'
import type { SDKMessage } from '../../shared/types'

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

/**
 * runSketchTask 草图生成来源分流：渠道可用走 LLM 草图，失败/无渠道回退确定性模板。
 */

const LLM_SKETCH_HTML = `<!doctype html><html lang="zh-CN"><head><style>body{}</style></head>
<body><div data-llm="yes"><h1>音乐合成器</h1><section class="synth">合成器界面</section></div></body></html>`

const llmQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: LLM_SKETCH_HTML }] } }
  yield { type: 'result', subtype: 'success' }
}

const failingQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  throw new Error('model boom')
}

describe('sketch workflow LLM source routing', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setProgrammingEventPublisher(() => undefined)
  })

  function setupSandbox(): void {
    setSandboxRuntimeForTests({
      portAllocator: async () => 3101,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))
  }

  it('渠道可用且传入 query → 走 LLM 草图，落盘 LLM 生成的外观（非模板）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-route-llm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '音乐合成器' })
    setupSandbox()
    setProgrammingEventPublisher(() => undefined)

    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '做一个音乐合成器',
      requirements: [{ id: 'F-001', description: '音乐合成器' }],
      channel_id: 'test-channel',
      query: llmQuery,
    })

    const html = readFileSync(join(findProject(project.project_id).root_path, 'index.html'), 'utf8')
    expect(html).toContain('data-llm="yes"')
    expect(html).toContain('音乐合成器')
    // 非模板产物：不含确定性模板的 topbar 特征
    expect(html).not.toContain('外观草图 · 仅供确认方向')
  })

  it('LLM 生成失败 → 回退确定性模板草图，不阻断草图产出', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-route-fallback-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '音乐合成器' })
    setupSandbox()
    setProgrammingEventPublisher(() => undefined)

    await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '做一个音乐合成器',
      requirements: [{ id: 'F-001', description: '音乐合成器' }],
      channel_id: 'test-channel',
      query: failingQuery,
    })

    const html = readFileSync(join(findProject(project.project_id).root_path, 'index.html'), 'utf8')
    // 回退到确定性模板：含模板特征（topbar + 页脚说明）
    expect(html).toContain('topbar')
    expect(html).toContain('外观草图 · 仅供确认方向')
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

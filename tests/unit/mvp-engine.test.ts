import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMvp } from '../../main/mvp-engine'
import { runMvpTask, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'
import { createChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import { getAnalyticsPath, getDocumentsDir } from '../../storage/config-paths'
import type { SDKQuery } from '../../main/orchestrator'
import type { SDKMessage } from '../../shared/types'

describe('MvpEngine template generation (A2-02)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('renders a runnable template project and returns the run command', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-engine-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '家庭记账工具' })

    const result = generateMvp({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '记录收入与支出' }],
    })

    expect(result.run_command).toBe('npm start')
    expect(result.files.map((file) => file.path)).toEqual([
      'package.json',
      'static-server.js',
      'index.html',
      'src/app.js',
      'src/styles.css',
    ])

    const packageJson = readFileSync(join(project.root_path, 'package.json'), 'utf8')
    expect(packageJson).toContain('"start": "node static-server"')
    const staticServer = readFileSync(join(project.root_path, 'static-server.js'), 'utf8')
    expect(staticServer).toContain('process.env.PORT')
    expect(staticServer).toContain("connect-src 'none'")
    const indexHtml = readFileSync(join(project.root_path, 'index.html'), 'utf8')
    expect(indexHtml).toContain('家庭记账工具')
    expect(indexHtml).toContain('记录收入与支出')
    expect(indexHtml).toContain('data-feature="F-001"')
  })

  it('falls back to a default feature when no requirements are provided', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-empty-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const result = generateMvp({ project_id: project.project_id })

    const indexHtml = readFileSync(join(project.root_path, 'index.html'), 'utf8')
    expect(result.assumptions.join('')).toContain('1 个功能点')
    expect(indexHtml).toContain('data-feature="F-001"')
  })

  it('escapes requirement text so user content cannot break out of the template', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-xss-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    generateMvp({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '<img src=x onerror=alert(1)>' }],
    })

    const indexHtml = readFileSync(join(project.root_path, 'index.html'), 'utf8')
    expect(indexHtml).not.toContain('<img src=x onerror=alert(1)>')
    expect(indexHtml).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('Mvp workflow task (A2-04 runMvpTask)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setProgrammingEventPublisher(() => undefined)
  })

  it('generates the MVP, snapshots it with documents, records analytics, and emits mvp_ready', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-task-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '展示任务看板' }])
    const events: string[] = []

    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))
    setProgrammingEventPublisher((event) => events.push(event.type))

    createTestChannel(true)
    const result = await runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      query: calculatorQuery(),
    })

    expect(result.preview_url).toBe('http://localhost:3100')
    expect(result.run_command).toBe('npm start')
    expect(events).toContain('mvp_ready')
    expect(events).toContain('stage_changed')
    expect(findProject(project.project_id).current_stage).toBe('testing')

    expect(existsSync(join(project.root_path, 'static-server.js'))).toBe(true)
    expect(existsSync(join(result.snapshot.files_archive_path, 'src', 'app.js'))).toBe(true)
    // mvp 快照 include_documents: true —— 快照目录带 documents 归档
    expect(result.snapshot.documents_archive_path && existsSync(result.snapshot.documents_archive_path)).toBe(true)

    const analytics = readFileSync(getAnalyticsPath(project.workspace_slug), 'utf8')
    expect(analytics).toContain('mvp_delivered')

    // 文档打点：sketch_confirmed 与 mvp_before_generation 两个 checkpoint 落盘
    const documentsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    expect(existsSync(join(documentsDir, 'sketch_confirmed.md'))).toBe(true)
    expect(existsSync(join(documentsDir, 'mvp_before_generation.md'))).toBe(true)
  })

  // ── A2-14b：runMvpTask 的 LLM 生成路径（无模板兜底）──

  it('无渠道时抛错（即使传入 query，无模板兜底）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-nolllm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '基础四则运算计算器' }])
    setSandboxRuntimeForTests({ portAllocator: async () => 3201, healthCheck: async () => true, processFactory: () => makeChildProcess() })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))

    await expect(runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      query: calculatorQuery(),
    })).rejects.toThrow('没有可用的模型渠道')
  })

  it('渠道存在但 decryptApiKey 失败 → 抛 API_KEY_DECRYPT_FAILED（无模板兜底）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-badkey-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    const channel = createTestChannel(false)
    setSandboxRuntimeForTests({ portAllocator: async () => 3202, healthCheck: async () => true, processFactory: () => makeChildProcess() })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))

    await expect(runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      channel_id: channel.id,
      query: calculatorQuery(),
    })).rejects.toThrow('API_KEY_DECRYPT_FAILED')
  })

  it('有渠道且 LLM 成功 → 快照 summary 体现 LLM 产出、run_command 强制 npm start、产物为真实计算器', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-llm-ok-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '基础四则运算计算器' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '基础四则运算计算器' }])
    createTestChannel(true)
    setSandboxRuntimeForTests({ portAllocator: async () => 3203, healthCheck: async () => true, processFactory: () => makeChildProcess() })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))

    const result = await runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      query: calculatorQuery(),
    })

    // run_command 被强制覆盖为 npm start（模型返回 evil-run 也被忽略）
    expect(result.run_command).toBe('npm start')
    expect(result.snapshot.summary).toContain('LLM 生成')
    // 产物为真实计算器（四则按钮 + calculate 逻辑），而非增删条目模板
    expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('+')
    expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('÷')
    expect(readFileSync(join(project.root_path, 'src', 'app.js'), 'utf8')).toContain('calculate')
  })

  it('有渠道但 input.query 缺失 → 抛 MVP_GENERATION_FAILED（无模板兜底）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-noquery-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    createTestChannel(true)
    setSandboxRuntimeForTests({ portAllocator: async () => 3204, healthCheck: async () => true, processFactory: () => makeChildProcess() })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))

    await expect(runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      // 不传 query
    })).rejects.toThrow('MVP_GENERATION_FAILED')
  })

  it('收到 query 但 LLM 抛错 → 错误向上传播，管线中断（无模板兜底）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-mvp-llmerr-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    createTestChannel(true)
    setSandboxRuntimeForTests({ portAllocator: async () => 3205, healthCheck: async () => true, processFactory: () => makeChildProcess() })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake-png') }))

    await expect(runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      query: throwingQuery(),
    })).rejects.toThrow('model network error')
  })
})

/** 新建一条项目渠道；decryptable=false 时模拟密钥损坏（decrypt 抛错），true 时正常解密。 */
function createTestChannel(decryptable: boolean): { id: string } {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => {
      if (!decryptable) throw new Error('Error while decrypting the ciphertext')
      return value.toString('utf8').replace(/^enc:/, '')
    },
  })
  return createChannel({ name: 'test', provider_type: 'anthropic', base_url: 'https://test', api_key: 'test-key', models: [{ id: 'm1', name: 'test-model', enabled: true }] })
}

/** LLM 生成型 SDK query 桩：返回可落盘的真实计算器（四则按钮 + calculate 逻辑）。 */
const CALCULATOR_JSON = JSON.stringify({
  files: [
    { path: 'index.html', content: '<!doctype html><html><body><button>+</button><button>−</button><button>×</button><button>÷</button><script src="/src/app.js"></script></body></html>' },
    { path: 'src/app.js', content: 'function calculate(a, op, b) { return op === "+" ? a + b : a; }' },
    { path: 'src/styles.css', content: 'body { margin: 0; }' },
  ],
  run_command: 'npm run evil',
  assumptions: ['纯前端计算器'],
  risks: ['无后端'],
})

function calculatorQuery(): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: CALCULATOR_JSON }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

/** LLM query 桩：直接抛错，模拟模型网络错误。 */
function throwingQuery(): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    throw new Error('model network error')
  }
}

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

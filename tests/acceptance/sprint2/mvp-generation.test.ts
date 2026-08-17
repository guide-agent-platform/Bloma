import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS, type AgentEvent, type ApiResult, type Project, type SDKMessage } from '../../../shared/types'
import type { SDKQuery } from '../../../main/orchestrator'
import { registerIpcHandlers } from '../../../main/ipc'
import { clearSandboxRuntimeForTests, createSnapshot, stopSandbox } from '../../../main/platform-services'
import { generateSketch } from '../../../main/sketch-engine'
import { recordSketchGenerated } from '../../../main/project-service'
import { waitForCondition } from '../support/test-environment'

/** A2-14b 后 resolveMvp 一律走 LLM（无模板兜底），测试必须注入确定性 query。 */
const { mockSdkQuery } = vi.hoisted(() => ({ mockSdkQuery: { current: null as unknown as SDKQuery } }))

const CALCULATOR_JSON = JSON.stringify({
  files: [
    { path: 'index.html', content: '<!doctype html><html><body><button>+</button><button>−</button><button>×</button><button>÷</button><script src="/src/app.js"></script></body></html>' },
    { path: 'src/app.js', content: 'function calculate(a, op, b) { return op === "+" ? a + b : a; }' },
    { path: 'src/styles.css', content: 'body { margin: 0; }' },
  ],
  run_command: 'npm start',
  assumptions: ['家庭记账'],
  risks: [],
})

function queryReturning(text: string): SDKQuery {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

const TEST_CHANNEL = {
  id: 'test-channel',
  name: 'Test',
  provider_type: 'anthropic',
  base_url: 'https://api.anthropic.com',
  api_key: 'encrypted-test-key',
  models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
  enabled: true,
}

// mock 必须 importOriginal + spread（陷阱 2 约定）：model-resolution 的类别解析会调
// listEnabledModels（真实实现按 enabled 过滤），裸工厂缺导出会让解析抛错、mvp_ready
// 永不发出（S2-PROJECT-001 超时）。
vi.mock('../../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: () => TEST_CHANNEL,
    // 全量 mock 需补齐 getFirstEnabledChannel：programming-orchestrator resolveMvp 在
    // confirm-sketch 未传 channel_id 时回退到它（S2-PROJECT-001 超时根因）。
    getFirstEnabledChannel: () => TEST_CHANNEL,
    decryptApiKey: () => 'test-key-from-channel',
    // 修复：mock 必须提供 buildSdkEnv，否则 programming-orchestrator 调用 undefined 抛错，
    // 导致 mvp_ready 事件永不发出（S2-PROJECT-001 超时）。
    // env 必须含 PATH：orchestrator anthropicMessagesQuery 校验 `SDK env missing PATH`。
    buildSdkEnv: (_apiKey: string, baseUrl: string, model: string) => ({
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model,
      PATH: process.env.PATH ?? process.env.Path ?? 'MOCK_PATH',
    }),
  }
})

// confirm-sketch accepted → runMvpTask({ query: getSdkQuery() }) 走 LLM 生成。
// 覆盖 getSdkQuery 返回确定性 mock query，避免测试发起真实模型 HTTP 请求而超时。
vi.mock('../../../main/orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/orchestrator')>()
  return { ...actual, getSdkQuery: () => mockSdkQuery.current }
})

type IpcHandler = (_event: unknown, payload: unknown) => unknown

/**
 * Sprint 2 · S2-PROJECT-001 草图确认后生成 MVP
 *
 * 文档依据：
 * - generation-workflow.feature @S2-PROJECT-001
 * - api-spec §7.4 project:confirm-sketch（accepted → generating_mvp）
 * - component-design §7 修复计数 / §11 JudgeEngine
 * - PRD §5.1 三阶段生成模型（草图确认 → MVP）
 */
describe('Sprint 2 MVP generation acceptance (S2-PROJECT-001)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined
  let activeProjectId: string | undefined

  afterEach(async () => {
    // runMvpTask 会启动真实沙箱进程，先停掉再清理临时目录，避免 Windows 下 EPERM
    if (activeProjectId) stopSandbox({ request_id: 'cleanup', project_id: activeProjectId })
    clearSandboxRuntimeForTests()
    if (home) {
      const { rmSync } = await import('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
    activeProjectId = undefined
    vi.restoreAllMocks()
  })

  function setup(prefix: string): { events: AgentEvent[]; invoke: (channel: string, payload: unknown) => unknown } {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    const handlers = new Map<string, IpcHandler>()
    const events: AgentEvent[] = []
    const ipcMain = { handle: (channel: string, handler: IpcHandler) => handlers.set(channel, handler) }
    const mainWindow = { webContents: { send: (_channel: string, event: AgentEvent) => events.push(event) } }
    registerIpcHandlers(ipcMain as never, mainWindow as never)
    return {
      events,
      invoke: (channel: string, payload: unknown) => handlers.get(channel)?.({}, payload),
    }
  }

  async function createProject(
    app: ReturnType<typeof setup>,
    mode: Project['mode'],
  ): Promise<Project> {
    const response = await app.invoke(IPC_CHANNELS.PROJECT_CREATE, {
      request_id: `s2-create-${mode}`,
      mode,
      initial_message: '做一个家庭记账页面，可以记录收入支出并展示本月结余',
    }) as ApiResult<Project>
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    return response.data
  }

  it('[S2-PROJECT-001] 草图确认 accepted 后生成正式 MVP 目录、mvp 快照与 PRD/GWT 文档', async () => {
    // A2-14b：MVP 由 LLM 生成（无模板兜底），注入确定性计算器响应
    mockSdkQuery.current = queryReturning(CALCULATOR_JSON)
    const app = setup('bloma-s2-mvp-')
    const project = await createProject(app, 'quick')
    activeProjectId = project.project_id

    // ① 先生成草图并记录需求（草图确认的前置状态）
    const requirements = [
      { id: 'F-001', description: '记录收入与支出' },
      { id: 'F-002', description: '展示本月结余' },
      { id: 'F-003', description: '按分类查看流水' },
    ]
    generateSketch({ project_id: project.project_id, requirements, max_pages: 3 })
    recordSketchGenerated(project.project_id, requirements)
    const sketchSnapshot = await createSnapshot({
      request_id: 's2-sketch-snapshot',
      project_id: project.project_id,
      kind: 'sketch',
      summary: '记录收支与结余的验证草图',
      include_documents: false,
      health_status: 'healthy',
    })

    // ② 用户确认方向
    const response = await app.invoke(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, {
      request_id: 's2-confirm',
      project_id: project.project_id,
      session_id: 's2-session',
      snapshot_id: sketchSnapshot.snapshot_id,
      decision: 'accepted',
    }) as ApiResult<Project>

    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.data.current_stage).toBe('generating_mvp')

    // ③ runMvpTask 由 IPC handler 异步触发：等待 mvp_ready 事件
    await waitForCondition(() => app.events.some((event) => event.type === 'mvp_ready'), 5_000)
    const ready = app.events.find((event) => event.type === 'mvp_ready')
    expect(ready).toBeTruthy()

    // ④ 正式项目目录结构（mvp-engine 模板：package.json / static-server.js / index.html / src/app.js / src/styles.css）
    expect(existsSync(join(project.root_path, 'package.json'))).toBe(true)
    expect(existsSync(join(project.root_path, 'static-server.js'))).toBe(true)
    expect(existsSync(join(project.root_path, 'index.html'))).toBe(true)
    expect(existsSync(join(project.root_path, 'src', 'app.js'))).toBe(true)
    expect(existsSync(join(project.root_path, 'src', 'styles.css'))).toBe(true)

    // ⑤ MVP 快照：kind = mvp，且包含文档归档
    const snapshotId = ready?.payload.snapshot_id as string
    const snapshotDir = join(home!, 'agent-workspaces', project.workspace_slug, 'snapshots', project.project_id)
    const snapshotMeta = JSON.parse(
      readFileSync(join(snapshotDir, `${snapshotId}.json`), 'utf8'),
    ) as { kind: string; documents_archive_path?: string }
    expect(snapshotMeta.kind).toBe('mvp')
    expect(snapshotMeta.documents_archive_path && existsSync(snapshotMeta.documents_archive_path)).toBe(true)

    // ⑥ PRD 同步：sketch_confirmed 与 mvp_before_generation 两个 checkpoint 落盘
    const docsDir = join(home!, 'agent-workspaces', project.workspace_slug, 'documents', project.project_id)
    expect(existsSync(join(docsDir, 'sketch_confirmed.md'))).toBe(true)
    expect(existsSync(join(docsDir, 'mvp_before_generation.md'))).toBe(true)
    // GWT 骨架：每个 P0 功能项对应一个 feature 文件（S2-JUDGE-009 前置）
    const featuresDir = join(docsDir, 'features')
    expect(existsSync(featuresDir)).toBe(true)
    const featureFiles = readdirSync(featuresDir).filter((name) => name.endsWith('.feature'))
    expect(featureFiles.length).toBeGreaterThanOrEqual(requirements.length)

    // ⑦ 埋点：mvp_delivered 写入 analytics.jsonl，research_safe，不含原始需求全文
    const analytics = readFileSync(join(home!, 'agent-workspaces', project.workspace_slug, 'analytics.jsonl'), 'utf8')
    const events = analytics.trim().split(/\r?\n/).filter(Boolean)
      .map((line) => JSON.parse(line) as { event_type: string; privacy_level: string })
    expect(events.some((event) => event.event_type === 'mvp_delivered')).toBe(true)
    expect(events.some((event) => event.event_type === 'project_created')).toBe(true)
    expect(events.every((event) => event.privacy_level === 'research_safe')).toBe(true)
    expect(analytics).not.toContain('家庭记账页面，可以记录收入支出')
  })

  it('[S2-PROJECT-001b] 草图确认 needs_change 应回到 clarifying 且不生成 MVP', async () => {
    const app = setup('bloma-s2-mvp-reject-')
    const project = await createProject(app, 'quick')
    const requirements = [{ id: 'F-001', description: '记录收入与支出' }]
    generateSketch({ project_id: project.project_id, requirements, max_pages: 1 })
    recordSketchGenerated(project.project_id, requirements)

    const response = await app.invoke(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH, {
      request_id: 's2-reject',
      project_id: project.project_id,
      session_id: 's2-session-reject',
      snapshot_id: 'sketch-snapshot-x',
      decision: 'needs_change',
      note: '配色要更温和一些',
    }) as ApiResult<Project>

    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.data.current_stage).toBe('clarifying')
    expect(app.events.some((event) => event.type === 'mvp_ready')).toBe(false)
  })
})

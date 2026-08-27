import { restorePromaHome } from '../../support/proma-home-guard'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../../main/ipc'
import { clearSandboxRuntimeForTests, stopSandbox } from '../../../main/platform-services'
import { updateProject } from '../../../main/project-service'
import { IPC_CHANNELS, type AgentEvent, type ApiResult, type Project } from '../../../shared/types'

vi.mock('../../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/channel-manager')>()
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

type IpcHandler = (_event: unknown, payload: unknown) => unknown

describe('Sprint 1 sketch and upgrade regression', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined
  let activeProjectId: string | undefined
  let activePreviewUrl: string | undefined

  afterEach(async () => {
    if (activeProjectId) stopSandbox({ request_id: 'cleanup', project_id: activeProjectId })
    clearSandboxRuntimeForTests()
    if (activePreviewUrl) await waitUntilStopped(activePreviewUrl)
    restorePromaHome(originalPromaHome)
    if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    home = undefined
    activeProjectId = undefined
    activePreviewUrl = undefined
    vi.restoreAllMocks()
  })

  it('[S1-SKETCH-001] 不明确需求应最多返回三个非技术澄清选项', async () => {
    const app = harness()
    const project = await createProject(app, 'quick')

    const result = await app.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
      request_id: 'req-clarify',
      session_id: 'session-clarify',
      project_id: project.project_id,
      content: '做个管理工具',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    }) as ApiResult<unknown>
    const decision = app.events.find((item) => item.type === 'user_decision_required')
    const options = decision?.payload.questions as Array<{ label: string; description?: string }>

    expect(result.ok).toBe(true)
    expect(options).toHaveLength(3)
    expect(JSON.stringify(options)).not.toMatch(/API|数据库|框架|代码|技术栈/i)
  })

  it('[S1-SKETCH-002] 明确需求应在 60 秒内生成可访问草图、快照和三类埋点', async () => {
    const startedAt = Date.now()
    const app = harness()
    const project = await createProject(app, 'quick')
    activeProjectId = project.project_id

    const result = await app.invoke(IPC_CHANNELS.AGENT_SEND_MESSAGE, {
      request_id: 'req-sketch',
      session_id: 'session-sketch',
      project_id: project.project_id,
      content: '做一个家庭记账页面，可以记录收入支出并展示本月结余',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    }) as ApiResult<unknown>
    const ready = app.events.find((item) => item.type === 'sketch_ready')
    const previewUrl = ready?.payload.preview_url as string
    activePreviewUrl = previewUrl
    const snapshotId = ready?.payload.snapshot_id as string

    expect(result.ok).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(60_000)
    expect(previewUrl).toMatch(/^http:\/\/localhost:\d+$/)
    expect((await fetch(previewUrl)).status).toBe(200)
    expect(readFileSync(join(project.root_path, 'index.html'), 'utf8')).toContain('家庭记账')
    expect(readFileSync(join(home!, 'agent-workspaces', project.workspace_slug, 'snapshots', project.project_id, `${snapshotId}.json`), 'utf8')).toContain('"kind": "sketch"')

    const analytics = readFileSync(join(home!, 'agent-workspaces', project.workspace_slug, 'analytics.jsonl'), 'utf8')
    expect(analytics).toContain('project_created')
    expect(analytics).toContain('conversation_submitted')
    expect(analytics).toContain('sketch_generated')
  })

  it('[S1-PROJECT-004] 快消型升级前应创建 upgrade 快照再切换为长期模式', async () => {
    const app = harness()
    const project = await createProject(app, 'quick')
    updateProject(project.project_id, { status: 'completed', current_stage: 'completed' })

    const response = await app.invoke(IPC_CHANNELS.PROJECT_UPGRADE, {
      request_id: 'req-upgrade',
      project_id: project.project_id,
      session_id: 'session-upgrade',
    }) as ApiResult<Project>

    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error.message)
    expect(response.data.mode).toBe('longterm')

    const snapshotDir = join(home!, 'agent-workspaces', project.workspace_slug, 'snapshots', project.project_id)
    const snapshots = readdirSync(snapshotDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => JSON.parse(readFileSync(join(snapshotDir, name), 'utf8')) as { kind?: string })
    expect(snapshots.some((snapshot) => snapshot.kind === 'upgrade')).toBe(true)
  })

  function harness() {
    home = mkdtempSync(join(tmpdir(), 'bloma-s1-acceptance-'))
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
})

async function createProject(app: ReturnType<typeof acceptanceHarnessShape>, mode: Project['mode']): Promise<Project> {
  const response = await app.invoke(IPC_CHANNELS.PROJECT_CREATE, { request_id: `req-project-${mode}`, mode }) as ApiResult<Project>
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(response.error.message)
  expect(response.data.current_stage).toBe('clarifying')
  expect(response.data.mode).toBe(mode)
  return response.data
}

function acceptanceHarnessShape() {
  return {
    events: [] as AgentEvent[],
    invoke: (_channel: string, _payload: unknown): unknown => undefined,
  }
}

async function waitUntilStopped(url: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(100) })
      await new Promise((resolve) => setTimeout(resolve, 50))
    } catch {
      return
    }
  }
}

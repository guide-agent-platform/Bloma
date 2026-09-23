import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSandboxRuntimeForTests, runSandbox, setSandboxRuntimeForTests, stopSandbox } from '../../../main/delivery/sandbox'
import { createSnapshot, setSnapshotCaptureProviderForTests } from '../../../main/delivery/snapshots'
import { runAgent, setAgentStreamPublisher } from '../../../main/orchestration/orchestrator'
import { createProject } from '../../../main/project/project-service'
import { generateSketch } from '../../../main/coding/sketch-engine'
import type { AgentEvent, ApiResult, Project } from '../../../shared/types'
import {
  makeChildProcess,
  useTemporaryPromaHome,
  type TemporaryPromaHome,
} from '../support/test-environment'

vi.mock('../../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/platform/llm/channel-manager')>()
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

describe('Sprint 1 sketch delivery acceptance', () => {
  let environment: TemporaryPromaHome | undefined
  let runningProjectId: string | undefined
  let runningPreviewUrl: string | undefined

  afterEach(async () => {
    if (runningProjectId) {
      stopSandbox({ request_id: 'role-c-cleanup', project_id: runningProjectId })
    }
    if (runningPreviewUrl) await waitUntilStopped(runningPreviewUrl)
    runningProjectId = undefined
    runningPreviewUrl = undefined
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setAgentStreamPublisher(() => undefined)
    environment?.cleanup()
    environment = undefined
  })

  it('[S1-SKETCH-006] 草图应是含内联 CSS 的无交互纯外观单文件 HTML', () => {
    environment = useTemporaryPromaHome('bloma-role-c-sketch-file-')
    const project = createProject({
      request_id: 'role-c-sketch-project',
      mode: 'quick',
      initial_message: '家庭记账',
    })
    const generated = generateSketch({
      project_id: project.project_id,
      requirements: [
        { id: 'F-001', description: '记录收入和支出' },
        { id: 'F-002', description: '查看本月结余' },
      ],
      max_pages: 3,
    })
    const html = readFileSync(join(project.root_path, 'index.html'), 'utf8')

    expect(generated.files).toHaveLength(1)
    expect(generated.files[0]?.path).toBe('index.html')
    expect(html).toMatch(/<style>[\s\S]+<\/style>/)
    // 无交互：不产出 <script>、无事件绑定，整页 pointer-events 禁用，控件只看不动
    expect(html).not.toMatch(/<script>/)
    expect(html).not.toMatch(/addEventListener|onclick=|classList\./)
    expect(html).toContain('pointer-events: none')
    // 外观界面：含产品外壳（顶栏 + hero + 功能区块），且区块数受 max_pages 约束
    expect(html).toContain('topbar')
    expect(html).toContain('hero')
    expect((html.match(/data-page=/g) ?? []).length).toBeGreaterThanOrEqual(1)
    expect((html.match(/data-page=/g) ?? []).length).toBeLessThanOrEqual(3)
  })

  it('[S1-AGENT-002] 明确需求应按 generating_sketch → sketch_ready → completed 发布事件', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-event-chain-')
    const project = createProject({ request_id: 'role-c-event-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setAgentStreamPublisher((event) => events.push(event))
    setSandboxRuntimeForTests({
      portAllocator: async () => 3180,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess().process,
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('role-c-png'),
    }))

    await runAgent({
      request_id: 'role-c-event-run',
      session_id: 'role-c-event-session',
      project_id: project.project_id,
      content: '做一个家庭记账页面，可以记录收入支出并查看本月结余',
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const types = events.map((event) => event.type)
    expect(types.indexOf('stage_changed')).toBeLessThan(types.indexOf('sketch_ready'))
    expect(types.indexOf('sketch_ready')).toBeLessThan(types.lastIndexOf('completed'))
    expect(events.find((event) => event.type === 'sketch_ready')?.payload.preview_url)
      .toBe('http://localhost:3180')
  })

  it('[S1-SNAPSHOT-001] 草图快照应包含截图、摘要和创建时间', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-snapshot-')
    const project = createProject({ request_id: 'role-c-snapshot-project', mode: 'quick' })
    generateSketch({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '展示收支列表' }],
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('role-c-screenshot'),
    }))

    const snapshot = await createSnapshot({
      request_id: 'role-c-snapshot',
      project_id: project.project_id,
      kind: 'sketch',
      summary: '展示收支记录与本月结余',
      include_documents: false,
      health_status: 'healthy',
    })

    expect(snapshot.summary).toBe('展示收支记录与本月结余')
    expect(snapshot.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(snapshot.screenshot_path && existsSync(snapshot.screenshot_path)).toBe(true)
    expect(existsSync(join(snapshot.files_archive_path, 'index.html'))).toBe(true)
  })

  it('[S1-ANALYTICS-001] 草图闭环应记录三类 research_safe 埋点且不保存原始需求', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-analytics-')
    const secretRequirement = '我的私人账本口令是 ROLE-C-PRIVATE-CONTENT'
    setSandboxRuntimeForTests({
      portAllocator: async () => 3181,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess().process,
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('role-c-png'),
    }))

    // Project creation analytics is emitted at the IPC boundary. The other two
    // events are emitted by the guide/sketch workflow.
    const { createIpcHarness } = await import('../support/ipc-harness')
    const harness = createIpcHarness()
    const ipcProject = await harness.invoke('project:create', {
      request_id: 'role-c-analytics-ipc-project',
      mode: 'quick',
    }) as ApiResult<Project>
    expect(ipcProject.ok).toBe(true)
    if (!ipcProject.ok) throw new Error(ipcProject.error.message)
    await runAgent({
      request_id: 'role-c-analytics-run',
      session_id: 'role-c-analytics-session',
      project_id: ipcProject.data.project_id,
      content: `做一个记账页面，${secretRequirement}`,
      mode: 'quick',
      current_stage: 'clarifying',
      channel_id: 'test-channel',
    })

    const analyticsPath = join(
      environment.home,
      'agent-workspaces',
      ipcProject.data.workspace_slug,
      'analytics.jsonl',
    )
    const lines = readFileSync(analyticsPath, 'utf8').trim().split(/\r?\n/)
      .map((line) => JSON.parse(line) as {
        event_type: string
        privacy_level: string
        payload: Record<string, unknown>
      })

    expect(lines.map((line) => line.event_type)).toEqual(expect.arrayContaining([
      'project_created',
      'conversation_submitted',
      'sketch_generated',
    ]))
    expect(lines.every((line) => line.privacy_level === 'research_safe')).toBe(true)
    expect(JSON.stringify(lines)).not.toContain(secretRequirement)

    // FIRT（research-plan §4.1）：首个可交互草图耗时 = sketch_generated.created_at - project_created.created_at。
    // 实现上由 programming-orchestrator 在 sketch_generated payload 中写入 duration_ms。
    const sketchEvent = lines.find((line) => line.event_type === 'sketch_generated')
    expect(sketchEvent).toBeDefined()
    expect(sketchEvent?.payload.duration_ms).toBeDefined()
    expect(typeof sketchEvent?.payload.duration_ms).toBe('number')
    expect(sketchEvent?.payload.duration_ms).toBeGreaterThanOrEqual(0)
    // Sprint 1 验收标准：FIRT 中位数 < 60s；单测模板路径极快，断言单样本阈值。
    expect(sketchEvent?.payload.duration_ms).toBeLessThan(60_000)
    expect(sketchEvent?.payload.page_count).toBeDefined()
  })

  it('[S1-SANDBOX-001] 静态预览不得读取项目根目录之外的文件', async () => {
    environment = useTemporaryPromaHome('bloma-role-c-sandbox-boundary-')
    const project = createProject({ request_id: 'role-c-sandbox-project', mode: 'quick' })
    runningProjectId = project.project_id
    writeFileSync(join(project.root_path, 'index.html'), '<h1>inside</h1>', 'utf8')
    const outsidePath = join(dirname(project.root_path), 'outside-secret.txt')
    writeFileSync(outsidePath, 'ROLE-C-OUTSIDE-SECRET', 'utf8')

    const sandbox = await runSandbox({
      request_id: 'role-c-sandbox-run',
      project_id: project.project_id,
      timeout_ms: 5_000,
    })
    expect(sandbox.status).toBe('running')
    if (!sandbox.preview_url) throw new Error('Sandbox did not return preview_url')
    runningPreviewUrl = sandbox.preview_url

    const response = await fetch(`${sandbox.preview_url}/..%5C${basename(outsidePath)}`)
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.status).toBeLessThan(500)
    expect(await response.text()).not.toContain('ROLE-C-OUTSIDE-SECRET')
  })
})

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

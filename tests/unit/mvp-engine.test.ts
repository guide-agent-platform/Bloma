import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateMvp } from '../../main/mvp-engine'
import { runMvpTask, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import { getAnalyticsPath, getDocumentsDir } from '../../storage/config-paths'

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

    const result = await runMvpTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
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
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

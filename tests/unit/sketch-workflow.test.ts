import { restorePromaHome } from '../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../main/project-service'
import { runSketchTask, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import {
  clearSandboxRuntimeForTests,
  createSnapshot,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../main/platform-services'
import { generateSketch } from '../../main/sketch-engine'
import { getAnalyticsPath } from '../../storage/config-paths'

describe('sketch generation workflow', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    setProgrammingEventPublisher(() => undefined)
  })

  it('generates a single-file HTML sketch in the project sandbox', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sketch-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick', initial_message: '记账工具' })

    const result = generateSketch({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '记录收入和支出' }],
      max_pages: 3,
    })

    const htmlPath = join(project.root_path, 'index.html')
    expect(existsSync(htmlPath)).toBe(true)
    expect(readFileSync(htmlPath, 'utf8')).toContain('记录收入和支出')
    expect(result.files).toHaveLength(1)
  })

  it('archives project files, screenshot, and metadata when creating a snapshot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-snapshot-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    generateSketch({
      project_id: project.project_id,
      requirements: [{ id: 'F-001', description: '展示任务看板' }],
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    const snapshot = await createSnapshot({
      request_id: 'req-snapshot',
      project_id: project.project_id,
      kind: 'sketch',
      summary: '草图快照',
      include_documents: false,
      health_status: 'healthy',
    })

    expect(existsSync(join(snapshot.files_archive_path, 'index.html'))).toBe(true)
    expect(snapshot.screenshot_path && existsSync(snapshot.screenshot_path)).toBe(true)
    expect(existsSync(join(home, 'agent-workspaces', project.workspace_slug, 'snapshots', project.project_id, snapshot.snapshot_id, 'metadata.json'))).toBe(true)
    expect(snapshot.created_at).toBeTruthy()
  })

  it('runs the sketch task, creates analytics, updates the project, and emits sketch_ready', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-workflow-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
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

    const result = await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '做一个家庭记账工具',
    })

    expect(result.preview_url).toBe('http://localhost:3100')
    expect(events).toContain('sketch_ready')
    expect(findProject(project.project_id).current_stage).toBe('sketch_ready')
    expect(readFileSync(getAnalyticsPath(project.workspace_slug), 'utf8')).toContain('sketch_generated')
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

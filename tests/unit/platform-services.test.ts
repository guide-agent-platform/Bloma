import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  runSandbox,
  setSandboxRuntimeForTests,
  stopSandbox,
  trackAnalytics,
} from '../../main/platform-services'
import { getAnalyticsPath } from '../../storage/config-paths'

describe('PlatformServices sandbox runtime', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    clearSandboxRuntimeForTests()
  })

  it('starts a sandbox process in the generated project directory and returns a localhost preview URL', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const child = makeChildProcess()
    const captured = { cwd: '', port: 0 }

    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => true,
      processFactory: (cwd, port) => {
        captured.cwd = cwd
        captured.port = port
        return child.process
      },
    })

    const result = await runSandbox({ request_id: 'req-run', project_id: project.project_id })

    expect(result).toEqual({ status: 'running', preview_url: 'http://localhost:3100', port: 3100 })
    expect(captured).toEqual({ cwd: project.root_path, port: 3100 })
  })

  it('retries with a new port when the sandbox process reports a port conflict', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const ports = [3100, 3101]
    let spawnCount = 0

    setSandboxRuntimeForTests({
      portAllocator: async () => ports.shift()!,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      healthCheck: async (url) => url.endsWith(':3101'),
      processFactory: () => {
        spawnCount += 1
        const child = makeChildProcess()
        if (spawnCount === 1) {
          setTimeout(() => child.process.emit('error', new Error('listen EADDRINUSE')), 0)
        }
        return child.process
      },
    })

    const result = await runSandbox({ request_id: 'req-run', project_id: project.project_id, timeout_ms: 50 })

    expect(result.status).toBe('running')
    expect(result.port).toBe(3101)
    expect(spawnCount).toBe(2)
  })

  it('returns a P0-safe error summary when the sandbox process crashes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => false,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      processFactory: () => {
        const child = makeChildProcess()
        setTimeout(() => child.process.emit('exit', 1, null), 0)
        return child.process
      },
    })

    const result = await runSandbox({ request_id: 'req-run', project_id: project.project_id, timeout_ms: 50 })

    expect(result.status).toBe('failed')
    expect(result.error_summary).toEqual({
      category: 'process_crashed',
      user_visible_summary: '预览启动失败，请再试一次。',
    })
  })

  it('stops and removes the tracked sandbox process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const child = makeChildProcess()

    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => true,
      processFactory: () => child.process,
    })

    await runSandbox({ request_id: 'req-run', project_id: project.project_id })
    const result = stopSandbox({ request_id: 'req-stop', project_id: project.project_id })

    expect(result).toEqual({ stopped: true })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('serves generated project files with the real static sandbox process', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-real-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    writeFileSync(join(project.root_path, 'index.html'), '<h1>real sandbox</h1>', 'utf8')

    const result = await runSandbox({
      request_id: 'req-run-real',
      project_id: project.project_id,
      timeout_ms: 5_000,
    })

    try {
      expect(result.status).toBe('running')
      expect(result.preview_url).toBeTruthy()
      const response = await fetch(result.preview_url!)
      expect(await response.text()).toContain('real sandbox')
    } finally {
      stopSandbox({ request_id: 'req-stop-real', project_id: project.project_id })
    }
  })
})

describe('PlatformServices analytics', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  it('records an event under the project workspace slug', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-analytics-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-proj', mode: 'quick' })

    const result = trackAnalytics({
      request_id: 'req-ana',
      event: {
        event_type: 'project_created',
        project_id: project.project_id,
        payload: { mode: 'quick' },
        privacy_level: 'research_safe',
      },
    })

    expect(result.recorded).toBe(true)
    const file = getAnalyticsPath('default-software-builder')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('project_created')
  })

  it('falls back to the default workspace when the project is missing without throwing', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-analytics-'))
    process.env.PROMA_HOME = home

    const result = trackAnalytics({
      request_id: 'req-ana-missing',
      event: {
        event_type: 'project_finalized',
        project_id: 'no-such-project',
        payload: {},
        privacy_level: 'research_safe',
      },
    })

    expect(result.recorded).toBe(true)
    const file = getAnalyticsPath('default-software-builder')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('project_finalized')
  })
})

function makeChildProcess(): { process: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as ChildProcess
  const kill = vi.fn(() => true)
  Object.assign(emitter, { kill, pid: 1000 })
  return { process: emitter, kill }
}

import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProject } from '../../main/project-service'
import {
  MAX_SNAPSHOTS_PER_PROJECT,
  SNAPSHOT_RECENT_KEEP,
  clearSandboxRuntimeForTests,
  createSnapshot,
  enforceSnapshotCapacity,
  runSandbox,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
  stopSandbox,
  trackAnalytics,
} from '../../main/platform-services'
import { getAnalyticsPath, getSnapshotsDir } from '../../storage/config-paths'

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

  it('runSandbox 幂等：同一 project 连续两次调用复用现有沙箱，不重复 spawn', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-idem', mode: 'quick' })
    const child = makeChildProcess()
    let spawnCount = 0
    setSandboxRuntimeForTests({
      portAllocator: async () => 3200,
      healthCheck: async () => true,
      processFactory: () => {
        spawnCount += 1
        return child.process
      },
    })
    const first = await runSandbox({ request_id: 'req-1', project_id: project.project_id })
    const second = await runSandbox({ request_id: 'req-2', project_id: project.project_id })
    expect(spawnCount).toBe(1) // 红：当前第二次 stop+spawn → 2
    expect(second).toEqual({ status: 'running', preview_url: 'http://localhost:3200', port: 3200 })
    expect(second.preview_url).toBe(first.preview_url)
    expect(child.kill).not.toHaveBeenCalled() // 红：当前第二次 stopSandbox 会 kill
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

  it('classifies a generic crash as a P0-safe runtime error without leaking stack traces', async () => {
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
      category: 'runtime_error',
      user_visible_summary: '预览启动失败，请再试一次。',
    })
    expect(JSON.stringify(result.error_summary)).not.toMatch(/node_modules|Error:|at /)
  })

  it('classifies a crash with missing-dependency stderr as dependency_error for the repair loop', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-sandbox-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const stderr = new EventEmitter()

    setSandboxRuntimeForTests({
      portAllocator: async () => 3100,
      healthCheck: async () => false,
      sleep: async () => {
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
      processFactory: () => {
        const child = makeChildProcess()
        Object.assign(child.process, { stderr })
        setTimeout(() => stderr.emit('data', 'internal/errors.js: cannot find module "express"'), 0)
        setTimeout(() => child.process.emit('exit', 1, null), 5)
        return child.process
      },
    })

    const result = await runSandbox({ request_id: 'req-run', project_id: project.project_id, timeout_ms: 50 })

    expect(result.status).toBe('failed')
    expect(result.error_summary).toEqual({
      category: 'dependency_error',
      user_visible_summary: '预览缺少运行依赖，无法启动。',
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
    const result = await stopSandbox({ request_id: 'req-stop', project_id: project.project_id })

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

describe('PlatformServices snapshot capacity (A2-16)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
  })

  it('archives the oldest snapshots beyond the cap while keeping recent ones and latest per kind', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-capacity-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-cap', mode: 'quick' })
    setSnapshotCaptureProviderForTests(async () => ({ extension: 'png', buffer: Buffer.from('fake') }))

    const ids: string[] = []
    const total = MAX_SNAPSHOTS_PER_PROJECT + 5
    for (let i = 0; i < total; i += 1) {
      // 首个用稀有 kind（upgrade），其余全 mvp —— 验证「每 kind 最新」保护独立于新旧
      const snapshot = await createSnapshot({
        request_id: `req-${i}`,
        project_id: project.project_id,
        kind: i === 0 ? 'upgrade' : 'mvp',
        summary: `snapshot-${i}`,
        include_documents: false,
        health_status: 'healthy',
      })
      ids.push(snapshot.snapshot_id)
    }

    const snapshotDir = getSnapshotsDir(project.workspace_slug, project.project_id)
    const active = readdirSync(snapshotDir)
      .filter((entry) => statSync(join(snapshotDir, entry)).isDirectory() && entry !== 'archive')
    const archiveDir = join(snapshotDir, 'archive')
    const archived = existsSync(archiveDir)
      ? readdirSync(archiveDir).filter((entry) => statSync(join(archiveDir, entry)).isDirectory())
      : []

    // 活跃快照回落到上限内，超出的恰好归档
    expect(active.length).toBeLessThanOrEqual(MAX_SNAPSHOTS_PER_PROJECT)
    expect(active.length).toBe(MAX_SNAPSHOTS_PER_PROJECT)
    expect(archived).toHaveLength(5)

    // 最近 N 个全部保留
    for (const recent of ids.slice(-SNAPSHOT_RECENT_KEEP)) {
      expect(active).toContain(recent)
    }
    // 每种 kind 最新一个受保护：最旧的 upgrade 也保留
    expect(active).toContain(ids[0])
    // 最旧且非保护的被归档
    for (const old of ids.slice(1, 6)) {
      expect(archived).toContain(old)
    }

    // 显式调用与 createSnapshot 内联触发一致
    expect(enforceSnapshotCapacity(project.workspace_slug, project.project_id).archived).toEqual([])
  }, 15_000) // 105 个快照的真实文件 I/O 在 Windows 上接近 5s 默认超时，放宽以避免并行负载下偶发超时
})

function makeChildProcess(): { process: ChildProcess; kill: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as ChildProcess
  // kill 时同步发 exit：stopSandbox 会等进程真正退出（2s 兜底），mock 不发事件会白等
  const kill = vi.fn(() => {
    emitter.emit('exit')
    return true
  })
  Object.assign(emitter, { kill, pid: 1000 })
  return { process: emitter, kill }
}

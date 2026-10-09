import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { getAnalyticsPath } from '../../../storage/config-paths'
import { appendJsonLine } from '../../../storage/json-store'
import {
  recordDispatchRunTelemetry,
  resetDispatchTelemetryForTests,
} from '../../../main/desktop/dispatcher-telemetry'
import type { DesktopDispatchRunInput } from '../../../main/desktop/dispatcher-loop'

const projectStore = vi.hoisted(() => ({ workspace: 'default-software-builder' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(() => ({ workspace_slug: projectStore.workspace })),
}))

describe('桌面尝试序号从真实 JSONL 恢复', () => {
  const originalHome = process.env.PROMA_HOME
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(join(tmpdir(), 'bloma-attempts-'))
    process.env.PROMA_HOME = home
    projectStore.workspace = 'default-software-builder'
    resetDispatchTelemetryForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetDispatchTelemetryForTests()
    restorePromaHome(originalHome)
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  })

  function logPath(): string {
    return getAnalyticsPath(projectStore.workspace)
  }

  function historical(index: unknown, projectId = 'p1', phase = 'desktop-implement') {
    return {
      event_type: 'desktop_dispatch_run', project_id: projectId,
      payload: { phase, ...(index === undefined ? {} : { attempt_index: index }) },
    }
  }

  function record(projectId = 'p1', phase = 'desktop-implement'): Record<string, unknown> {
    const input = { projectId, sessionId: 's1', currentPhase: phase } as DesktopDispatchRunInput
    recordDispatchRunTelemetry(input, { status: 'completed' }, Date.now())
    const lastLine = fs.readFileSync(logPath(), 'utf8').trim().split('\n').at(-1)!
    return (JSON.parse(lastLine) as { payload: Record<string, unknown> }).payload
  }

  it('首次为 1，连续运行递增；清空进程状态后续跑仍为 3', () => {
    expect(record()).toMatchObject({ attempt_index: 1, phase: 'desktop-implement' })
    expect(record().attempt_index).toBe(2)
    resetDispatchTelemetryForTests()
    expect(record().attempt_index).toBe(3)
  })

  it('兼容旧版本重启后重复的序号与没有序号的历史段，不改写原记录', () => {
    for (const index of [1, 2, 1, undefined]) appendJsonLine(logPath(), historical(index))
    const before = fs.readFileSync(logPath(), 'utf8')
    expect(record().attempt_index).toBe(5)
    expect(fs.readFileSync(logPath(), 'utf8').startsWith(before)).toBe(true)
  })

  it('历史序号有缺口时接最大值，兼容 event 包装格式', () => {
    appendJsonLine(logPath(), { event: historical(8) })
    expect(record().attempt_index).toBe(9)
  })

  it('不同项目、阶段与起跑事件互不混计', () => {
    appendJsonLine(logPath(), historical(5, 'other'))
    appendJsonLine(logPath(), historical(7, 'p1', 'desktop-verify'))
    appendJsonLine(logPath(), { ...historical(99), event_type: 'desktop_dispatch_run_started' })
    expect(record().attempt_index).toBe(1)
    expect(record('p1', 'desktop-verify').attempt_index).toBe(8)
    expect(record('other').attempt_index).toBe(6)
  })

  it('同进程切换 home 或工作区时不会复用别处的计数', () => {
    expect(record().attempt_index).toBe(1)
    process.env.PROMA_HOME = join(home, 'isolated')
    expect(record().attempt_index).toBe(1)
    projectStore.workspace = 'another-workspace'
    expect(record().attempt_index).toBe(1)
    process.env.PROMA_HOME = home
    projectStore.workspace = 'default-software-builder'
    expect(record().attempt_index).toBe(2)
  })

  it('坏行、脏形状与非法序号不会遮蔽完整历史；非法序号仍按一次实际段计数', () => {
    fs.mkdirSync(dirname(logPath()), { recursive: true })
    fs.writeFileSync(logPath(), '\nnull\n[]\n{"truncated":\n{"payload":null}\n', 'utf8')
    for (const index of [-3, 1.5, '50', null, 1e100]) appendJsonLine(logPath(), historical(index))
    appendJsonLine(logPath(), historical(2))
    expect(record().attempt_index).toBe(7)
  })

  it('历史读取失败时保留收口遥测，但不把未知序号记录为首次；下次可重新恢复', () => {
    appendJsonLine(logPath(), historical(4))
    vi.mocked(fs.readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    expect(record()).toMatchObject({ final_outcome: 'inconclusive', phase: 'desktop-implement' })
    const lines = fs.readFileSync(logPath(), 'utf8').trim().split('\n')
    expect(JSON.parse(lines.at(-1)!).payload).not.toHaveProperty('attempt_index')
    expect(record().attempt_index).toBe(5)
  })
})

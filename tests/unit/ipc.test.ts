import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../main/ipc'
import { createProject } from '../../main/project-service'
import { resetSDKQueryForTests, setSDKQueryForTests } from '../../main/orchestrator'
import type { SDKQuery } from '../../main/orchestrator'
import { IPC_CHANNELS } from '../../shared/types'

/**
 * A2-14b — ipc.ts:133 确认草图→runMvpTask 的 query 透传。
 *
 * 锁定「确认草图（accepted）后由 main 侧直连 MVP 生成」时，经 getSdkQuery()
 * 取得现成 SDKQuery 句柄并透传入 runMvpTask（而非跳过 LLM 路径走模板）。
 */

const { runMvpTaskMock, runIterationTaskMock } = vi.hoisted(() => ({
  runMvpTaskMock: vi.fn(async () => ({ preview_url: 'http://localhost:1' })),
  runIterationTaskMock: vi.fn(async () => ({ preview_url: 'http://localhost:1' })),
}))

vi.mock('../../main/programming-orchestrator', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/programming-orchestrator')>()
  return {
    ...actual,
    runMvpTask: runMvpTaskMock,
    runPostMvpTestingFlow: vi.fn(async () => ({})),
    runIterationTask: runIterationTaskMock,
  }
})

describe('ipc confirm-sketch → runMvpTask wiring (A2-14b)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetSDKQueryForTests()
    runMvpTaskMock.mockClear()
    runIterationTaskMock.mockClear()
  })

  it('确认草图（accepted）时把 query: getSdkQuery() 注入句柄透传给 runMvpTask', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ipc-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const sentinel: SDKQuery = async function* () {}
    setSDKQueryForTests(sentinel)

    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>()
    registerIpcHandlers(
      { handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as never,
      { webContents: { send: () => undefined } } as never,
    )

    const confirmSketch = handlers.get(IPC_CHANNELS.PROJECT_CONFIRM_SKETCH)
    expect(confirmSketch).toBeTruthy()
    await confirmSketch!({}, {
      request_id: 'req-cs',
      project_id: project.project_id,
      session_id: 'session-1',
      snapshot_id: 'snap-1',
      decision: 'accepted',
    })

    expect(runMvpTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: project.project_id,
        query: sentinel,
      }),
    )
  })
})

describe('ipc submit-correction → runIterationTask wiring（Sprint 3 纠错主线）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetSDKQueryForTests()
    runIterationTaskMock.mockClear()
  })

  it('点选纠错（带 user_note）落盘后触发带新需求的重新生成', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ipc-correction-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>()
    registerIpcHandlers(
      { handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as never,
      { webContents: { send: () => undefined } } as never,
    )

    const submitCorrection = handlers.get(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION)
    expect(submitCorrection).toBeTruthy()
    await submitCorrection!({}, {
      request_id: 'req-correction',
      project_id: project.project_id,
      session_id: 'session-1',
      context: { bounding_rect: { x: 0, y: 0, width: 0, height: 0 }, fallback_mode: false },
      user_note: '改成九个数字按键',
      mode: 'user_note',
    })

    expect(runIterationTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: project.project_id,
        prompt: '改成九个数字按键',
      }),
    )

    // 纠错原文按 user 角色回写会话 JSONL，历史对话不再出现"助手引用了用户没说过的话"的断层
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-1.jsonl'), 'utf8')
    expect(jsonl).toContain('改成九个数字按键')
  })

  it('纯猜模式（无文案）不触发重新生成，只落盘', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ipc-correction-guess-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })

    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>()
    registerIpcHandlers(
      { handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as never,
      { webContents: { send: () => undefined } } as never,
    )

    const submitCorrection = handlers.get(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION)
    await submitCorrection!({}, {
      request_id: 'req-correction',
      project_id: project.project_id,
      session_id: 'session-1',
      context: { bounding_rect: { x: 0, y: 0, width: 0, height: 0 }, fallback_mode: false },
      mode: 'guess',
    })

    expect(runIterationTaskMock).not.toHaveBeenCalled()
  })
})

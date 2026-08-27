import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerIpcHandlers } from '../../main/ipc'
import { createProject } from '../../main/project-service'
import { resetSDKQueryForTests, setSDKQueryForTests } from '../../main/orchestrator'
import type { SDKQuery } from '../../main/orchestrator'
import { getDocumentsDir } from '../../storage/config-paths'
import { IPC_CHANNELS } from '../../shared/types'

/** 预置「PRD 已被用户确认」状态：写带 user_confirmed_at 的 prd.json（不过目不开工防御的前置）。 */
function seedConfirmedPrd(projectId: string, confirmed = true): void {
  const dir = getDocumentsDir('default-software-builder', projectId)
  mkdirSync(dir, { recursive: true })
  const backplane = {
    project_id: projectId,
    name: '测试项目',
    positioning: '测试定位',
    requirements: [{ id: 'F-001', description: '核心功能', priority: 'P0', story: '作为用户…', assertions: [] }],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
    ...(confirmed ? { user_confirmed_at: '2026-08-27T02:00:00.000Z' } : {}),
  }
  writeFileSync(join(dir, 'prd.json'), JSON.stringify(backplane), 'utf8')
}

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
    runAgentLoopPostTesting: vi.fn(async () => ({})),
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

  it('点选纠错（带 user_note，PRD 已确认）落盘后触发带新需求的重新生成', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ipc-correction-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 「不过目不开工」（2026-08-27）：只有 PRD 已被用户确认过的项目，点选纠错才直达 MVP 迭代
    seedConfirmedPrd(project.project_id, true)

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

  it('PRD 未确认时点选纠错不触发 MVP 迭代，只落盘+引导完成确认（不过目不开工，2026-08-27）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-ipc-correction-unconfirmed-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    // 不预置 user_confirmed_at（prd.json 缺失 → fail-closed 视为未确认）

    const sentEvents: Array<{ type: string; payload: { text?: string } }> = []
    const handlers = new Map<string, (_event: unknown, payload: unknown) => unknown>()
    registerIpcHandlers(
      { handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) => handlers.set(channel, handler) } as never,
      { webContents: { send: (_: unknown, event: { type: string; payload: { text?: string } }) => sentEvents.push(event) } } as never,
    )

    const submitCorrection = handlers.get(IPC_CHANNELS.PROJECT_SUBMIT_CORRECTION)
    await submitCorrection!({}, {
      request_id: 'req-correction',
      project_id: project.project_id,
      session_id: 'session-1',
      context: { bounding_rect: { x: 0, y: 0, width: 0, height: 0 }, fallback_mode: false },
      user_note: '不要这个名字',
      mode: 'user_note',
    })

    // 未确认 → 不进入 MVP 全量重造，改引导回 PRD 确认流
    expect(runIterationTaskMock).not.toHaveBeenCalled()
    const guidance = sentEvents.find((event) => event.type === 'message_delta')?.payload.text
    expect(guidance).toContain('还没经你确认')
    // 纠错原文仍按 user 角色落盘（留痕不丢）
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-1.jsonl'), 'utf8')
    expect(jsonl).toContain('不要这个名字')
    expect(jsonl).toContain('还没经你确认')
  })
})

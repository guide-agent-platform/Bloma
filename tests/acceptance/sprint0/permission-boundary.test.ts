import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpcHarness } from '../support/ipc-harness'
import { IPC_CHANNELS, type ApiResult } from '../../../shared/types'
import {
  assertToolAllowed,
  canUseTool,
  clearPendingRequests,
  getPendingBySession,
  getPendingRequests,
  resolvePermission,
  setPermissionRequestPublisher,
} from '../../../main/permission-service'
import { runSketchTask, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject } from '../../../main/project-service'
import {
  clearSandboxRuntimeForTests,
  setSandboxRuntimeForTests,
  setSnapshotCaptureProviderForTests,
} from '../../../main/platform-services'

describe('Sprint 0 permission boundary acceptance', () => {
  afterEach(() => {
    clearPendingRequests()
    setPermissionRequestPublisher(() => undefined)
    setProgrammingEventPublisher(() => undefined)
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    if (originalPromaHome) process.env.PROMA_HOME = originalPromaHome
  })

  const originalPromaHome = process.env.PROMA_HOME

  it('[S0-PERM-001] warning 工具应发布请求、等待用户决定并在 resolve 后删除', async () => {
    const published: string[] = []
    setPermissionRequestPublisher((request) => published.push(request.id))

    const decision = canUseTool(
      'generate_sketch',
      { project_id: 'role-c-project' },
      'role-c-session',
      'ask',
      'role-c-project',
    )
    const pending = getPendingBySession('role-c-session')

    expect(pending).toHaveLength(1)
    expect(published).toEqual([pending[0]!.id])
    resolvePermission({
      request_id: 'role-c-permission',
      permission_request_id: pending[0]!.id,
      session_id: 'role-c-session',
      decision: 'allow',
    })

    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    expect(getPendingRequests()).toEqual([])
  })

  it('[S0-PERM-002] 不同 session 的权限请求不得互相解析', async () => {
    const firstDecision = canUseTool('Write', { file_path: 'a.ts' }, 'session-a', 'ask')
    void canUseTool('Write', { file_path: 'b.ts' }, 'session-b', 'ask')
    const first = getPendingBySession('session-a')[0]!

    expect(() => resolvePermission({
      request_id: 'role-c-wrong-session',
      permission_request_id: first.id,
      session_id: 'session-b',
      decision: 'allow',
    })).toThrow('PERMISSION_REQUEST_NOT_FOUND')
    expect(getPendingBySession('session-a')).toHaveLength(1)
    expect(getPendingBySession('session-b')).toHaveLength(1)

    resolvePermission({
      request_id: 'role-c-correct-session',
      permission_request_id: first.id,
      session_id: 'session-a',
      decision: 'deny',
    })
    await expect(firstDecision).resolves.toEqual({ behavior: 'deny' })
  })

  it('[S0-PERM-003] 生产接线：SNAPSHOT_ROLLBACK IPC 通道在 ask 模式下必须用户确认', async () => {
    const harness = createIpcHarness()
    const pending = harness.invoke(IPC_CHANNELS.SNAPSHOT_ROLLBACK, {
      request_id: 'role-c-rollback',
      project_id: 'prod-project',
      snapshot_id: 'snap-1',
      reason: '回归测试',
    })
    const requests = getPendingRequests()

    // 危险回滚操作被门禁挂起，等待用户决策
    expect(requests).toHaveLength(1)
    expect(requests[0]?.tool_name).toBe('rollback_snapshot')
    expect(requests[0]?.danger_level).toBe('dangerous')
    // renderer 侧收到 permission_requested 事件（B 的权限对话框 UI 消费）
    expect(harness.events.some((event) => event.type === 'permission_requested')).toBe(true)

    resolvePermission({
      request_id: 'role-c-rollback',
      permission_request_id: requests[0]!.id,
      session_id: requests[0]!.session_id,
      decision: 'deny',
    })

    const response = (await pending) as ApiResult<unknown>
    expect(response.ok).toBe(false)
    if (response.ok) throw new Error('SNAPSHOT_ROLLBACK should have been denied')
    expect(response.error.code).toBe('PERMISSION_DENIED')
    expect(response.error.user_visible_message).toBe('这个操作已取消，当前内容不会被改动。')
    expect(JSON.stringify(response)).not.toMatch(/node_modules|Error:|at /)
  })

  it('[S0-PERM-004] safe 模式拒绝危险工具（回滚）', async () => {
    const result = await canUseTool('rollback_snapshot', { project_id: 'p-safe' }, 's-safe', 'safe')

    expect(result).toEqual({ behavior: 'deny' })
    await expect(
      assertToolAllowed('rollback_snapshot', { project_id: 'p-safe' }, 's-safe', 'safe'),
    ).rejects.toThrow('PERMISSION_DENIED:rollback_snapshot')
  })

  it('[S0-PERM-005] 无人值守自动化路径不弹 UI 即完成自动快照', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-perm-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-proj', mode: 'quick' })
    setSandboxRuntimeForTests({
      portAllocator: async () => 3200,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))
    setPermissionRequestPublisher(() => events.push('permission_requested'))

    const result = await runSketchTask({
      request_id: 'req-task',
      session_id: 'session-1',
      project_id: project.project_id,
      mode: 'quick',
      prompt: '做一个家庭记账工具',
    })

    expect(result.preview_url).toBe('http://localhost:3200')
    // 自动化路径显式豁免：不产生待确认请求、不弹权限 UI
    expect(getPendingRequests()).toEqual([])
    expect(events).not.toContain('permission_requested')
    expect(result.snapshot.snapshot_id).toBeTruthy()
  })

  it('[S0-PERM-006] allow-all 模式下 warning 工具直接放行、不产生待确认请求', async () => {
    const result = await canUseTool(
      'generate_sketch',
      { project_id: 'p-allow-all' },
      's-allow-all',
      'allow-all',
      'p-allow-all',
    )

    // 契约（@S3-JUDGE-009 / F8）：allow-all = 除 dangerous 外全部自动放行
    expect(result).toEqual({ behavior: 'allow' })
    expect(getPendingBySession('s-allow-all')).toEqual([])
  })

  it('[S0-PERM-007] allow-all 模式下 dangerous 工具仍须用户确认（不自动放行/拒绝）', async () => {
    const decision = canUseTool(
      'rollback_snapshot',
      { project_id: 'p-allow-all', snapshot_id: 'snap-1' },
      's-allow-all-d',
      'allow-all',
      'p-allow-all',
    )
    const pending = getPendingBySession('s-allow-all-d')

    // 契约（@S3-JUDGE-009 / F8）：dangerous 与模式无关，必须人工确认——
    // 落 pendingRequests 等用户决策，绝不自动放行/拒绝
    expect(pending).toHaveLength(1)
    expect(pending[0]?.danger_level).toBe('dangerous')

    resolvePermission({
      request_id: 's0-perm-007-resolve',
      permission_request_id: pending[0]!.id,
      session_id: 's-allow-all-d',
      decision: 'allow',
    })
    await expect(decision).resolves.toEqual({ behavior: 'allow' })
    expect(getPendingRequests()).toEqual([])
  })
})

function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 1000 })
  return emitter
}

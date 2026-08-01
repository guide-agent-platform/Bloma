import { afterEach, describe, expect, it } from 'vitest'
import {
  canUseTool,
  clearPendingRequests,
  getPendingBySession,
  getPendingRequests,
  resolvePermission,
  setPermissionRequestPublisher,
} from '../../../main/permission-service'

describe('Sprint 0 permission boundary acceptance', () => {
  afterEach(() => {
    clearPendingRequests()
    setPermissionRequestPublisher(() => undefined)
  })

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
})

import { afterEach, describe, expect, it } from 'vitest'
import {
  canUseTool,
  clearPendingRequests,
  getPendingBySession,
  getPermissionMode,
  resolvePermission,
  setPermissionMode,
} from '../../main/permission-service'
import type { PromaPermissionMode } from '../../shared/types'

describe('PermissionService', () => {
  afterEach(() => {
    clearPendingRequests()
  })

  it('allows read-only tools without UI confirmation', async () => {
    await expect(canUseTool('Read', { file_path: 'README.md' }, 's1', 'ask')).resolves.toEqual({ behavior: 'allow' })
  })

  it('denies write tools in safe mode', async () => {
    await expect(canUseTool('Write', { file_path: 'app.ts' }, 's1', 'safe')).resolves.toEqual({ behavior: 'deny' })
  })

  it('queues warning tools in ask mode until UI allows them', async () => {
    const promise = canUseTool('Write', { file_path: 'app.ts' }, 's1', 'ask')
    const pending = getPendingBySession('s1')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.danger_level).toBe('warning')

    resolvePermission({
      request_id: 'req-1',
      permission_request_id: pending[0]!.id,
      session_id: 's1',
      decision: 'allow',
    })

    await expect(promise).resolves.toEqual({ behavior: 'allow' })
  })

  it('queues dangerous tools in ask mode until UI denies them', async () => {
    const promise = canUseTool('rollback_snapshot', { project_id: 'p1' }, 's1', 'ask')
    const pending = getPendingBySession('s1')

    expect(pending).toHaveLength(1)
    expect(pending[0]?.danger_level).toBe('dangerous')

    resolvePermission({
      request_id: 'req-2',
      permission_request_id: pending[0]!.id,
      session_id: 's1',
      decision: 'deny',
    })

    await expect(promise).resolves.toEqual({ behavior: 'deny' })
  })

  it('keeps pending requests isolated by session', () => {
    void canUseTool('Write', { file_path: 'a.ts' }, 's1', 'ask')
    void canUseTool('Write', { file_path: 'b.ts' }, 's2', 'ask')

    expect(getPendingBySession('s1')).toHaveLength(1)
    expect(getPendingBySession('s2')).toHaveLength(1)
    expect(getPendingBySession('missing')).toHaveLength(0)
  })
})

describe('PermissionService · 全局权限模式', () => {
  afterEach(() => {
    // 恢复默认 ask，避免污染其它测试对 enforcement 默认值的预期
    setPermissionMode('ask')
  })

  it('defaults to ask', () => {
    expect(getPermissionMode()).toBe('ask')
  })

  it('sets and returns a valid mode', () => {
    expect(setPermissionMode('allow-all')).toBe('allow-all')
    expect(getPermissionMode()).toBe('allow-all')
    expect(setPermissionMode('safe')).toBe('safe')
    expect(getPermissionMode()).toBe('safe')
  })

  it('rejects an invalid mode with VALIDATION_ERROR', () => {
    expect(() => setPermissionMode('bogus' as unknown as PromaPermissionMode)).toThrow(
      'VALIDATION_ERROR',
    )
  })
})

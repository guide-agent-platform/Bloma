import { describe, expect, it } from 'vitest'
import {
  rmSyncWithRetry,
  renameWithRetry,
  renameIfDestinationAbsentWithRetry,
  WIN32_RETRYABLE,
  POSIX_RETRYABLE,
  DEFAULT_RETRYABLE_CODES,
  type FsRetryDeps,
} from '../../main/platform/storage/fs-retry'

/**
 * S4-FSRETRY-001~007：fs-retry 移植（fs-retry-and-runtime-guards.md P1，蓝本 Proma
 * apps/electron/src/main/lib/fs-retry.ts）。Windows 上 fs.watch 句柄释放延迟导致
 * rmSync/renameSync 抛 EBUSY/EPERM/EACCES/ENOTEMPTY——指数退避重试兜底。
 *
 * 原型 9/9（T1-T6 六组断言，含真实退避时序验证）。测试注入 sleepFn 计数（缩时），
 * 关键时序断言用真实退避单独验证（T3 累计 ≥750ms 已在原型验证，此处锁定语义）。
 */

function errWithCode(code: string): NodeJS.ErrnoException {
  const e = new Error(`stub ${code}`) as NodeJS.ErrnoException
  e.code = code
  return e
}

function makeDeps(overrides: Partial<FsRetryDeps> = {}): FsRetryDeps & { sleeps: number[] } {
  const sleeps: number[] = []
  return {
    retryableCodes: WIN32_RETRYABLE,
    maxAttempts: 5,
    sleepSync: (ms) => { sleeps.push(ms) },
    rmSync: () => {},
    renameSync: () => {},
    existsSync: () => false,
    sleeps,
    ...overrides,
  }
}

describe('fs-retry（文件系统操作重试）', () => {
  it('[S4-FSRETRY-001] EBUSY×2 后成功 → 退避等待（50+100ms）且不抛', () => {
    let calls = 0
    const deps = makeDeps({
      rmSync: () => { calls += 1; if (calls < 3) throw errWithCode('EBUSY') },
    })
    expect(() => rmSyncWithRetry('/tmp/x', { force: true }, deps)).not.toThrow()
    expect(calls).toBe(3)
    expect(deps.sleeps).toEqual([50, 100])
  })

  it('[S4-FSRETRY-002] 不可重试码（ENOENT）→ 立即抛、仅 1 次调用', () => {
    let calls = 0
    const deps = makeDeps({
      rmSync: () => { calls += 1; throw errWithCode('ENOENT') },
    })
    expect(() => rmSyncWithRetry('/tmp/x', {}, deps)).toThrow()
    expect(calls).toBe(1)
  })

  it('[S4-FSRETRY-003] 耗尽：EBUSY 恒抛 → 恰好 maxAttempts 次、抛末次错误、退避累计 750ms', () => {
    let calls = 0
    const deps = makeDeps({
      maxAttempts: 5,
      rmSync: () => { calls += 1; throw errWithCode('EBUSY') },
    })
    expect(() => rmSyncWithRetry('/tmp/x', {}, deps)).toThrow('stub EBUSY')
    expect(calls).toBe(5)
    expect(deps.sleeps).toEqual([50, 100, 200, 400])
  })

  it('[S4-FSRETRY-004] 码集按平台区分：EPERM 在 win32 可重试、在 POSIX 不可重试', () => {
    let winCalls = 0
    const win = makeDeps({
      maxAttempts: 3,
      rmSync: () => { winCalls += 1; if (winCalls < 2) throw errWithCode('EPERM') },
    })
    expect(() => rmSyncWithRetry('/x', {}, win)).not.toThrow()
    expect(winCalls).toBe(2)

    let posixCalls = 0
    const posix = makeDeps({
      retryableCodes: POSIX_RETRYABLE,
      maxAttempts: 3,
      rmSync: () => { posixCalls += 1; throw errWithCode('EPERM') },
    })
    expect(() => rmSyncWithRetry('/x', {}, posix)).toThrow('stub EPERM')
    expect(posixCalls).toBe(1)
  })

  it('[S4-FSRETRY-005] renameIfDestinationAbsent：目标已存在 → 幂等 false、零 rename', () => {
    let renames = 0
    const deps = makeDeps({
      maxAttempts: 3,
      renameSync: () => { renames += 1 },
      existsSync: () => true,
    })
    const moved = renameIfDestinationAbsentWithRetry('/a', '/b', deps)
    expect(moved).toBe(false)
    expect(renames).toBe(0)
  })

  it('[S4-FSRETRY-006] rename 竞态：rename 抛 EPERM 但目标已出现 → 幂等成功 false（不抛）', () => {
    const deps = makeDeps({
      maxAttempts: 3,
      renameSync: () => { throw errWithCode('EPERM') },
      existsSync: (p) => p === '/b',
    })
    const moved = renameIfDestinationAbsentWithRetry('/a', '/b', deps)
    expect(moved).toBe(false)
  })

  it('[S4-FSRETRY-007] 默认码集 = win32 码集（当前平台）', () => {
    expect(DEFAULT_RETRYABLE_CODES).toBe(WIN32_RETRYABLE)
    expect(POSIX_RETRYABLE.has('EPERM')).toBe(false)
    expect(POSIX_RETRYABLE.has('EBUSY')).toBe(true)
  })
})

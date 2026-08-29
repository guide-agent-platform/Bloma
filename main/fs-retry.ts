// ============================================================
// 文件系统操作重试（fs-retry）— 从 Proma v0.18.2 移植
// 来源：Proma apps/electron/src/main/lib/fs-retry.ts（152 行）
// 蓝本提交：92a635fa（2026-08-26）；移植日期：2026-08-27
// 增强方案：.context/enhancements/fs-retry-and-runtime-guards.md（P1）
//
// 问题：Windows 上 fs.watch 递归监听句柄释放有毫秒级延迟，rmSync/renameSync
// 抛 EBUSY/EPERM/EACCES/ENOTEMPTY；Bloma 大量同步 fs 操作（项目目录、会话
// JSONL、沙箱清理）此前仅 ipc.ts 一处点修。本模块提供指数退避重试兜底。
//
// 平台语义：win32 可重试 {EBUSY,EPERM,EACCES,ENOTEMPTY}；POSIX 仅 {EBUSY,ENOTEMPTY}
// （EPERM/EACCES 在 POSIX 是真实权限拒绝，不应重试掩盖）。
// ============================================================

import { rmSync, renameSync, existsSync, type RmOptions } from 'node:fs'

/** win32 可重试码集（fs.watch 句柄释放竞争） */
export const WIN32_RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

/** POSIX 可重试码集（EPERM/EACCES 在 POSIX 是真实权限拒绝，不重试） */
export const POSIX_RETRYABLE = new Set(['EBUSY', 'ENOTEMPTY'])

/** 默认码集：按当前平台静态选择（测试可注入对照两套） */
export const DEFAULT_RETRYABLE_CODES = process.platform === 'win32' ? WIN32_RETRYABLE : POSIX_RETRYABLE

export interface FsRetryDeps {
  retryableCodes: Set<string>
  maxAttempts: number
  sleepSync: (ms: number) => void
  rmSync: (target: string, options: RmOptions) => void
  renameSync: (src: string, dest: string) => void
  existsSync: (p: string) => boolean
}

/** 真实 sleepSync：Atomics.wait 不占 CPU（对齐 Proma 语义） */
function realSleepSync(ms: number): void {
  const buf = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buf), 0, 0, ms)
}

const DEFAULT_DEPS: FsRetryDeps = {
  retryableCodes: DEFAULT_RETRYABLE_CODES,
  maxAttempts: 5,
  sleepSync: realSleepSync,
  rmSync,
  renameSync,
  existsSync,
}

/** 指数退避重试（50/100/200/400ms，累计 ≤750ms；不可重试码立即抛） */
function withRetry(deps: FsRetryDeps, op: () => void): void {
  let lastErr: unknown
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    try {
      op()
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException)?.code
      if (!code || !deps.retryableCodes.has(code)) throw err
      if (attempt === deps.maxAttempts) break
      deps.sleepSync(50 * 2 ** (attempt - 1))
    }
  }
  throw lastErr
}

export function rmSyncWithRetry(target: string, options: RmOptions = { recursive: true, force: true }, deps: FsRetryDeps = DEFAULT_DEPS): void {
  withRetry(deps, () => deps.rmSync(target, options))
}

export function renameWithRetry(src: string, dest: string, deps: FsRetryDeps = DEFAULT_DEPS): void {
  withRetry(deps, () => deps.renameSync(src, dest))
}

/**
 * 幂等 rename：目标已存在视为成功（崩溃恢复/JSONL 轮转原子性保障）。
 * rename 抛 EPERM/EEXIST/ENOTEMPTY 但目标已出现 → 幂等成功返回 false。
 */
export function renameIfDestinationAbsentWithRetry(src: string, dest: string, deps: FsRetryDeps = DEFAULT_DEPS): boolean {
  if (deps.existsSync(dest)) return false
  try {
    withRetry(deps, () => deps.renameSync(src, dest))
    return true
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'EPERM') {
      if (deps.existsSync(dest)) return false // 竞态中目标已被占 → 幂等成功
    }
    throw err
  }
}

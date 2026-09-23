// Renderer-Crash-Guard v2（r59 方向 A 原型 + r60 三厂商审计修正，2026-08-29 移植转正）
// 信源：enhancements/prototype/renderer-crash-guard-prototype.ts v2（25/25）→ 本文件为纯状态机模块
// （原型内嵌测试已转正为 tests/unit/renderer-crash-guard.test.ts，S4-AGENT-075~082）。
// 审计修正三件套：① reason 白名单进状态机 ② 按 webContents 隔离状态 ③ 副作用全 try/catch + dedup 入日志。
// 接线：main/index.ts render-process-gone（原仅 showErrorBox 死路）。

import { appendFileSync } from 'node:fs'

// ── 1. 限流策略（Proma 蓝本语义 + 加固）───────────────────────
export const RECOVERY_WINDOW_MS = 30_000
export const MAX_RECOVERY_ATTEMPTS = 2
const DEDUP_MS = 500
/** 仅明确崩溃信号可自动恢复（Electron reason 枚举）；clean-exit=正常退出、killed=用户杀进程、
 *  launch-failed=reload 无济于事、integrity-failure=需重装——一律不触发恢复/弹框/崩溃日志 */
export const RECOVERABLE_REASONS = new Set(['crashed', 'oom', 'abnormal-exit'])

export function isFiniteMs(t: number): boolean {
  return Number.isFinite(t) && t >= 0
}

export function canRecoverRenderer(attempts: number[], now: number): boolean {
  if (!isFiniteMs(now)) return false
  const recent = attempts.filter((a) => isFiniteMs(a) && now - a < RECOVERY_WINDOW_MS && now - a >= 0)
  return recent.length < MAX_RECOVERY_ATTEMPTS
}

// ── 2. 崩溃日志（JSONL 追加；写入失败不得中断 handler）──────────
export interface CrashRecord {
  ts: number
  wc: string
  reason: string
  exitCode: number | null
  attempt: number
  action: 'reload' | 'give-up' | 'dedup'
}

export function appendCrashLog(logPath: string, r: CrashRecord): boolean {
  try {
    appendFileSync(logPath, JSON.stringify(r) + '\n', 'utf-8')
    return true
  } catch {
    // 审查加固（zhipu P2）：磁盘满等场景不静默全丢——主进程日志留痕；仍不抛（handler 禁抛）
    console.warn('[crash-guard] crash log write failed:', logPath)
    return false
  }
}

// ── 3. 恢复流（按 webContents 隔离的状态机；副作用全防护）──────────
export interface RecoveryState {
  attempts: number[]
  lastGoneAt: number | null
}

export type RecoveryAction =
  | { kind: 'reload'; attempt: number }
  | { kind: 'give-up'; attempt: number }
  | { kind: 'ignored-duplicate' }
  | { kind: 'ignored-non-crash' }

export interface CrashGuardHooks {
  reload: () => void
  showErrorBox: () => void
}

export function createCrashGuard(logPath: string) {
  // 边界（zhipu 审查 P2）：状态按实例隔离，限流额度不跨实例共享。当前应用单窗口、
  // createMainWindow 仅启动时调用一次；若未来多窗口/重建主窗口，应把 guard 提升为模块级单例。
  const states = new Map<string, RecoveryState>()
  function st(wc: string): RecoveryState {
    let s = states.get(wc)
    if (!s) {
      s = { attempts: [], lastGoneAt: null }
      states.set(wc, s)
    }
    return s
  }
  return {
    onGone(wc: string, now: number, reason: string, exitCode: number | null, hooks: CrashGuardHooks): RecoveryAction {
      if (!RECOVERABLE_REASONS.has(reason)) return { kind: 'ignored-non-crash' } // 审计①
      const s = st(wc)
      if (
        s.lastGoneAt !== null &&
        isFiniteMs(now) &&
        isFiniteMs(s.lastGoneAt) &&
        now - s.lastGoneAt < DEDUP_MS &&
        now - s.lastGoneAt >= 0
      ) {
        appendCrashLog(logPath, { ts: now, wc, reason, exitCode, attempt: -1, action: 'dedup' }) // 审计③ 去重也入日志
        return { kind: 'ignored-duplicate' }
      }
      s.lastGoneAt = now
      const attempt = s.attempts.filter((a) => isFiniteMs(a) && isFiniteMs(now) && now - a < RECOVERY_WINDOW_MS).length + 1
      const recoverable = canRecoverRenderer(s.attempts, now)
      const action: RecoveryAction = recoverable ? { kind: 'reload', attempt } : { kind: 'give-up', attempt }
      if (recoverable) {
        s.attempts.push(now)
        try {
          hooks.reload()
        } catch {
          try {
            hooks.showErrorBox()
          } catch {
            /* handler 禁抛 */
          }
        } // 审计③
      } else {
        try {
          hooks.showErrorBox()
        } catch {
          /* handler 禁抛 */
        }
      }
      appendCrashLog(logPath, { ts: now, wc, reason, exitCode, attempt, action: recoverable ? 'reload' : 'give-up' })
      if (s.attempts.length > MAX_RECOVERY_ATTEMPTS * 10) {
        s.attempts = s.attempts.filter((a) => isFiniteMs(now) && now - a < RECOVERY_WINDOW_MS)
      }
      return action
    },
  }
}

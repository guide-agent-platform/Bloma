import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { canRecoverRenderer, createCrashGuard } from '../../main/platform/shell/renderer-crash-guard'

/**
 * Renderer-Crash-Guard（v7 Top3，2026-08-29 移植转正）：
 * 渲染进程崩溃自动恢复状态机——reason 白名单（仅 crashed/oom/abnormal-exit 恢复）、
 * 30s 窗口至多 2 次自动 reload 限流、500ms 崩溃风暴去重（dedup 入日志）、
 * 多 webContents 状态隔离、副作用（reload/弹框/日志写）异常边界（handler 禁抛）。
 *
 * 信源：enhancements/prototype/renderer-crash-guard-prototype.ts v2（25/25，r60 三厂商审计修正）。
 * 接线点：main/index.ts render-process-gone（原仅 showErrorBox 死路）。
 */

describe('crash-guard 限流策略', () => {
  it('[S4-AGENT-075] 30s 窗口至多 2 次自动恢复：第 3 次拒绝，窗口滑出后重置', () => {
    expect(canRecoverRenderer([], 1000)).toBe(true)
    expect(canRecoverRenderer([500], 1000)).toBe(true)
    expect(canRecoverRenderer([500, 900], 1000)).toBe(false)
    // 窗口边界：29999 内计两次、30001 滑出重置
    expect(canRecoverRenderer([0, 1], 29_999)).toBe(false)
    expect(canRecoverRenderer([0, 1], 30_001)).toBe(true)
  })

  it('[S4-AGENT-076] 非法时间输入防御：NaN/负 now 不可恢复，NaN/未来 attempt 不计入', () => {
    expect(canRecoverRenderer([], NaN)).toBe(false)
    expect(canRecoverRenderer([], -5)).toBe(false)
    expect(canRecoverRenderer([NaN, NaN, 5000], 1000)).toBe(true)
  })
})

describe('crash-guard 状态机（真实 JSONL 日志回环）', () => {
  let tmp: string
  let logPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crash-guard-unit-'))
    logPath = join(tmp, 'crashes.jsonl')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  function logLines(): Array<Record<string, unknown>> {
    try {
      return readFileSync(logPath, 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    } catch {
      return [] // 白名单路径不产生日志文件（077 断言依赖此语义）
    }
  }

  it('[S4-AGENT-077] reason 白名单：clean-exit/killed/launch-failed 全静默忽略（无恢复/弹框/日志）', () => {
    const g = createCrashGuard(logPath)
    const reload = vi.fn()
    const showErrorBox = vi.fn()
    const hooks = { reload, showErrorBox }

    expect(g.onGone('main', 0, 'clean-exit', 0, hooks).kind).toBe('ignored-non-crash')
    expect(g.onGone('main', 1000, 'killed', 137, hooks).kind).toBe('ignored-non-crash')
    expect(g.onGone('main', 2000, 'launch-failed', null, hooks).kind).toBe('ignored-non-crash')
    expect(reload).not.toHaveBeenCalled()
    expect(showErrorBox).not.toHaveBeenCalled()
    expect(logLines()).toEqual([])
  })

  it('[S4-AGENT-078] 连续三崩：reload #1 → reload #2 → give-up 弹框（日志动作序列对账）', () => {
    const g = createCrashGuard(logPath)
    const reload = vi.fn()
    const showErrorBox = vi.fn()
    const hooks = { reload, showErrorBox }

    expect(g.onGone('main', 0, 'crashed', 10, hooks).kind).toBe('reload')
    expect(g.onGone('main', 1000, 'oom', null, hooks).kind).toBe('reload')
    expect(g.onGone('main', 2000, 'abnormal-exit', 3, hooks).kind).toBe('give-up')
    expect(reload).toHaveBeenCalledTimes(2)
    expect(showErrorBox).toHaveBeenCalledTimes(1)

    const recs = logLines()
    expect(recs.map((r) => r.action)).toEqual(['reload', 'reload', 'give-up'])
    expect(recs[2]).toMatchObject({ wc: 'main', reason: 'abnormal-exit', exitCode: 3 })
  })

  it('[S4-AGENT-079] 多 webContents 隔离：main 额度耗尽时 devtools 仍独立可恢复，日志按 wc 归因', () => {
    const g = createCrashGuard(logPath)
    const reload = vi.fn()
    const hooks = { reload, showErrorBox: vi.fn() }

    g.onGone('main', 0, 'crashed', 1, hooks)
    g.onGone('main', 1000, 'crashed', 1, hooks)
    expect(g.onGone('devtools', 2000, 'crashed', 1, hooks).kind).toBe('reload')
    expect(g.onGone('main', 3000, 'crashed', 1, hooks).kind).toBe('give-up')
    expect(logLines().some((r) => r.wc === 'devtools')).toBe(true)
  })

  it('[S4-AGENT-080] 500ms 崩溃风暴去重：不重复恢复但 dedup 入日志（防无日志死屏）', () => {
    const g = createCrashGuard(logPath)
    const reload = vi.fn()
    const hooks = { reload, showErrorBox: vi.fn() }

    g.onGone('main', 0, 'crashed', 5, hooks)
    expect(g.onGone('main', 300, 'crashed', 5, hooks).kind).toBe('ignored-duplicate')
    expect(reload).toHaveBeenCalledTimes(1)
    const recs = logLines()
    expect(recs).toHaveLength(2)
    expect(recs[1].action).toBe('dedup')
  })

  it('[S4-AGENT-081] 窗口滑出重置：t=60s 崩溃可再次自动恢复（限速循环语义）', () => {
    const g = createCrashGuard(logPath)
    const reload = vi.fn()
    const hooks = { reload, showErrorBox: vi.fn() }

    g.onGone('main', 0, 'crashed', 5, hooks)
    g.onGone('main', 10_000, 'oom', null, hooks)
    expect(g.onGone('main', 20_000, 'oom', null, hooks).kind).toBe('give-up')
    expect(g.onGone('main', 60_000, 'crashed', 5, hooks).kind).toBe('reload')
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('[S4-AGENT-082] 副作用异常边界：reload 抛错降级弹框、弹框/日志再抛也被吞（handler 禁抛）', () => {
    // 日志路径必失败（不存在的目录）验证写失败不中断
    const g = createCrashGuard(join(tmp, 'no-dir', 'x', 'crash.jsonl'))
    const hooks = {
      reload: () => {
        throw new Error('webContents destroyed')
      },
      showErrorBox: () => {
        throw new Error('dialog failed')
      },
    }

    expect(() => {
      expect(g.onGone('main', 0, 'crashed', 1, hooks).kind).toBe('reload')
      expect(g.onGone('main', 1000, 'crashed', 1, hooks).kind).toBe('reload')
      expect(g.onGone('main', 2000, 'crashed', 1, hooks).kind).toBe('give-up')
    }).not.toThrow()
  })
})

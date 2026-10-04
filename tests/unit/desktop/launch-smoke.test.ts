/**
 * launch-smoke 单测（2026-10-04 呈现层收口）：声明解析 + 冒烟编排（spawn/capture 注入）。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseLaunchDeclaration, runLaunchSmoke, LAUNCH_RELATIVE_PATH } from '../../../main/desktop/launch-smoke'
import type { ChildProcess } from 'node:child_process'

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4321
  killed = false
  kill(): boolean {
    this.killed = true
    return true
  }
}

function makeRoot(declaration?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'bloma-smoke-'))
  if (declaration !== undefined) writeFileSync(join(root, LAUNCH_RELATIVE_PATH), declaration, 'utf8')
  return root
}

describe('parseLaunchDeclaration', () => {
  it('合法声明：command 数组 + 可选 window_title', () => {
    const parsed = parseLaunchDeclaration('{"schema_version":1,"command":["python","app.py"],"window_title":"计算器"}')
    expect(parsed).toEqual({ ok: true, launch: { command: ['python', 'app.py'], window_title: '计算器' } })
  })
  it('schema_version 非 1 / command 空数组 / window_title 非串 → 拒绝', () => {
    expect(parseLaunchDeclaration('{"schema_version":2,"command":["a"]}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('{"schema_version":1,"command":[]}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('{"schema_version":1,"command":["a"],"window_title":5}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('not-json')).toMatchObject({ ok: false })
  })
})

describe('runLaunchSmoke（注入编排）', () => {
  it('缺少 LAUNCH.json → 不通过且指明缺口', async () => {
    const root = makeRoot()
    const result = await runLaunchSmoke(root, { spawnImpl: () => { throw new Error('不应 spawn') } })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('LAUNCH.json')
  })

  it('黑名单命令 → 安全拦截不 spawn', async () => {
    const root = makeRoot('{"schema_version":1,"command":["cmd","/c","del","/s","C:\\\\"]}')
    const result = await runLaunchSmoke(root, { spawnImpl: () => { throw new Error('不应 spawn') } })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('安全拦截')
  })

  it('宽限期内退出（启动即崩，退出码 1）→ 不通过 + stderr 尾部回传', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const child = new FakeChild()
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => {
        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('Traceback: TclError: bad screen distance'))
          child.exitCode = 1
          child.emit('exit', 1)
        }, 10)
        return child as unknown as ChildProcess
      },
      graceMs: 2000,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('退出码 1')
    expect(result.outputExcerpt).toContain('TclError')
  })

  it('spawn 异步错误（ENOENT）→ 不通过且不崩（未处理 error 事件曾会让主进程炸）', async () => {
    const root = makeRoot('{"schema_version":1,"command":["no-such-interp","app.py"]}')
    const child = new FakeChild()
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => {
        setTimeout(() => child.emit('error', new Error('spawn no-such-interp ENOENT')), 5)
        return child as unknown as ChildProcess
      },
      graceMs: 2000,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('ENOENT')
  })

  it('存活 → 截图落 00_VERIFY/screenshots/LAUNCH.png → kill → 通过', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"],"window_title":"计算器"}')
    const child = new FakeChild()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => child as unknown as ChildProcess,
      captureWindow: async (titleHint) => {
        expect(titleHint).toBe('计算器')
        return png
      },
      graceMs: 50,
    })
    expect(result.passed).toBe(true)
    expect(result.screenshotRel).toBe('00_VERIFY/screenshots/LAUNCH.png')
    expect(child.killed).toBe(true)
    expect(readFileSync(join(root, '00_VERIFY', 'screenshots', 'LAUNCH.png'))).toEqual(png)
  })

  it('存活但截图失败/无匹配窗口 → 仍通过（截图是证据不是门）', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const child = new FakeChild()
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => child as unknown as ChildProcess,
      captureWindow: async () => null,
      graceMs: 50,
    })
    expect(result.passed).toBe(true)
    expect(result.screenshotRel).toBeUndefined()
    expect(child.killed).toBe(true)
  })
})

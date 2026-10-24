/**
 * launch-smoke 单测（2026-10-04 呈现层收口）：声明解析 + 冒烟编排（spawn/capture 注入）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it } from 'vitest'
import { parseLaunchDeclaration, parseProbeJson, runLaunchSmoke, LAUNCH_RELATIVE_PATH, type LaunchProbeCriteria, type ProbeRunInput } from '../../../main/desktop/launch-smoke'
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
  it('未知schema_version / command 空数组 / window_title 非串 → 拒绝', () => {
    expect(parseLaunchDeclaration('{"schema_version":3,"command":["a"]}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('{"schema_version":1,"command":[]}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('{"schema_version":1,"command":["a"],"window_title":5}')).toMatchObject({ ok: false })
    expect(parseLaunchDeclaration('not-json')).toMatchObject({ ok: false })
  })
})

describe('runLaunchSmoke（注入编排）', () => {
  it('does not launch after cancellation', async () => {
    const controller = new AbortController(); controller.abort()
    await expect(runLaunchSmoke(makeRoot(), { signal: controller.signal, spawnImpl: () => { throw Error('must not spawn') } })).rejects.toThrow()
  })

  it('isolates startup data and cleans up even when capture throws', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const child = new FakeChild()
    let data = ''
    await runLaunchSmoke(root, { graceMs: 1, spawnImpl: (_command, _cwd, env) => {
      data = env!.APP_DATA_DIR!
      expect(data).not.toContain(root)
      mkdirSync(data, { recursive: true }); writeFileSync(join(data, 'test.json'), '{}')
      return child as unknown as ChildProcess
    }, captureWindow: async () => { throw Error('capture failed') } })
    expect(child.killed).toBe(true)
    expect(existsSync(data)).toBe(false)
  })

  it('cancels during capture without saving late evidence or leaving the child alive', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const child = new FakeChild(), controller = new AbortController()
    await expect(runLaunchSmoke(root, { signal: controller.signal, graceMs: 1,
      spawnImpl: () => child as unknown as ChildProcess, captureWindow: async () => {
        controller.abort(); return Buffer.from('late screenshot')
      } })).rejects.toThrow()
    expect(child.killed).toBe(true)
    expect(existsSync(join(root, '00_VERIFY/screenshots/LAUNCH.png'))).toBe(false)
  })

  it('uses the project virtual environment for a bare Python declaration, preserving the declared arguments', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const python = process.platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python')
    mkdirSync(join(root, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin'), { recursive: true }); writeFileSync(python, '')
    let used: string[] = []
    const result = await runLaunchSmoke(root, { graceMs: 5, spawnImpl: command => { used = command; return new FakeChild() as unknown as ChildProcess } })
    expect(result.passed).toBe(true)
    expect(used).toEqual([python, 'app.py'])
  })
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

  it('存活 → 截图落 00_VERIFY/screenshots/LAUNCH.png → kill → 通过（纯存活档：无 window_title 不走探针）', async () => {
    const root = makeRoot('{"schema_version":1,"command":["python","app.py"]}')
    const child = new FakeChild()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    let probeCalled = false
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => child as unknown as ChildProcess,
      captureWindow: async (titleHint) => {
        expect(titleHint).toBeUndefined()
        return png
      },
      probeImpl: async () => {
        probeCalled = true
        return { json: goodCriteria() }
      },
      graceMs: 50,
    })
    expect(result.passed).toBe(true)
    expect(result.screenshotRel).toBe('00_VERIFY/screenshots/LAUNCH.png')
    expect(probeCalled).toBe(false)
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

/** 全绿判据（探针成功档）。 */
function goodCriteria(overrides: Partial<LaunchProbeCriteria> = {}): LaunchProbeCriteria {
  return { window_found: true, responsive: true, stable: true, closed_gracefully: true, crash_dialog: [], screenshot: false, ...overrides }
}

describe('runLaunchSmoke 联合判定档（批1 2026-10-06：LAUNCH 带 window_title）', () => {
  const jointRoot = (): string => makeRoot('{"schema_version":1,"command":["python","app.py"],"window_title":"计算器"}')

  it('探针全绿 + 截图落 00_VERIFY/screenshots/LAUNCH.png → 通过，携带判据', async () => {
    const root = jointRoot()
    const child = new FakeChild()
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const result = await runLaunchSmoke(root, {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async (input: ProbeRunInput) => {
        expect(input.title).toBe('计算器')
        expect(input.pid).toBe(4321)
        writeFileSync(input.outPng, png)
        return { json: goodCriteria({ screenshot: true }) }
      },
      graceMs: 50,
    })
    expect(result.passed).toBe(true)
    expect(result.screenshotRel).toBe('00_VERIFY/screenshots/LAUNCH.png')
    expect(result.criteria).toMatchObject({ window_found: true, responsive: true, closed_gracefully: true })
    expect(result.detail).toContain('联合判定')
    expect(readFileSync(join(root, '00_VERIFY', 'screenshots', 'LAUNCH.png'))).toEqual(png)
  })

  it('探针判据 no_window（宽限期内无可见主窗口）→ 不通过 + 判据回传', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: goodCriteria({ window_found: false, fail_code: 'no_window', detail: '11000ms 内未找到属于进程 4321 的可见主窗口' }) }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('可见主窗口')
    expect(result.criteria?.fail_code).toBe('no_window')
    expect(result.outputExcerpt).toContain('未找到')
    expect(child.killed).toBe(true)
  })

  it('探针判据 unresponsive（消息循环无响应——弹幕单冻结 bug 形态）→ 不通过', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: goodCriteria({ responsive: false, fail_code: 'unresponsive', detail: '主窗口消息循环无响应' }) }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('消息循环无响应')
    expect(result.criteria?.fail_code).toBe('unresponsive')
  })

  it('探针判据 crash_dialog（启动期错误弹窗）→ 不通过且标题在详情里', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: goodCriteria({ fail_code: 'crash_dialog', crash_dialog: ['错误: 数据库初始化失败'], detail: '启动过程弹出错误对话框' }) }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('错误对话框')
    expect(result.detail).toContain('数据库初始化失败')
  })

  it('探针判据 wont_close（无法优雅关闭）→ 不通过', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: goodCriteria({ closed_gracefully: false, fail_code: 'wont_close', detail: 'WM_CLOSE 后 5000ms 进程仍未退出' }) }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('优雅关闭')
    expect(child.killed).toBe(true)
  })

  it('判据不全绿且探针未给 fail_code（防御）→ 不通过且按缺失面定位', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: goodCriteria({ stable: false }) }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.criteria?.fail_code).toBe('stable')
  })

  it('探针不可用（python 缺失/超时）→ 降级纯存活档通过，如实标注「未验证」', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => ({ json: null, error: '探针超时（27000ms 看门狗）' }),
      captureWindow: async () => null,
      graceMs: 50,
    })
    expect(result.passed).toBe(true)
    expect(result.detail).toContain('降级判定')
    expect(result.detail).toContain('仅验证进程存活')
    expect(result.criteria?.degraded).toBe(true)
    expect(child.killed).toBe(true)
  })

  it('accepts the observer confirming graceful closure after the product exits normally', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), { graceMs: 1,
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => {
        child.exitCode = 0; child.emit('exit', 0)
        await new Promise(resolve => setTimeout(resolve, 5))
        return { json: goodCriteria() }
      } })
    expect(result.passed).toBe(true)
    expect(result.criteria?.closed_gracefully).toBe(true)
  })

  it('does not treat unexplained exit 0 as a successful smoke check', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), { graceMs: 1,
      spawnImpl: () => child as unknown as ChildProcess,
      probeImpl: async () => {
        child.exitCode = 0; child.emit('exit', 0)
        await new Promise(resolve => setTimeout(resolve, 5))
        return { json: null, error: 'missing close observation' }
      } })
    expect(result.passed).toBe(false)
  })

  it('探针观察期内进程退出（宽限期后崩溃）→ 不通过，输出尾部即修复靶子', async () => {
    const child = new FakeChild()
    const result = await runLaunchSmoke(jointRoot(), {
      spawnImpl: () => {
        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('Traceback (most recent call last): TclError'))
          child.exitCode = 1
          child.emit('exit', 1)
        }, 60)
        return child as unknown as ChildProcess
      },
      probeImpl: () => new Promise(() => { /* 永不 resolve——退出先赢 */ }),
      graceMs: 50,
    })
    expect(result.passed).toBe(false)
    expect(result.detail).toContain('观察期内退出')
    expect(result.outputExcerpt).toContain('TclError')
  })
})

describe('parseProbeJson（探针输出解析）', () => {
  it('末行 JSON 判据解析；形状不全返回 null（降级档入口）', () => {
    expect(parseProbeJson('噪音行\n{"window_found":true,"responsive":true,"stable":true,"closed_gracefully":true,"crash_dialog":[],"screenshot":true}')).toMatchObject({ window_found: true, screenshot: true })
    expect(parseProbeJson('{"window_found":true}')).toBeNull()
    expect(parseProbeJson('')).toBeNull()
    expect(parseProbeJson('not json at all')).toBeNull()
  })
})

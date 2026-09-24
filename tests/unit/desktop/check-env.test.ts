/**
 * 桌面环境探测器测试（批次 B，2026-09-24）——注入式零真实子进程。
 *
 * 覆盖：三分类（not-found/timeout/exec-failed）、版本解析（stdout/stderr 两路/
 * 无版本概念探测）、顺序执行序、isDesktopEnvReady 判定、探测项覆盖面。
 */
import { describe, expect, it } from 'vitest'
import {
  PROBE_INTERPRETER,
  PROBE_TIMEOUT_MS,
  ProbeError,
  probeDesktopEnv,
  isDesktopEnvReady,
  type ProbeSpawn,
} from '../../../main/desktop/check-env'

/** 桩构造：按命令序回放结果/异常。 */
function stubSpawn(
  script: Array<{ code: number; stdout: string; stderr?: string } | ProbeError>,
): ProbeSpawn & { calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> } {
  const calls: Array<{ command: string; args: readonly string[]; timeoutMs: number }> = []
  let index = 0
  const fn = async (command: string, args: readonly string[], timeoutMs: number) => {
    calls.push({ command, args, timeoutMs })
    const step = script[Math.min(index, script.length - 1)]
    index += 1
    if (step instanceof ProbeError) throw step
    return { code: step.code, stdout: step.stdout, stderr: step.stderr ?? '' }
  }
  return Object.assign(fn, { calls })
}

describe('probeDesktopEnv 探测执行', () => {
  it('全就绪：三项 ok，python/pyinstaller 版本解析，venv 无版本概念', async () => {
    const spawn = stubSpawn([
      { code: 0, stdout: 'Python 3.13.7' },
      { code: 0, stdout: '' }, // import venv 成功无输出
      { code: 0, stdout: '6.16.0' },
    ])
    const results = await probeDesktopEnv(spawn)
    expect(results.map((r) => r.id)).toEqual(['python', 'venv-module', 'pyinstaller'])
    expect(results[0]).toMatchObject({ status: 'ok', version: '3.13.7' })
    expect(results[1]).toMatchObject({ status: 'ok' })
    expect(results[1].version).toBeUndefined()
    expect(results[2]).toMatchObject({ status: 'ok', version: '6.16.0' })
    expect(isDesktopEnvReady(results)).toBe(true)
  })

  it('版本走 stderr 路也能解析（历史 python 形态兼容）', async () => {
    const spawn = stubSpawn([
      { code: 0, stdout: '', stderr: 'Python 3.9.13' },
      { code: 0, stdout: '' },
      { code: 0, stdout: '6.0.0' },
    ])
    const results = await probeDesktopEnv(spawn)
    expect(results[0].version).toBe('3.9.13')
  })

  it('python 不存在（ENOENT）→ not-found，后续项同样 not-found（缺解释器全链断）', async () => {
    const spawn = stubSpawn([
      new ProbeError('not-found', '命令不存在：python'),
      new ProbeError('not-found', '命令不存在：python'),
      new ProbeError('not-found', '命令不存在：python'),
    ])
    const results = await probeDesktopEnv(spawn)
    expect(results.every((r) => r.status === 'not-found')).toBe(true)
    expect(isDesktopEnvReady(results)).toBe(false)
    expect(results[0].detail).toContain('命令不存在')
  })

  it('探测超时 → timeout 分类', async () => {
    const spawn = stubSpawn([
      new ProbeError('timeout', '探测超时（>5000ms）：python'),
      { code: 0, stdout: '' },
      { code: 0, stdout: '6.0.0' },
    ])
    const results = await probeDesktopEnv(spawn)
    expect(results[0]).toMatchObject({ status: 'timeout' })
    expect(results[0].probeCommand).toBe('python --version')
  })

  it('非零退出 → exec-failed 且 detail 携带输出摘要', async () => {
    const spawn = stubSpawn([
      { code: 0, stdout: 'Python 3.13.7' },
      { code: 0, stdout: '' },
      { code: 1, stdout: '', stderr: 'No module named PyInstaller' },
    ])
    const results = await probeDesktopEnv(spawn)
    expect(results[2]).toMatchObject({ status: 'exec-failed' })
    expect(results[2].detail).toContain('No module named PyInstaller')
    expect(results[2].detail).toContain('退出码 1')
    expect(isDesktopEnvReady(results)).toBe(false)
  })

  it('未知异常兜底 exec-failed（不向上抛）', async () => {
    const boom = (async () => {
      throw new Error('EACCES: permission denied')
    })() as unknown
    const spawn = (() => boom) as unknown as ProbeSpawn
    const results = await probeDesktopEnv(spawn)
    expect(results[0].status).toBe('exec-failed')
    expect(results[0].detail).toContain('EACCES')
  })

  it('探测参数：解释器单一真源 python（禁 python3）、超时 5s、顺序注入', async () => {
    const spawn = stubSpawn([
      { code: 0, stdout: 'Python 3.13.7' },
      { code: 0, stdout: '' },
      { code: 0, stdout: '6.0.0' },
    ])
    await probeDesktopEnv(spawn)
    expect(PROBE_INTERPRETER).toBe('python')
    expect(PROBE_TIMEOUT_MS).toBe(5000)
    expect(spawn.calls).toHaveLength(3)
    expect(spawn.calls.every((c) => c.command === 'python' && c.timeoutMs === 5000)).toBe(true)
    expect(spawn.calls[1].args).toEqual(['-c', 'import venv'])
  })
})

describe('isDesktopEnvReady', () => {
  it('空结果视为未就绪（防误判）', () => {
    expect(isDesktopEnvReady([])).toBe(false)
  })
})

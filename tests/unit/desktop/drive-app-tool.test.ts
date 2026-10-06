/**
 * drive_project_app 工具测试（2026-10-05 探索驱动测试 A 档）。
 *
 * 覆盖：open（LAUNCH 缺省入口/ready 失败教育/trace 落盘）、act 批量 fail_fast、
 * op 超时 kill、op/会话双预算、report 落盘与校验、close 收尾、dispose 兜底清理、
 * harness 资产源码锁（spike 三假设的实现形态不被无意识删改）。
 *
 * spawn 全注入（零真实子进程，陷阱 35）；超时注入至毫秒级（不真等 10s）。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restorePromaHome } from '../../support/proma-home-guard'
import { buildDriveAppTool, disposeDriveSessions, type DriveHarnessProcess } from '../../../main/desktop/drive-app-tool'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { createProject } from '../../../main/project/project-service'

function ctxFor(projectId: string): ToolContext {
  return {
    projectId,
    sessionId: 'session-drive-app',
    requestId: 'req-drive-app',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

/** 假 harness 进程：stdin 收到一行即按脚本回一行（autoReady=spawn 后主动发 ready 行）。 */
function fakeHarness(options: {
  autoReady?: Record<string, unknown> | null
  respond?: (line: string, index: number) => Record<string, unknown> | null
}) {
  const written: string[] = []
  const stdout = new EventEmitter()
  const kill = vi.fn()
  const exitListeners: Array<(code: number | null) => void> = []
  const proc: DriveHarnessProcess = {
    stdin: {
      write: (chunk: string) => {
        const line = chunk.trim()
        if (!line) return
        written.push(line)
        const reply = options.respond?.(line, written.length - 1) ?? null
        if (reply) {
          queueMicrotask(() => stdout.emit('data', `${JSON.stringify(reply)}\n`))
        }
      },
    },
    stdout: stdout as unknown as DriveHarnessProcess['stdout'],
    kill: kill as unknown as DriveHarnessProcess['kill'],
    once: (event: 'exit', listener: (code: number | null) => void) => {
      exitListeners.push(listener)
    },
  }
  if (options.autoReady) {
    // 时序对齐：真实 harness 在 spawn 后、监听器挂上后才可能输出 ready——用 newListener
    // 钩子模拟（创建即发会被无监听的 EventEmitter 丢弃，全部 open 用例假红）。
    const ready = options.autoReady
    let readyEmitted = false
    stdout.on('newListener', (event: string) => {
      if (event === 'data' && !readyEmitted) {
        readyEmitted = true
        queueMicrotask(() => stdout.emit('data', `${JSON.stringify(ready)}\n`))
      }
    })
  }
  return {
    proc,
    written,
    kill,
    emitExit: (code: number | null) => exitListeners.forEach((listener) => listener(code)),
  }
}

const READY_OK: Record<string, unknown> = { ready: true, root_class: 'Tk', widgets_initial: 4, roots_all: 1, app_prints: '' }
const FAST_TIMEOUTS = { opTimeoutMs: 150, openTimeoutMs: 500, closeTimeoutMs: 150 }
const okPython = async () => 'C:/py/python.exe'

describe('drive_project_app（探索驱动测试 A 档）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let projectRoot: string
  let projectId: string

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-drive-app-'))
    const project = createProject({ request_id: 'req-drive-app-setup', mode: 'quick' })
    projectId = project.project_id
    projectRoot = project.root_path
    writeFileSync(join(projectRoot, '主程序.py'), '# 入口', 'utf8')
    writeFileSync(
      join(projectRoot, 'LAUNCH.json'),
      JSON.stringify({ schema_version: 1, command: ['python', '主程序.py'], window_title: '演示' }),
      'utf8',
    )
  })

  afterEach(() => {
    disposeDriveSessions()
    restorePromaHome(originalPromaHome)
  })

  it('open：LAUNCH 缺省入口 + spawn 命令形态 + ready + trace 落盘', async () => {
    const spawnCalls: string[][] = []
    const harness = fakeHarness({ autoReady: READY_OK })
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: (command) => {
        spawnCalls.push(command)
        return harness.proc
      },
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const outcome = await tool.execute({ command: 'open' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('驱动会话已建立')
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]![0]).toBe('C:/py/python.exe')
    expect(spawnCalls[0]![1]!.replace(/\\/g, '/')).toContain('main/templates/tools/drive-harness.py')
    expect(spawnCalls[0]![2]).toBe('--entry')
    expect(spawnCalls[0]![3]).toBe('主程序.py')
    const sessionId = (outcome.detail as { session_id: string }).session_id
    const tracePath = join(projectRoot, '00_VERIFY', 'drive-trace', `${sessionId}.jsonl`)
    expect(existsSync(tracePath)).toBe(true)
    expect(readFileSync(tracePath, 'utf8')).toContain('"event":"ready"')
  })

  it('open ready 失败（no_root）：教育性报错 + 会话即清（后续 act 无会话）', async () => {
    const harness = fakeHarness({ autoReady: { ready: false, error: { class: 'no_root', message: '未发现 tk.Tk 实例' } } })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const outcome = await tool.execute({ command: 'open', entry: '主程序.py' }, ctxFor(projectId))
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('no_root')
    expect(outcome.output).toContain('入口形态问题')
    expect(harness.kill).toHaveBeenCalled()
    const after = await tool.execute({ command: 'act', session: 'whatever', steps: [{ op: 'ping' as never, target: '.!x' }] }, ctxFor(projectId))
    expect(after.isError).toBe(true)
    expect(after.output).toContain('会话不存在')
  })

  it('act 批量 fail_fast：首错即停，后续步不再发送', async () => {
    const replies: Array<Record<string, unknown>> = [
      { ok: true, step: 1, op: 'click', app_exceptions: [], data: { clicked: '.!button' } },
      { ok: false, step: 2, op: 'click', app_exceptions: [], err: { class: 'no_such_widget', message: '控件不存在：.!gone' } },
      { ok: true, step: 3, op: 'read', app_exceptions: [], data: {} },
    ]
    const harness = fakeHarness({ autoReady: READY_OK, respond: (_line, index) => replies[index] ?? null })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    const outcome = await tool.execute(
      {
        command: 'act',
        session: sessionId,
        steps: [
          { op: 'click', target: '.!button' },
          { op: 'click', target: '.!gone' },
          { op: 'click', target: '.!button2' },
        ],
      },
      ctxFor(projectId),
    )
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('1/3 步成功')
    expect(outcome.output).toContain('第 2 步失败')
    // 第三步不应发送：op 请求行只有 2 条
    expect(harness.written.filter((line) => line.includes('"op":"click"')).length).toBe(2)
  })

  it('act 动词超时：kill + 会话终止 + 引导 report', async () => {
    const harness = fakeHarness({ autoReady: READY_OK, respond: () => null })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    const outcome = await tool.execute({ command: 'act', session: sessionId, steps: [{ op: 'click', target: '.!button' }] }, ctxFor(projectId))
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('超时')
    expect(outcome.output).toContain('report')
    expect(harness.kill).toHaveBeenCalled()
    const after = await tool.execute({ command: 'read', session: sessionId }, ctxFor(projectId))
    expect(after.output).toContain('会话不存在')
  })

  it('op 预算：60 次后 act 拒绝执行（fail_soft 输出预算信息）', async () => {
    const harness = fakeHarness({
      autoReady: READY_OK,
      respond: () => ({ ok: true, step: 1, op: 'read', app_exceptions: [], data: { widgets: [] } }),
    })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    for (let index = 0; index < 60; index += 1) {
      const read = await tool.execute({ command: 'read', session: sessionId }, ctxFor(projectId))
      expect(read.isError).toBeFalsy()
    }
    const overflow = await tool.execute({ command: 'read', session: sessionId }, ctxFor(projectId))
    expect(overflow.isError).toBe(true)
    expect(overflow.output).toContain('op 预算用尽')
  })

  it('会话预算：每项目至多 2 个并发会话', async () => {
    const first = fakeHarness({ autoReady: READY_OK })
    const second = fakeHarness({ autoReady: READY_OK })
    const queue = [first.proc, second.proc]
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => queue.shift()!, resolvePython: okPython, ...FAST_TIMEOUTS })
    expect((await tool.execute({ command: 'open' }, ctxFor(projectId))).isError).toBeFalsy()
    expect((await tool.execute({ command: 'open' }, ctxFor(projectId))).isError).toBeFalsy()
    const third = await tool.execute({ command: 'open' }, ctxFor(projectId))
    expect(third.isError).toBe(true)
    expect(third.output).toContain('上限')
  })

  it('report：合法发现落盘 drive-findings.json；非法 severity 拒绝', async () => {
    const harness = fakeHarness({ autoReady: READY_OK, respond: () => ({ ok: true, step: 1, op: 'ping', app_exceptions: [], data: {} }) })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    const invalid = await tool.execute(
      { command: 'report', session: sessionId, finding: { severity: 'P9', title: 'x', expected: 'y', actual: 'z' } },
      ctxFor(projectId),
    )
    expect(invalid.isError).toBe(true)
    expect(invalid.output).toContain('severity')
    const valid = await tool.execute(
      {
        command: 'report',
        session: sessionId,
        finding: {
          severity: 'P0',
          title: '保存后数据丢失',
          expected: '保存后重启可读回',
          actual: '重启后为空',
          repro_steps: [{ op: 'click', target: '.!save' }],
        },
      },
      ctxFor(projectId),
    )
    expect(valid.isError).toBeFalsy()
    expect(valid.output).toContain('F1')
    const persisted = JSON.parse(readFileSync(join(projectRoot, '00_VERIFY', 'drive-findings.json'), 'utf8')) as {
      findings: Array<{ id: string; severity: string; repro_steps?: Array<Record<string, unknown>> }>
    }
    expect(persisted.findings).toHaveLength(1)
    expect(persisted.findings[0]!.severity).toBe('P0')
    expect(persisted.findings[0]!.repro_steps?.[0]?.op).toBe('click')
  })

  it('report supersedes：对照实验修正旧发现 severity（P0→P2）+ superseded_by 溯源；会话状态落盘', async () => {
    const harness = fakeHarness({ autoReady: READY_OK, respond: () => ({ ok: true, step: 1, op: 'ping', app_exceptions: [], data: {} }) })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    await tool.execute(
      { command: 'report', session: sessionId, finding: { severity: 'P0', title: '空输入点新增回调阻塞', expected: '提示错误不保存', actual: '驱动会话被终止' } },
      ctxFor(projectId),
    )
    const first = JSON.parse(readFileSync(join(projectRoot, '00_VERIFY', 'drive-findings.json'), 'utf8')) as { findings: Array<{ id: string; severity: string; superseded_by?: string }> }
    const firstId = first.findings[0]!.id
    const amend = await tool.execute(
      {
        command: 'report',
        session: sessionId,
        finding: { severity: 'P2', title: '对照实验：上条系 harness 模态交互所致非产品问题', expected: '归因平台侧', actual: '同会话 trace 时间戳为证', supersedes: firstId },
      },
      ctxFor(projectId),
    )
    expect(amend.isError).toBeFalsy()
    expect(amend.output).toContain(`${firstId}：P0→P2`)
    const after = JSON.parse(readFileSync(join(projectRoot, '00_VERIFY', 'drive-findings.json'), 'utf8')) as { findings: Array<{ id: string; severity: string; superseded_by?: string }> }
    const old = after.findings.find((item) => item.id === firstId)
    expect(old?.severity).toBe('P2')
    expect(old?.superseded_by).toBeTruthy()
    // B3：close 后会话状态落盘 drive-sessions.json（outcome=closed）
    await tool.execute({ command: 'close', session: sessionId }, ctxFor(projectId))
    const sessionsLog = JSON.parse(readFileSync(join(projectRoot, '00_VERIFY', 'drive-sessions.json'), 'utf8')) as Array<{ session_id: string; outcome: string }>
    expect(sessionsLog).toHaveLength(1)
    expect(sessionsLog[0]!.outcome).toBe('closed')
  })

  it('close：发送 close 动词 + kill 收尾；重复 close 报无会话', async () => {
    const harness = fakeHarness({ autoReady: READY_OK, respond: () => ({ ok: true, step: 1, op: 'close', app_exceptions: [], data: { closed: true } }) })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    const outcome = await tool.execute({ command: 'close', session: sessionId, reason: '探索完成' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('探索完成')
    expect(harness.written.some((line) => line.includes('"op":"close"'))).toBe(true)
    expect(harness.kill).toHaveBeenCalled()
    const again = await tool.execute({ command: 'close', session: sessionId }, ctxFor(projectId))
    expect(again.isError).toBe(true)
    expect(again.output).toContain('会话不存在')
  })

  it('disposeDriveSessions：兜底清理残留会话（dispatcher teardown 同款路径）', async () => {
    const harness = fakeHarness({ autoReady: READY_OK, respond: () => null })
    const tool = buildDriveAppTool(projectId, { spawnImpl: () => harness.proc, resolvePython: okPython, ...FAST_TIMEOUTS })
    const opened = await tool.execute({ command: 'open' }, ctxFor(projectId))
    const sessionId = (opened.detail as { session_id: string }).session_id
    disposeDriveSessions(projectId)
    expect(harness.kill).toHaveBeenCalled()
    const after = await tool.execute({ command: 'act', session: sessionId, steps: [{ op: 'click', target: '.!b' }] }, ctxFor(projectId))
    expect(after.output).toContain('会话不存在')
  })
})

describe('drive-harness 资产源码锁（spike 三假设的实现形态）', () => {
  it('含 offline-mainloop / 异常 hook / deiconify 兜底 / fd 级 ensure_ascii / 边界检查 / PrintWindow', () => {
    const source = readFileSync(join('main', 'templates', 'tools', 'drive-harness.py'), 'utf8')
    expect(source).toContain('Tk.mainloop') // offline-mainloop monkeypatch（import 阶段）
    expect(source).toContain('_boot_mainloop') // v2 根因批：boot 模式接管真实入口
    expect(source).toContain('report_callback_exception') // invoke() 异常不外抛的捕获 hook（spike A1）
    expect(source).toContain('deiconify') // withdrawn 不投递 event_generate 的兜底（spike B1/B2）
    expect(source).toContain('ensure_ascii') // 协议行纯 ASCII（GBK 控制台家族坑）
    expect(source).toContain('app_exceptions') // 响应携带应用异常增量
    expect(source).toContain('module_state') // v2：模块级状态树（游戏引擎坐标/分数可观测）
    expect(source).toContain('__slots__') // 游戏实体无 __dict__，按槽名展开
    expect(source).toContain('hold_ms') // 键盘按住（移动类按键差分验证）
    expect(source).toContain('realpath') // read_file/screenshot 项目根边界
    expect(source).toContain('PrintWindow') // 句柄级截图（同源 driver-skeleton）
  })
})

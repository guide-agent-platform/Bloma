/**
 * drive_project_app webview 腿测试（批8 下半，2026-10-06）。
 *
 * 覆盖：腿路由（requirements/LAUNCH ui 声明/缺省 tk）、open 就绪握手
 * （DRIVE_SERVER 行 + 探针）、act 动词映射（click/set_text/js/call → /eval /call）、
 * read（DOM 快照/自定义 js/read_file/list_files）、close 进程树终止、
 * 腿专属动词拦截教育。
 *
 * 进程内 node:http 假控制服务器模拟骨架 app.py --drive-port 协议；spawn 全注入
 * （零真实子进程，陷阱 35）。
 */
import EventEmitter from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
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
    sessionId: 'session-drive-webview',
    requestId: 'req-drive-webview',
    signal: new AbortController().signal,
    state: createToolState(),
  }
}

/** 进程内假骨架控制服务器（模拟 app.py --drive-port 的 /eval /call）。 */
interface FakeDriveServer {
  port: number
  requests: Array<{ path: string; body: Record<string, unknown> }>
  setEvalResult: (result: unknown) => void
  setCallResult: (result: unknown) => void
  close: () => Promise<void>
}

function startFakeDriveServer(): Promise<FakeDriveServer> {
  const requests: FakeDriveServer['requests'] = []
  let evalResult: unknown = { title: '演示', bridge_ready: true, inputs: [], buttons: [], rows: [] }
  let callResult: unknown = [{ id: '1', name: '条目' }]
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        body = {}
      }
      requests.push({ path: req.url ?? '', body })
      const payload =
        req.url === '/eval'
          ? { ok: true, result: typeof body.js === 'string' && body.js.includes('missing-element') ? { found: false } : evalResult }
          : req.url === '/call'
            ? { ok: true, result: callResult }
            : { ok: false, error: `no route: ${req.url}` }
      const out = Buffer.from(JSON.stringify(payload), 'utf8')
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': out.length })
      res.end(out)
    })
  })
  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolvePromise({
        port,
        requests,
        setEvalResult: (result) => {
          evalResult = result
        },
        setCallResult: (result) => {
          callResult = result
        },
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

/** 假 webview 进程：stdout 主动打 DRIVE_SERVER 就绪行（模拟骨架 app.py）。 */
function fakeWebviewProc(port: number, extraLine?: string) {
  const stdout = new EventEmitter()
  const kill = vi.fn()
  const exitListeners: Array<(code: number | null) => void> = []
  const proc: DriveHarnessProcess = {
    stdin: { write: () => undefined },
    stdout: stdout as unknown as DriveHarnessProcess['stdout'],
    kill: kill as unknown as DriveHarnessProcess['kill'],
    once: (event: 'exit', listener: (code: number | null) => void) => {
      exitListeners.push(listener)
    },
  }
  stdout.on('newListener', (event: string) => {
    if (event === 'data') {
      queueMicrotask(() => {
        if (extraLine) stdout.emit('data', `${extraLine}\n`)
        stdout.emit('data', `DRIVE_SERVER 127.0.0.1:${port}\n`)
      })
    }
  })
  return { proc, kill }
}

const FAST_TIMEOUTS = { opTimeoutMs: 400, openTimeoutMs: 1_500, closeTimeoutMs: 200 }
const okPython = async () => 'C:/py/python.exe'

describe('drive_project_app webview 腿（批8 下半）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let projectRoot: string
  let projectId: string
  let fakeServer: FakeDriveServer

  beforeEach(async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-drive-webview-'))
    const project = createProject({ request_id: 'req-drive-webview-setup', mode: 'longterm' })
    projectId = project.project_id
    projectRoot = project.root_path
    writeFileSync(join(projectRoot, 'app.py'), 'import webview\n', 'utf8')
    // 腿路由缺省探测源：requirements 含 pywebview → webview 腿
    writeFileSync(join(projectRoot, 'requirements.txt'), 'pywebview\nPillow\n', 'utf8')
    fakeServer = await startFakeDriveServer()
  })

  afterEach(async () => {
    disposeDriveSessions()
    await fakeServer.close()
    restorePromaHome(originalPromaHome)
  })

  it('open：requirements 探测路由 webview 腿 + DRIVE_SERVER 握手 + spawn 参数带 --drive-port', async () => {
    const spawnCalls: string[][] = []
    const fake = fakeWebviewProc(fakeServer.port)
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: (command) => {
        spawnCalls.push(command)
        return fake.proc
      },
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const outcome = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('webview 腿')
    expect(outcome.output).toContain(`127.0.0.1:${fakeServer.port}`)
    expect(spawnCalls.length).toBe(1)
    expect(spawnCalls[0]!.slice(1)).toEqual(['app.py', '--drive-port', expect.any(String)])
    // 探针与就绪行进入 trace；会话 id 可用于后续动词
    const sessionId = /drive-\S+/.exec(outcome.output)?.[0]
    expect(sessionId).toBeTruthy()
  })

  it('LAUNCH.json ui=webview 声明优先于 requirements 探测', async () => {
    writeFileSync(join(projectRoot, 'requirements.txt'), 'requests\n', 'utf8') // 无 pywebview
    writeFileSync(
      join(projectRoot, 'LAUNCH.json'),
      JSON.stringify({ schema_version: 1, command: ['.venv/Scripts/python.exe', 'app.py'], window_title: '演示', ui: 'webview' }),
      'utf8',
    )
    // venv 解释器存在（existsSync 探测即可命中；open 用它 spawn）
    mkdirSync(join(projectRoot, '.venv', 'Scripts'), { recursive: true })
    writeFileSync(join(projectRoot, '.venv', 'Scripts', 'python.exe'), '#!/bin/sh\n', 'utf8')
    const fake = fakeWebviewProc(fakeServer.port)
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: () => fake.proc,
      resolvePython: async () => {
        throw new Error('不应走到系统 python 解析（LAUNCH command 已声明 venv）')
      },
      ...FAST_TIMEOUTS,
    })
    const outcome = await tool.execute({ command: 'open' }, ctxFor(projectId))
    expect(outcome.isError).toBeFalsy()
    expect(outcome.output).toContain('webview 腿')
  })

  it('无 pywebview 且无 ui 声明 → 缺省 tk 腿（spawn drive-harness.py）', async () => {
    writeFileSync(join(projectRoot, 'requirements.txt'), 'Pillow\n', 'utf8')
    const spawnCalls: string[][] = []
    const fake = fakeWebviewProc(fakeServer.port)
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: (command) => {
        spawnCalls.push(command)
        return fake.proc
      },
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const outcome = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    // tk 腿等 ready JSON 行（fake 只发 DRIVE_SERVER 文本行 → 超时失败），但 spawn 形态可断言
    expect(spawnCalls[0]![1]!.replace(/\\/g, '/')).toContain('drive-harness.py')
    expect(outcome.isError).toBe(true)
  })

  it('act：click/set_text/js/call 全映射（/eval×3 + /call×1）；腿专属动词 select 拦截教育', async () => {
    const fake = fakeWebviewProc(fakeServer.port)
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: () => fake.proc,
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const opened = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    expect(opened.isError).toBeFalsy()
    const sessionId = /drive-\S+/.exec(opened.output)?.[0] as string

    const act = await tool.execute(
      {
        command: 'act',
        session: sessionId,
        steps: [
          { op: 'set_text', target: 'main-input', value: '你好' },
          { op: 'click', target: 'btn-send' },
          { op: 'js', js: 'document.querySelectorAll(".w-row").length' },
          { op: 'call', api: 'list_items', args: [] },
        ],
      },
      ctxFor(projectId),
    )
    expect(act.isError).toBeFalsy()
    const evalBodies = fakeServer.requests.filter((r) => r.path === '/eval').map((r) => String(r.body.js))
    expect(evalBodies.some((js) => js.includes('"main-input"') && js.includes('"你好"'))).toBe(true)
    expect(evalBodies.some((js) => js.includes('"btn-send"') && js.includes('el.click()'))).toBe(true)
    expect(evalBodies.some((js) => js.includes('.w-row'))).toBe(true)
    const callBody = fakeServer.requests.find((r) => r.path === '/call')?.body
    expect(callBody).toMatchObject({ op: 'list_items', args: [] })

    const badOp = await tool.execute(
      { command: 'act', session: sessionId, steps: [{ op: 'select', target: 'x', value: '1' }] },
      ctxFor(projectId),
    )
    expect(badOp.isError).toBe(true)
    expect(badOp.output).toContain('不适用 webview 腿')
  })

  it('read：缺省 DOM 快照 + 自定义 js + read_file（工具侧直读）+ list_files', async () => {
    writeFileSync(join(projectRoot, 'data.txt'), '条目A\n条目B\n', 'utf8')
    const fake = fakeWebviewProc(fakeServer.port, '[warn] WebView2 initialized')
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: () => fake.proc,
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const opened = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    const sessionId = /drive-\S+/.exec(opened.output)?.[0] as string

    const snap = await tool.execute({ command: 'read', session: sessionId }, ctxFor(projectId))
    expect(snap.isError).toBeFalsy()
    expect(snap.output).toContain('bridge_ready')
    expect(snap.output).toContain('title')
    // 就绪行前的杂散输出归档进 webviewLog 并随 read 附带
    expect(snap.output).toContain('[warn] WebView2 initialized')

    const custom = await tool.execute(
      { command: 'read', session: sessionId, js: 'document.title' },
      ctxFor(projectId),
    )
    expect(fakeServer.requests.some((r) => r.path === '/eval' && String(r.body.js) === 'document.title')).toBe(true)

    const file = await tool.execute(
      { command: 'read', session: sessionId, op: 'read_file', path: 'data.txt' },
      ctxFor(projectId),
    )
    expect(file.isError).toBeFalsy()
    expect(file.output).toContain('条目A')

    const listing = await tool.execute(
      { command: 'read', session: sessionId, op: 'list_files' },
      ctxFor(projectId),
    )
    expect(listing.isError).toBeFalsy()
    expect(listing.output).toContain('app.py')
    expect(listing.output).not.toContain('drive-trace') // 非产物目录不递归（与 tk 腿同界：目录条目本身可见、内容不递归）

    const outside = await tool.execute(
      { command: 'read', session: sessionId, op: 'read_file', path: '../outside.txt' },
      ctxFor(projectId),
    )
    expect(outside.isError).toBe(true)
  })

  it('close：webview 腿进程树终止收口（无 stdin close 动词）', async () => {
    const fake = fakeWebviewProc(fakeServer.port)
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: () => fake.proc,
      resolvePython: okPython,
      ...FAST_TIMEOUTS,
    })
    const opened = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    const sessionId = /drive-\S+/.exec(opened.output)?.[0] as string
    const closed = await tool.execute({ command: 'close', session: sessionId, reason: '探索完成' }, ctxFor(projectId))
    expect(closed.isError).toBeFalsy()
    expect(closed.output).toContain('进程树终止')
    expect(fake.kill).toHaveBeenCalled()
  })

  it('DRIVE_SERVER 未出现（入口崩溃）→ open 失败如实报错并清理会话', async () => {
    const stdout = new EventEmitter()
    const kill = vi.fn()
    const proc: DriveHarnessProcess = {
      stdin: { write: () => undefined },
      stdout: stdout as unknown as DriveHarnessProcess['stdout'],
      kill: kill as unknown as DriveHarnessProcess['kill'],
      once: () => undefined,
    }
    stdout.on('newListener', (event: string) => {
      if (event === 'data') {
        queueMicrotask(() => stdout.emit('data', 'Traceback (most recent call last):\n  ImportError: No module named webview\n'))
      }
    })
    const tool = buildDriveAppTool(projectId, {
      spawnImpl: () => proc,
      resolvePython: okPython,
      openTimeoutMs: 300,
      opTimeoutMs: 300,
      closeTimeoutMs: 200,
    })
    const outcome = await tool.execute({ command: 'open', entry: 'app.py' }, ctxFor(projectId))
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain('webview 驱动腿未就绪')
    expect(outcome.output).toContain('ImportError')
  })
})

describe('drive-app-webview 单元件', () => {
  it('matchDriveServerLine：就绪行解析（含首尾空白容忍）与杂散行拒绝', async () => {
    const { matchDriveServerLine } = await import('../../../main/desktop/drive-app-webview')
    expect(matchDriveServerLine('DRIVE_SERVER 127.0.0.1:8800')?.port).toBe(8800)
    expect(matchDriveServerLine('  DRIVE_SERVER 127.0.0.1:991  ')?.port).toBe(991)
    expect(matchDriveServerLine('DRIVE_SERVER 0.0.0.0:8800')).toBeNull() // 非回环地址不认（骨架只绑 127.0.0.1）
    expect(matchDriveServerLine('Traceback ...')).toBeNull()
  })

  it('DOM JS 构造：同步表达式 + 元素 id 转义', async () => {
    const { webviewClickJs, webviewSetTextJs, WEBVIEW_DOM_SNAPSHOT_JS } = await import('../../../main/desktop/drive-app-webview')
    const click = webviewClickJs('btn"evil')
    expect(click).toContain('document.getElementById("btn\\"evil")')
    expect(click).not.toContain('async')
    expect(webviewSetTextJs('inp', 'a\\b')).toContain('"a\\\\b"')
    expect(WEBVIEW_DOM_SNAPSHOT_JS).not.toContain('async ')
    expect(WEBVIEW_DOM_SNAPSHOT_JS).toContain('.w-banner')
  })
})

/**
 * drive_project_app 会话基础设施（批8 下半拆分自 drive-app-tool.ts，R7 红线拆分）。
 *
 * 双腿会话机制层：会话注册表 / stdout 行泵（tk 腿 JSON-lines）/ DRIVE_SERVER 就绪
 * 匹配（webview 腿）/ 超时与预算常量 / trace 落盘 / findings 合并持久化 / 遥测发射 /
 * 进程终止（webview 腿 taskkill 进程树；tk 腿单进程 kill）。命令面（open/act/read/
 * report/close 的输入校验与编排）留在 drive-app-tool.ts；webview 协议件在
 * drive-app-webview.ts。
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { trackAnalytics } from '../delivery/track-analytics'
import { readLaunchDeclaration } from './launch-smoke'
import {
  killWebviewProcessTree,
  matchDriveServerLine,
  webviewClickJs,
  webviewPost,
  webviewSetTextJs,
  WEBVIEW_LOG_TAIL_CHARS,
} from './drive-app-webview'

export const TRACE_DIR_REL = '00_VERIFY/drive-trace'
export const DRIVE_FINDINGS_REL = '00_VERIFY/drive-findings.json'

export const OPEN_TIMEOUT_MS = 30_000
export const CLOSE_TIMEOUT_MS = 5_000
export const OP_TIMEOUT_MS = 10_000
export const DEFAULT_SESSION_WALL_MS = 300_000
export const MAX_OPS_PER_SESSION = 60
export const MAX_SESSIONS_PER_PROJECT = 2
export const MAX_ACT_STEPS = 8
export const MAX_REPRO_STEPS = 16

export interface DriveHarnessProcess {
  pid?: number
  stdin: { write(chunk: string): void }
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): void }
  kill(): void
  once(event: 'exit', listener: (code: number | null) => void): void
}

export interface DriveFinding {
  id: string
  severity: 'P0' | 'P1' | 'P2'
  title: string
  expected: string
  actual: string
  repro_steps?: Array<Record<string, unknown>>
}

export interface DriveSession {
  id: string
  projectId: string
  root: string
  /** 驱动腿（批8 下半）：tk=进程内 harness（stdin/stdout JSON-lines）；webview=骨架 v2 --drive-port 控制服务器 */
  leg: 'tk' | 'webview'
  /** webview 腿控制服务器端口 */
  httpPort?: number
  /** webview 腿：被测程序 stdout 杂散输出尾部（read 时附给探索者——应用异常线索） */
  webviewLog: string
  proc: DriveHarnessProcess
  startedAt: number
  ops: number
  findings: DriveFinding[]
  lineBuffer: string
  queuedLines: string[]
  waiting: { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void } | null
  exited: boolean
  exitCode: number | null
}

export const sessions = new Map<string, DriveSession>()

export class DriveOpTimeoutError extends Error {
  constructor(op: string) {
    super(`动词超时（${op}，上限 10s）：被测回调可能死循环，会话已终止。如实记录为发现后继续收尾。`)
  }
}

export class DriveSessionDiedError extends Error {
  constructor(code: number | null) {
    super(`harness 进程已退出（code=${code}）——被测程序可能发生 native 崩溃。`)
  }
}

export function defaultSpawn(command: string[], cwd: string, env: Record<string, string>): DriveHarnessProcess {
  return nodeSpawn(command[0]!, command.slice(1), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as DriveHarnessProcess
}

type DriveEventType = 'desktop_drive_session_started' | 'desktop_drive_step' | 'desktop_drive_findings' | 'desktop_drive_session_closed'

export function emitDriveTelemetry(eventType: DriveEventType, projectId: string, payload: Record<string, unknown>): void {
  try {
    trackAnalytics({
      request_id: `drive-app-${Date.now()}-${randomUUID().slice(0, 8)}`,
      event: {
        event_type: eventType,
        project_id: projectId,
        session_id: typeof payload.agent_session_id === 'string' ? payload.agent_session_id : undefined,
        payload,
        privacy_level: 'research_safe',
      },
    })
  } catch {
    // 遥测失败不阻断探索
  }
}

export function traceLine(session: DriveSession, direction: 'req' | 'res' | 'evt', payload: Record<string, unknown>): void {
  try {
    appendFileSync(join(session.root, TRACE_DIR_REL, `${session.id}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), dir: direction, ...payload })}\n`, 'utf8')
  } catch {
    // 证据落盘失败不阻断探索（mvp-review 有降级显示）
  }
}

function pumpWaiting(session: DriveSession): void {
  if (session.waiting && session.queuedLines.length > 0) {
    const line = session.queuedLines.shift()!
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      // B2（2026-10-06）：坏行原文进 trace——只报「协议行损坏」丢原文会加大定位成本
      try {
        appendFileSync(join(session.root, TRACE_DIR_REL, `${session.id}.jsonl`), `${JSON.stringify({ t: new Date().toISOString(), dir: 'res', corrupt_line: line.slice(0, 400) })}\n`, 'utf8')
      } catch {
        // trace 失败不阻断
      }
      parsed = { ok: false, err: { class: 'io', message: '协议行损坏（非 JSON）' } }
    }
    const waiter = session.waiting
    session.waiting = null
    waiter.resolve(parsed)
  }
}

export function attachProcessListeners(session: DriveSession): void {
  session.proc.stdout.on('data', (chunk: Buffer | string) => {
    session.lineBuffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let newline = session.lineBuffer.indexOf('\n')
    while (newline >= 0) {
      const line = session.lineBuffer.slice(0, newline).trim()
      session.lineBuffer = session.lineBuffer.slice(newline + 1)
      if (line) session.queuedLines.push(line)
      newline = session.lineBuffer.indexOf('\n')
    }
    pumpWaiting(session)
  })
  session.proc.once('exit', (code: number | null) => {
    session.exited = true
    session.exitCode = code
    if (session.waiting) {
      const waiter = session.waiting
      session.waiting = null
      waiter.reject(new DriveSessionDiedError(code))
    }
  })
}

export function waitLine(session: DriveSession, timeoutMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (session.exited) {
      rejectPromise(new DriveSessionDiedError(session.exitCode))
      return
    }
    const timer = setTimeout(() => {
      session.waiting = null
      try {
        session.proc.kill()
      } catch {
        // 进程可能已退出
      }
      rejectPromise(new DriveOpTimeoutError('等待响应'))
    }, timeoutMs)
    session.waiting = {
      resolve: (value) => {
        clearTimeout(timer)
        session.waiting = null
        resolvePromise(value)
      },
      reject: (error) => {
        clearTimeout(timer)
        session.waiting = null
        rejectPromise(error)
      },
    }
    pumpWaiting(session)
  })
}

export async function requestOp(session: DriveSession, payload: Record<string, unknown>, timeoutMs = OP_TIMEOUT_MS): Promise<Record<string, unknown>> {
  if (session.exited) throw new DriveSessionDiedError(session.exitCode)
  const pending = waitLine(session, timeoutMs)
  try {
    session.proc.stdin.write(`${JSON.stringify(payload)}\n`)
  } catch (error) {
    // 写入失败：等待方由 exit/timeout 收尾；此处只兜未注册等待的极小窗口
    if (!session.waiting) throw new Error(`stdin 写入失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return pending
}

/** webview 腿：轮询 stdout 行直到命中（DRIVE_SERVER 就绪行）；非命中行归档进 webviewLog。 */
export function waitForMatch(
  session: DriveSession,
  timeoutMs: number,
  match: (line: string) => Record<string, unknown> | null,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, rejectPromise) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let interval: ReturnType<typeof setInterval> | undefined
    const settle = (fn: () => void) => {
      if (timer !== undefined) clearTimeout(timer)
      if (interval !== undefined) clearInterval(interval)
      fn()
    }
    const archive = (stray: string) => {
      session.webviewLog = `${session.webviewLog}
${stray}`.slice(-WEBVIEW_LOG_TAIL_CHARS)
    }
    const drainStrays = () => {
      for (const stray of session.queuedLines.splice(0)) archive(stray)
    }
    const poll = (): boolean => {
      if (session.exited) {
        drainStrays()
        settle(() => rejectPromise(new DriveSessionDiedError(session.exitCode)))
        return true
      }
      for (let index = 0; index < session.queuedLines.length; index += 1) {
        const hit = match(session.queuedLines[index]!)
        if (hit) {
          const consumed = session.queuedLines.splice(0, index + 1)
          for (const stray of consumed.slice(0, -1)) archive(stray)
          settle(() => resolvePromise(hit))
          return true
        }
      }
      return false
    }
    if (poll()) return
    timer = setTimeout(() => {
      settle(() => {
        drainStrays()
        try {
          session.proc.kill()
        } catch {
          // 已退出
        }
        rejectPromise(new DriveOpTimeoutError('等待 DRIVE_SERVER 就绪行'))
      })
    }, timeoutMs)
    interval = setInterval(() => {
      poll()
    }, 50)
  })
}

/** webview 腿就绪探针：/eval 1+1（连接初期可能短暂拒连，小重试）。 */
export async function probeDriveServer(port: number, timeoutMs: number): Promise<void> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await webviewPost(port, '/eval', { js: '1+1' }, timeoutMs)
      if (response.ok !== true) throw new Error(`探针响应异常：${JSON.stringify(response)}`)
      return
    } catch (error) {
      lastError = error
      await new Promise((sleep) => setTimeout(sleep, 200))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('控制服务器探针失败')
}

/** 腿路由（批8 下半）：LAUNCH.json ui 声明优先；缺省看 requirements 是否含 pywebview。 */
export function detectDriveLeg(root: string): 'webview' | 'tk' {
  const declaration = readLaunchDeclaration(root)
  if (declaration?.ok && declaration.launch.ui === 'webview') return 'webview'
  for (const rel of ['requirements.txt', '00_SCAFFOLD/requirements.txt']) {
    try {
      const raw = readFileSync(join(root, rel), 'utf8')
      if (/(^|\n)\s*pywebview\b/.test(raw)) return 'webview'
    } catch {
      // 无该文件——继续探测
    }
  }
  return 'tk'
}

/** webview 腿 act 动词分发：/eval（click/set_text/js）或 /call（call）；响应归一到 tk 协议形态。 */
export async function dispatchWebviewAct(
  session: DriveSession,
  step: { op: string; target?: string; value?: string; js?: string; api?: string; args?: unknown[] },
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  if (!session.httpPort) throw new DriveSessionDiedError(session.exitCode)
  let path = '/eval'
  let body: Record<string, unknown>
  if (step.op === 'click') {
    body = { js: webviewClickJs(String(step.target)) }
  } else if (step.op === 'set_text') {
    body = { js: webviewSetTextJs(String(step.target), step.value ?? '') }
  } else if (step.op === 'js') {
    body = { js: String(step.js) }
  } else {
    path = '/call'
    body = { op: String(step.api), args: step.args ?? [] }
  }
  const response = await webviewPost(session.httpPort, path, body, timeoutMs)
  if (response.ok !== true) {
    return { ok: false, err: { class: 'webview', message: String(response.error ?? '未知错误') } }
  }
  return { ok: true, result: response.result }
}

export function killSession(session: DriveSession, exitKind: string): void {
  // webview 腿：taskkill 进程树（连带 WebView2 子进程）；tk 腿：单进程 kill
  if (session.leg === 'webview') {
    killWebviewProcessTree(session.proc.pid, () => {
      try {
        session.proc.kill()
      } catch {
        // 已退出
      }
    })
  } else {
    try {
      session.proc.kill()
    } catch {
      // 已退出
    }
  }
  sessions.delete(session.id)
  // 会话状态落盘（2026-10-06 发现④/B3）：探索会话整体成败写入 00_VERIFY/drive-sessions.json
  // ——MVP 门呈现「探索不可用」的真相源（探索失败≠零发现，两者对用户可区分）。
  try {
    const sessionsPath = join(session.root, '00_VERIFY/drive-sessions.json')
    let log: unknown[] = []
    try {
      log = JSON.parse(readFileSync(sessionsPath, 'utf8')) as unknown[]
      if (!Array.isArray(log)) log = []
    } catch {
      // 首次落盘
    }
    log.push({
      session_id: session.id,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: new Date().toISOString(),
      outcome: exitKind,
      ops: session.ops,
      findings: session.findings.length,
    })
    mkdirSync(join(session.root, '00_VERIFY'), { recursive: true })
    writeFileSync(sessionsPath, JSON.stringify(log, null, 2), 'utf8')
  } catch {
    // 状态落盘失败不阻断清理
  }
  emitDriveTelemetry('desktop_drive_session_closed', session.projectId, {
    harness_session_id: session.id,
    exit: exitKind,
    steps: session.ops,
    wall_ms: Date.now() - session.startedAt,
    findings: session.findings.length,
  })
}

/** 会话清理（dispatcher-loop 收尾兜底 + 测试隔离）：kill 残留进程并清注册表。 */
export function disposeDriveSessions(projectId?: string): void {
  for (const session of [...sessions.values()]) {
    if (projectId === undefined || session.projectId === projectId) {
      traceLine(session, 'evt', { event: 'disposed', by: projectId === undefined ? 'all' : 'dispatcher-teardown' })
      killSession(session, 'disposed')
    }
  }
}

export function lookupSession(sessionId: unknown): DriveSession | undefined {
  return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
}

export function sessionExpired(session: DriveSession, wallMs: number): boolean {
  return Date.now() - session.startedAt > wallMs
}

export function readFindingsFile(root: string): DriveFinding[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, DRIVE_FINDINGS_REL), 'utf8')) as { findings?: DriveFinding[] }
    return Array.isArray(parsed.findings) ? parsed.findings : []
  } catch {
    return []
  }
}

export function persistFindings(session: DriveSession): void {
  const existing = readFindingsFile(session.root)
  const merged = [...existing, ...session.findings]
  writeFileSync(
    join(session.root, DRIVE_FINDINGS_REL),
    JSON.stringify({ project_id: session.projectId, generated_at: new Date().toISOString(), findings: merged }, null, 2),
    'utf8',
  )
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…（截断）` : text
}


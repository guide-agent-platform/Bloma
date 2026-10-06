/**
 * drive_project_app — 探索驱动测试 A 档工具端（2026-10-05，实施稿
 * BLOMA《Bloma-探索驱动测试实施稿-20261005》，已含 §14 预审修订）。
 *
 * 拍板（10-05）：Agent 可获受控通路真实操控被测程序；两轨原则——操控给 Agent、
 * 裁决保持确定性（findings 只入过目页/修复账本，不进门禁）；探索者与 implement
 * 结构性分离（本工具仅装配进 research 角色子会话，不进 implement 面）。
 *
 * 机制：spawn 平台资产 drive-harness.py（进程内驱动桥：import 被测入口 +
 * JSON-lines 动词协议，窗口默认 withdraw 静默）；本工具管理会话生命周期、
 * 四项预算（op ≤60/会话、会话 ≤2/项目、动词 ≤10s、墙钟 300s）、每步 trace 落盘
 * 00_VERIFY/drive-trace/、findings 汇总落 00_VERIFY/drive-findings.json
 * （MVP 过目页 holdForMvpConfirm 读取呈现）。
 *
 * spike 实证背书：monkeypatch/异常 hook/deiconify 投递三假设已验
 * （BLOMA/spike-drive-harness-20261005，十项全绿 + 协议冒烟一次过）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { mainRootDir } from '../platform/paths'
import { trackAnalytics } from '../delivery/track-analytics'
import { readLaunchDeclaration } from './launch-smoke'
import { buildChildExecEnv, defaultResolvePython } from './child-exec-tool'

const TRACE_DIR_REL = '00_VERIFY/drive-trace'
export const DRIVE_FINDINGS_REL = '00_VERIFY/drive-findings.json'

const OPEN_TIMEOUT_MS = 30_000
const CLOSE_TIMEOUT_MS = 5_000
const OP_TIMEOUT_MS = 10_000
const DEFAULT_SESSION_WALL_MS = 300_000
const MAX_OPS_PER_SESSION = 60
const MAX_SESSIONS_PER_PROJECT = 2
const MAX_ACT_STEPS = 8
const MAX_REPRO_STEPS = 16

const ACT_OPS: ReadonlySet<string> = new Set(['click', 'set_text', 'select', 'keys'])
const READ_OPS: ReadonlySet<string> = new Set(['read', 'read_file', 'list_files'])
const SEVERITIES: ReadonlySet<string> = new Set(['P0', 'P1', 'P2'])

/** harness 进程抽象（spawn 可注入——单测零真实子进程，陷阱 35）。 */
export interface DriveHarnessProcess {
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

export interface DriveAppDeps {
  spawnImpl?: (command: string[], cwd: string, env: Record<string, string>) => DriveHarnessProcess
  resolvePython?: () => Promise<string>
  sessionWallMs?: number
  /** 以下超时均可注入（单测用真实子毫秒值，不真等 10s） */
  opTimeoutMs?: number
  openTimeoutMs?: number
  closeTimeoutMs?: number
}

interface DriveSession {
  id: string
  projectId: string
  root: string
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

const sessions = new Map<string, DriveSession>()

class DriveOpTimeoutError extends Error {
  constructor(op: string) {
    super(`动词超时（${op}，上限 10s）：被测回调可能死循环，会话已终止。如实记录为发现后继续收尾。`)
  }
}

class DriveSessionDiedError extends Error {
  constructor(code: number | null) {
    super(`harness 进程已退出（code=${code}）——被测程序可能发生 native 崩溃。`)
  }
}

function defaultSpawn(command: string[], cwd: string, env: Record<string, string>): DriveHarnessProcess {
  return nodeSpawn(command[0]!, command.slice(1), { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as DriveHarnessProcess
}

type DriveEventType = 'desktop_drive_session_started' | 'desktop_drive_step' | 'desktop_drive_findings' | 'desktop_drive_session_closed'

function emitDriveTelemetry(eventType: DriveEventType, projectId: string, payload: Record<string, unknown>): void {
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

function traceLine(session: DriveSession, direction: 'req' | 'res' | 'evt', payload: Record<string, unknown>): void {
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

function attachProcessListeners(session: DriveSession): void {
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

function waitLine(session: DriveSession, timeoutMs: number): Promise<Record<string, unknown>> {
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

async function requestOp(session: DriveSession, payload: Record<string, unknown>, timeoutMs = OP_TIMEOUT_MS): Promise<Record<string, unknown>> {
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

function killSession(session: DriveSession, exitKind: string): void {
  try {
    session.proc.kill()
  } catch {
    // 已退出
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

function lookupSession(sessionId: unknown): DriveSession | undefined {
  return typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
}

function sessionExpired(session: DriveSession, wallMs: number): boolean {
  return Date.now() - session.startedAt > wallMs
}

function readFindingsFile(root: string): DriveFinding[] {
  try {
    const parsed = JSON.parse(readFileSync(join(root, DRIVE_FINDINGS_REL), 'utf8')) as { findings?: DriveFinding[] }
    return Array.isArray(parsed.findings) ? parsed.findings : []
  } catch {
    return []
  }
}

function persistFindings(session: DriveSession): void {
  const existing = readFindingsFile(session.root)
  const merged = [...existing, ...session.findings]
  writeFileSync(
    join(session.root, DRIVE_FINDINGS_REL),
    JSON.stringify({ project_id: session.projectId, generated_at: new Date().toISOString(), findings: merged }, null, 2),
    'utf8',
  )
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}…（截断）` : text
}

export function buildDriveAppTool(projectId: string, deps: DriveAppDeps = {}): AgentLoopTool {
  const spawnImpl = deps.spawnImpl ?? defaultSpawn
  const resolvePython = deps.resolvePython ?? defaultResolvePython
  const sessionWallMs = deps.sessionWallMs ?? DEFAULT_SESSION_WALL_MS
  const opTimeoutMs = deps.opTimeoutMs ?? OP_TIMEOUT_MS
  const openTimeoutMs = deps.openTimeoutMs ?? OPEN_TIMEOUT_MS
  const closeTimeoutMs = deps.closeTimeoutMs ?? CLOSE_TIMEOUT_MS

  return {
    name: 'drive_project_app',
    description:
      '探索者专属：真实操控本项目的桌面 GUI 程序做探索性测试（进程内驱动桥 v2：boot 模式接管真实入口，' +
      '主循环/绑定/收尾全真实；窗口默认隐藏不打扰用户）。流程：open（entry 缺省自动取 LAUNCH.json 入口，' +
      '自动 boot 接管 run()/main()）→ read 拿控件树 + module_state（游戏引擎坐标/分数等状态可读）→ ' +
      'act 批量动词（click/set_text/select/keys，≤8 步/次；移动/长按类按键配 hold_ms 300~700 按住后读差分）→ ' +
      'read/read_file/list_files 验证状态与文件副作用 → report 逐条上报发现（P0/P1/P2 + title/expected/actual + repro_steps）→ close 收尾。' +
      '程序异常随 app_exceptions 返回且会话存活（native 崩溃才会话终止）；每动词 ≤10s（hold 计入）、每会话 60 op/5 分钟、' +
      '每项目至多 2 会话。你不是实现者：按 PRD 验收点逐条探索（正常/空输入/边界/重复/乱序/键盘响应），发现即 report，不要修代码。',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['open', 'act', 'read', 'report', 'close'], description: '子命令' },
        entry: { type: 'string', description: 'open：项目根内主程序 .py 相对路径（缺省取 LAUNCH.json）' },
        session: { type: 'string', description: '会话 id（open 返回；act/read/report/close 必填）' },
        steps: {
          type: 'array',
          maxItems: MAX_ACT_STEPS,
          description: 'act：动词批次（顺序执行，首错即停）',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['click', 'set_text', 'select', 'keys'] },
              target: { type: 'string', description: '控件 id（read 返回的 path 形态；keys 可省略=发到焦点/root）' },
              value: { type: 'string', description: 'set_text/select 的值 / keys 的空格分隔键名（如 Left a space）' },
              hold_ms: { type: 'number', description: 'keys 专用：按住毫秒数（0~2000；移动/长按类按键用 300~700，期间主循环真实运行）' },
            },
            required: ['op', 'target'],
          },
        },
        op: { type: 'string', enum: ['read', 'read_file', 'list_files'], description: 'read 命令的读动词（缺省 read 全量快照）' },
        target: { type: 'string', description: 'read：单控件 id' },
        path: { type: 'string', description: 'read_file：项目根内相对路径' },
        finding: {
          type: 'object',
          description: 'report：一条探索发现；对照实验推翻/修正早前发现时，带 supersedes 指向被修正的 finding id（其 severity 将被本条覆盖）',
          properties: {
            severity: { type: 'string', enum: ['P0', 'P1', 'P2'] },
            title: { type: 'string' },
            expected: { type: 'string', description: '按 PRD/常识应发生什么' },
            actual: { type: 'string', description: '实际观察到什么（对照实验结论也写这里，附 trace 时间戳证据）' },
            repro_steps: { type: 'array', items: { type: 'object' }, description: '可重放动词步骤（同 act steps 形态）' },
            supersedes: { type: 'string', description: '被本发现修正/取代的旧 finding id（如 F1-x7f3a2）——旧条 severity 将被本条覆盖，避免已推翻的 P0 继续触发回炉' },
          },
          required: ['severity', 'title', 'expected', 'actual'],
        },
        reason: { type: 'string', description: 'close：收尾原因（如实记录）' },
      },
      required: ['command'],
    },
    execute: async (input, ctx) => {
      const command = typeof input.command === 'string' ? input.command : ''
      const agentSessionId = typeof ctx?.sessionId === 'string' ? ctx.sessionId : undefined

      // ── open：spawn harness，等 ready 行 ──
      if (command === 'open') {
        const aliveCount = [...sessions.values()].filter((s) => s.projectId === projectId).length
        if (aliveCount >= MAX_SESSIONS_PER_PROJECT) {
          return { output: `探索会话数已达上限（${MAX_SESSIONS_PER_PROJECT}/项目）：先 close 旧会话再开新会话。`, isError: true }
        }
        const project = findProject(projectId)
        const rootRaw = project?.root_path
        if (!rootRaw) return { output: `项目不存在（projectId=${projectId}）。`, isError: true }
        let root: string
        try {
          root = realpathSync(rootRaw)
        } catch {
          return { output: `项目根不可读：${rootRaw}`, isError: true }
        }
        let entry = typeof input.entry === 'string' ? input.entry.trim() : ''
        if (!entry) {
          const declaration = readLaunchDeclaration(root)
          if (declaration?.ok) {
            const py = [...declaration.launch.command].reverse().find((part) => part.toLowerCase().endsWith('.py'))
            if (py) entry = py
          }
        }
        if (!entry) return { output: '缺少 entry：传项目根内主程序 .py 相对路径，或项目根先产出 LAUNCH.json（open 会自动取其入口）。', isError: true }
        if (isAbsolute(entry) || !entry.toLowerCase().endsWith('.py')) {
          return { output: `entry 必须是项目根内 .py 相对路径（收到 ${entry}）。`, isError: true }
        }
        let target: string
        try {
          target = realpathSync(resolve(root, entry))
        } catch {
          return { output: `入口不存在：${entry}（先确认主程序文件名）`, isError: true }
        }
        if (!target.startsWith(root + sep) || !statSync(target).isFile()) {
          return { output: `入口越界或不是文件：${entry}`, isError: true }
        }
        let python: string
        const venvPython = join(root, '.venv', 'Scripts', 'python.exe')
        if (existsSync(venvPython)) {
          python = venvPython
        } else {
          try {
            python = await resolvePython()
          } catch (error) {
            return { output: error instanceof Error ? error.message : String(error), isError: true }
          }
        }
        const harnessPath = join(mainRootDir(), 'templates', 'tools', 'drive-harness.py')
        if (!existsSync(harnessPath)) {
          return { output: '平台资产缺失：main/templates/tools/drive-harness.py 不存在（安装异常，勿自行绕行）。', isError: true }
        }
        mkdirSync(join(root, TRACE_DIR_REL), { recursive: true })

        const sessionId = `drive-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
        let proc: DriveHarnessProcess
        try {
          proc = spawnImpl([python, harnessPath, '--entry', entry], root, buildChildExecEnv(process.env))
        } catch (error) {
          return { output: `harness spawn 失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
        }
        const session: DriveSession = {
          id: sessionId,
          projectId,
          root,
          proc,
          startedAt: Date.now(),
          ops: 0,
          findings: [],
          lineBuffer: '',
          queuedLines: [],
          waiting: null,
          exited: false,
          exitCode: null,
        }
        sessions.set(sessionId, session)
        attachProcessListeners(session)

        let ready: Record<string, unknown>
        try {
          ready = await waitLine(session, openTimeoutMs)
        } catch (error) {
          killSession(session, 'open-timeout')
          return { output: `${error instanceof Error ? error.message : String(error)}（open 未就绪，会话已清理）`, isError: true }
        }
        traceLine(session, 'evt', { event: 'ready', ready })
        if (ready.ready !== true) {
          const err = (ready.error ?? {}) as { class?: string; message?: string }
          // 根因批（5cb5e941 实证）：启动失败由工具侧自动落 P2 finding——探索者
          // 「如实上报」不可依赖（狗粮五次 no_root 零上报，零 findings 落盘）。
          if (err.class === 'no_root' || err.class === 'boot_failed') {
            session.findings.push({
              id: `F1-${session.id.slice(-6)}`,
              severity: 'P2',
              title: `平台驱动桥无法接管入口（${err.class}）`,
              expected: '产物可被平台真实驱动（模块级窗口或 run()/main() 无参入口）',
              actual: err.message ?? '无详情',
            })
            persistFindings(session)
            emitDriveTelemetry('desktop_drive_findings', projectId, {
              harness_session_id: sessionId,
              severity: 'P2',
              title: 'platform-drive-unbootable',
              agent_session_id: agentSessionId,
            })
          }
          killSession(session, 'open-failed')
          return {
            output: `驱动桥启动失败（${err.class ?? 'unknown'}）：${err.message ?? '无详情'}。` +
              (err.class === 'no_root' ? '这是入口形态问题——如实记为发现（expected: 可被平台驱动），不要反复重试。' : ''),
            isError: true,
          }
        }
        emitDriveTelemetry('desktop_drive_session_started', projectId, {
          harness_session_id: sessionId,
          agent_session_id: agentSessionId,
          entry,
          actor: 'explorer',
          harness: 'import',
          widgets_initial: ready.widgets_initial,
        })
        return {
          output: [
            `驱动会话已建立：${sessionId}`,
            `入口 ${entry} · 初始控件 ${String(ready.widgets_initial)} 个 · root ${String(ready.root_class)}${Number(ready.roots_all) > 1 ? `（另有 ${Number(ready.roots_all) - 1} 个未驱动）` : ''}`,
            ready.app_prints ? `导入期程序输出：${truncate(String(ready.app_prints), 400)}` : '',
            '下一步：read 拿控件全量快照（id 形如 .!entry）→ act 批量动词 → report 逐条上报 → close。窗口默认隐藏，不会打扰用户。',
          ]
            .filter(Boolean)
            .join('\n'),
          detail: { session_id: sessionId, entry, widgets_initial: ready.widgets_initial },
        }
      }

      // ── 其余命令：必须有会话 ──
      const session = lookupSession(input.session)
      if (!session) {
        return { output: '会话不存在（可能已 close/超时清理）：先 open 建立会话，session 参数用 open 返回的 id。', isError: true }
      }
      if (sessionExpired(session, sessionWallMs)) {
        traceLine(session, 'evt', { event: 'wall-exceeded' })
        killSession(session, 'wall-exceeded')
        return { output: `会话墙钟超限（${Math.round(sessionWallMs / 1000)}s）已自动收口：剩余探索按已获证据收尾并 report。`, isError: true }
      }

      // ── act：批量动词（首错即停） ──
      if (command === 'act') {
        const steps = Array.isArray(input.steps) ? input.steps : []
        if (steps.length === 0 || steps.length > MAX_ACT_STEPS) {
          return { output: `steps 须为 1~${MAX_ACT_STEPS} 个动词对象。`, isError: true }
        }
        for (const step of steps) {
          if (!step || typeof step !== 'object' || typeof step.op !== 'string' || !ACT_OPS.has(step.op) || (step.op !== 'keys' && typeof step.target !== 'string')) {
            return { output: 'steps 每项须为 {op: click|set_text|select|keys, target: 控件id, value?: 值, hold_ms?: 按住毫秒}（keys 可省 target）。', isError: true }
          }
          if (step.hold_ms !== undefined && (typeof step.hold_ms !== 'number' || step.hold_ms < 0 || step.hold_ms > 2_000)) {
            return { output: 'hold_ms 须为 0~2000 的毫秒数（keys 专用）。', isError: true }
          }
        }
        const results: Array<Record<string, unknown>> = []
        let failedAt = -1
        let budgetStop = false
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index] as { op: string; target?: string; value?: unknown; hold_ms?: unknown }
          if (session.ops >= MAX_OPS_PER_SESSION) {
            budgetStop = true
            break
          }
          session.ops += 1
          const payload: Record<string, unknown> = { op: step.op }
          if (typeof step.target === 'string') payload.target = step.target
          if (step.value !== undefined) payload.value = String(step.value)
          if (typeof step.hold_ms === 'number') payload.hold_ms = Math.round(step.hold_ms)
          const startedAt = Date.now()
          let response: Record<string, unknown>
          try {
            response = await requestOp(session, payload, opTimeoutMs)
          } catch (error) {
            traceLine(session, 'req', { ...payload, error: String(error) })
            emitDriveTelemetry('desktop_drive_step', projectId, {
              harness_session_id: session.id,
              step: session.ops,
              op: step.op,
              target: step.target,
              ok: false,
              err_class: 'op_timeout_or_died',
              duration_ms: Date.now() - startedAt,
              agent_session_id: agentSessionId,
            })
            traceLine(session, 'evt', { event: 'session-killed-on-op', op: step.op })
            killSession(session, 'killed')
            return { output: `${error instanceof Error ? error.message : String(error)} 会话已终止——该现象本身就是高价值发现，请 report 后收尾。`, isError: true }
          }
          const durationMs = Date.now() - startedAt
          const ok = response.ok === true
          const err = (response.err ?? {}) as { class?: string; message?: string }
          traceLine(session, 'req', payload)
          traceLine(session, 'res', { step: session.ops, ...response })
          emitDriveTelemetry('desktop_drive_step', projectId, {
            harness_session_id: session.id,
            step: session.ops,
            op: step.op,
            target: step.target,
            ok,
            err_class: err.class,
            duration_ms: durationMs,
            agent_session_id: agentSessionId,
          })
          results.push({
            index,
            ok,
            ...(ok ? {} : { err: `${err.class}: ${err.message}` }),
            ...(Array.isArray(response.app_exceptions) && response.app_exceptions.length > 0 ? { app_exceptions: response.app_exceptions } : {}),
          })
          if (!ok) {
            failedAt = index
            break
          }
        }
        const passed = results.filter((item) => item.ok === true).length
        const lines = [
          `${passed}/${steps.length} 步成功（剩余 op 预算 ${MAX_OPS_PER_SESSION - session.ops}/${MAX_OPS_PER_SESSION}）。`,
          failedAt >= 0 ? `第 ${failedAt + 1} 步失败：${String(results[failedAt]?.err ?? '')}（后续步未执行；target 可能失效，read 重新拿快照）` : '',
          budgetStop ? 'op 预算用尽：本批后续步未执行。' : '',
          results.some((item) => Array.isArray(item.app_exceptions)) ? '注意：部分步触发应用异常（app_exceptions），逐条判断是否 report。' : '',
          results.some((item) => Array.isArray(item.modal_suppressions) && item.modal_suppressions.length > 0)
            ? '注意：部分操作触发模态弹窗被驱动桥拦截/销毁（modal_suppressions，含 messagebox 与自建对话框）——弹窗路径在无头驱动下不可交互，如弹窗内有业务逻辑请据实记录。' : '',
        ].filter(Boolean)
        return { output: lines.join('\n'), isError: failedAt >= 0, detail: { results } }
      }

      // ── read：读动词直通 ──
      if (command === 'read') {
        const op = typeof input.op === 'string' && READ_OPS.has(input.op) ? input.op : 'read'
        if (session.ops >= MAX_OPS_PER_SESSION) {
          return { output: `op 预算用尽（${MAX_OPS_PER_SESSION}）：基于已读状态收尾。`, isError: true }
        }
        session.ops += 1
        const payload: Record<string, unknown> = { op }
        if (typeof input.target === 'string') payload.target = input.target
        if (typeof input.path === 'string') payload.path = input.path
        let response: Record<string, unknown>
        try {
          response = await requestOp(session, payload, opTimeoutMs)
        } catch (error) {
          killSession(session, 'killed')
          return { output: `${error instanceof Error ? error.message : String(error)}（会话已终止）`, isError: true }
        }
        traceLine(session, 'req', payload)
        traceLine(session, 'res', response)
        if (response.ok !== true) {
          const err = (response.err ?? {}) as { class?: string; message?: string }
          return { output: `读取失败（${err.class}: ${err.message}）`, isError: true }
        }
        return {
          output: truncate(JSON.stringify(response.data ?? {}, null, 1), 8_000),
          detail: { op, data: response.data },
        }
      }

      // ── report：登记发现并落盘 ──
      if (command === 'report') {
        const rawFinding = (input.finding ?? null) as Record<string, unknown> | null
        if (!rawFinding || typeof rawFinding !== 'object') return { output: 'finding 缺失：report 必须携带完整发现对象。', isError: true }
        const severity = typeof rawFinding.severity === 'string' && SEVERITIES.has(rawFinding.severity) ? (rawFinding.severity as DriveFinding['severity']) : undefined
        const title = typeof rawFinding.title === 'string' ? rawFinding.title.trim() : ''
        const expected = typeof rawFinding.expected === 'string' ? rawFinding.expected.trim() : ''
        const actual = typeof rawFinding.actual === 'string' ? rawFinding.actual.trim() : ''
        if (!severity || !title || !expected || !actual) {
          return { output: 'finding 须含 severity(P0|P1|P2)/title/expected/actual（expected=应发生什么，actual=实际观察到什么）。', isError: true }
        }
        const reproSteps = Array.isArray(rawFinding.repro_steps)
          ? (rawFinding.repro_steps as Array<Record<string, unknown>>).filter((item) => item && typeof item === 'object').slice(0, MAX_REPRO_STEPS)
          : undefined
        // id 竞态修复（2026-10-06 发现⑨）：多会话并发时 `F{文件长度+会话内序号}` 两个会话
        // 各自算出同号（狗粮 1c953320 双 F1 实锤）——id 追加会话短标识保证唯一。
        const sessionShort = session.id.slice(-6)
        const idSeed = readFindingsFile(session.root).length + session.findings.length + 1
        const record: DriveFinding = { id: `F${idSeed}-${sessionShort}`, severity, title, expected, actual, ...(reproSteps && reproSteps.length > 0 ? { repro_steps: reproSteps } : {}) }
        // supersedes 降级通道（2026-10-06 发现⑧）：对照实验推翻早前判断时，旧条 severity
        // 结构化覆盖（新条仍独立入文件保留证据链；旧条加 superseded_by 溯源）。
        let supersedeNote = ''
        const supersedesId = typeof rawFinding.supersedes === 'string' ? rawFinding.supersedes.trim() : ''
        if (supersedesId) {
          const existing = readFindingsFile(session.root)
          const old = existing.find((item) => item.id === supersedesId)
          if (old && old.severity !== severity) {
            const from = old.severity
            old.severity = severity
            ;(old as unknown as Record<string, unknown>).superseded_by = record.id
            writeFileSync(
              join(session.root, DRIVE_FINDINGS_REL),
              JSON.stringify({ project_id: session.projectId, generated_at: new Date().toISOString(), findings: existing }, null, 2),
              'utf8',
            )
            supersedeNote = `；已修正 ${supersedesId}：${from}→${severity}（${record.id}）`
          } else if (old) {
            supersedeNote = `；${supersedesId} severity 已是 ${severity}，无需修正`
          } else {
            supersedeNote = `；未找到 ${supersedesId}（supersedes 未生效，本条照常入文件）`
          }
        }
        session.findings.push(record)
        persistFindings(session)
        emitDriveTelemetry('desktop_drive_findings', projectId, {
          harness_session_id: session.id,
          severity,
          title,
          agent_session_id: agentSessionId,
        })
        const counts = { P0: 0, P1: 0, P2: 0 }
        for (const item of [...readFindingsFile(session.root)]) counts[item.severity] = (counts[item.severity] ?? 0) + 1
        return {
          output: `已记录 ${record.id}（${severity}）：${title}\n项目累计发现：P0×${counts.P0} P1×${counts.P1} P2×${counts.P2}（已写入 ${DRIVE_FINDINGS_REL}，MVP 过目页会呈现）${supersedeNote}。`,
          detail: { finding_id: record.id },
        }
      }

      // ── close：优雅收尾 ──
      if (command === 'close') {
        let closeInfo = ''
        try {
          const response = await requestOp(session, { op: 'close' }, closeTimeoutMs)
          closeInfo = response.ok === true ? 'harness 优雅退出' : `close 响应异常（${JSON.stringify(response.err ?? {})}），已强杀`
        } catch (error) {
          closeInfo = `${error instanceof Error ? error.message : String(error)}（已强杀收尾）`
        }
        const summary = {
          steps: session.ops,
          wall_ms: Date.now() - session.startedAt,
          findings: session.findings.length,
        }
        traceLine(session, 'evt', { event: 'closed', reason: typeof input.reason === 'string' ? input.reason : '', ...summary })
        killSession(session, 'closed')
        return {
          output: `会话已收口（${closeInfo}）：动词 ${summary.steps} 次 · 墙钟 ${Math.round(summary.wall_ms / 1000)}s · 本次上报发现 ${summary.findings} 条。${input.reason ? `收尾原因：${String(input.reason)}` : ''}`,
          detail: summary,
        }
      }

      return { output: `未知 command：${command}（open/act/read/report/close）`, isError: true }
    },
  }
}

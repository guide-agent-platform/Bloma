/**
 * drive_project_app — 探索驱动测试 A 档工具端（2026-10-05，实施稿
 * BLOMA《Bloma-探索驱动测试实施稿-20261005》，批8 下半双腿化）。
 *
 * 拍板（10-05）：Agent 可获受控通路真实操控被测程序；两轨原则——操控给 Agent、
 * 裁决保持确定性（findings 只入过目页/修复账本，不进门禁）；探索者与 implement
 * 结构性分离（本工具仅装配进 research 角色子会话，不进 implement 面）。
 *
 * 机制：spawn 被测程序（tk 腿=平台资产 drive-harness.py 进程内桥；webview 腿=骨架
 * v2 app.py --drive-port 控制服务器），管理会话生命周期与四项预算、每步 trace 落盘
 * 00_VERIFY/drive-trace/、findings 汇总落 00_VERIFY/drive-findings.json（MVP 过目页
 * 呈现）。会话机制层在 drive-app-session.ts（R7 拆分）；webview 协议件在
 * drive-app-webview.ts。
 */
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { mainRootDir } from '../platform/paths'
import { readLaunchDeclaration } from './launch-smoke'
import { buildChildExecEnv, defaultResolvePython } from './child-exec-tool'
import { matchDriveServerLine, reserveDrivePort, webviewListFiles, webviewPost, webviewReadFile, WEBVIEW_DOM_SNAPSHOT_JS } from './drive-app-webview'
import {
  CLOSE_TIMEOUT_MS,
  DEFAULT_SESSION_WALL_MS,
  DRIVE_FINDINGS_REL,
  MAX_ACT_STEPS,
  MAX_OPS_PER_SESSION,
  MAX_REPRO_STEPS,
  MAX_SESSIONS_PER_PROJECT,
  OP_TIMEOUT_MS,
  OPEN_TIMEOUT_MS,
  TRACE_DIR_REL,
  attachProcessListeners,
  defaultSpawn,
  detectDriveLeg,
  dispatchWebviewAct,
  emitDriveTelemetry,
  killSession,
  lookupSession,
  persistFindings,
  probeDriveServer,
  readFindingsFile,
  requestOp,
  sessionExpired,
  sessions,
  traceLine,
  truncate,
  waitForMatch,
  waitLine,
} from './drive-app-session'
import type { DriveFinding, DriveHarnessProcess, DriveSession } from './drive-app-session'

export { DRIVE_FINDINGS_REL, disposeDriveSessions } from './drive-app-session'
export type { DriveHarnessProcess, DriveFinding } from './drive-app-session'

const ACT_OPS: ReadonlySet<string> = new Set(['click', 'set_text', 'select', 'keys', 'js', 'call'])
const READ_OPS: ReadonlySet<string> = new Set(['read', 'read_file', 'list_files'])
const SEVERITIES: ReadonlySet<string> = new Set(['P0', 'P1', 'P2'])
const WEBVIEW_ACT_OPS: ReadonlySet<string> = new Set(['click', 'set_text', 'js', 'call'])
const TK_ACT_OPS: ReadonlySet<string> = new Set(['click', 'set_text', 'select', 'keys'])

/** harness 进程抽象（spawn 可注入——单测零真实子进程，陷阱 35）。 */

export interface DriveAppDeps {
  spawnImpl?: (command: string[], cwd: string, env: Record<string, string>) => DriveHarnessProcess
  resolvePython?: () => Promise<string>
  sessionWallMs?: number
  /** 以下超时均可注入（单测用真实子毫秒值，不真等 10s） */
  opTimeoutMs?: number
  openTimeoutMs?: number
  closeTimeoutMs?: number
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
      '探索者专属：真实操控本项目的桌面 GUI 程序做探索性测试（窗口隐藏不打扰用户，双腿自动路由：' +
      'pywebview 骨架 v2 产物走 webview 腿——/eval 同步 DOM JS + /call 直调 Api 桥；tkinter 存量产物走进程内驱动桥 v2——' +
      'boot 模式接管真实入口，主循环/绑定/收尾全真实）。流程：open（entry 缺省自动取 LAUNCH.json 入口）→ ' +
      'read（webview 腿=DOM 快照：状态条/输入/按钮/列表行/气泡；tk 腿=控件树 + module_state 游戏引擎坐标/分数可读）→ ' +
      'act 批量动词 ≤8 步/次（webview 腿：click/set_text 按元素 id、js 同步表达式、call 直调 Api 方法如 list_items；' +
      'tk 腿：click/set_text/select/keys，移动/长按类按键配 hold_ms 300~700 按住后读差分）→ ' +
      'read/read_file/list_files 验证状态与文件副作用 → report 逐条上报发现（P0/P1/P2 + title/expected/actual + repro_steps）→ close 收尾。' +
      '程序异常随响应返回且会话存活（UI 线程被模态/死循环阻塞则动词超时杀会话——现象本身就是高价值发现）；' +
      '每动词 ≤10s（hold 计入）、每会话 60 op/5 分钟、每项目至多 2 会话。' +
      '你不是实现者：按 PRD 验收点逐条探索（正常/空输入/边界/重复/乱序/键盘响应），发现即 report，不要修代码。',
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
              op: { type: 'string', enum: ['click', 'set_text', 'select', 'keys', 'js', 'call'], description: 'click/set_text 双腿通用（target=控件id或元素id）；select/keys 仅 tkinter 腿；js/call 仅 webview 腿（js=同步 JS 表达式；call=直调 Api 桥方法）' },
              target: { type: 'string', description: '控件 id（tkinter 腿 read 返回的 path 形态 / webview 腿元素 id；keys 可省略=发到焦点/root）' },
              value: { type: 'string', description: 'set_text/select 的值 / keys 的空格分隔键名（如 Left a space）' },
              js: { type: 'string', description: 'webview 腿 js 动词：同步 JS 表达式（/eval 通道；不 await Promise，异步请走 call）' },
              api: { type: 'string', description: 'webview 腿 call 动词：Api 桥方法名（如 list_items）' },
              args: { type: 'array', description: 'webview 腿 call 动词的参数数组' },
              hold_ms: { type: 'number', description: 'keys 专用：按住毫秒数（0~2000；移动/长按类按键用 300~700，期间主循环真实运行）' },
            },
            required: ['op', 'target'],
          },
        },
        op: { type: 'string', enum: ['read', 'read_file', 'list_files'], description: 'read 命令的读动词（缺省 read 全量快照：tk 腿=控件树+module_state；webview 腿=DOM 快照）' },
        target: { type: 'string', description: 'read：单控件 id（tk 腿）' },
        path: { type: 'string', description: 'read_file：项目根内相对路径' },
        js: { type: 'string', description: 'read（webview 腿）：自定义同步 JS 表达式代替缺省 DOM 快照' },
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
        // 腿路由（批8 下半）：骨架 v2 产物（requirements 含 pywebview 或 LAUNCH ui 声明）走 webview 腿
        const leg = detectDriveLeg(root)
        let drivePort = 0
        let harnessPath = ''
        if (leg === 'webview') {
          try {
            drivePort = await reserveDrivePort()
          } catch (error) {
            return { output: `无法预留控制端口：${error instanceof Error ? error.message : String(error)}`, isError: true }
          }
        } else {
          harnessPath = join(mainRootDir(), 'templates', 'tools', 'drive-harness.py')
          if (!existsSync(harnessPath)) {
            return { output: '平台资产缺失：main/templates/tools/drive-harness.py 不存在（安装异常，勿自行绕行）。', isError: true }
          }
        }
        mkdirSync(join(root, TRACE_DIR_REL), { recursive: true })

        const sessionId = `drive-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
        let proc: DriveHarnessProcess
        try {
          proc =
            leg === 'webview'
              ? spawnImpl([python, entry, '--drive-port', String(drivePort)], root, buildChildExecEnv(process.env))
              : spawnImpl([python, harnessPath, '--entry', entry], root, buildChildExecEnv(process.env))
        } catch (error) {
          return { output: `harness spawn 失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
        }
        const session: DriveSession = {
          id: sessionId,
          projectId,
          root,
          leg,
          ...(leg === 'webview' ? { httpPort: drivePort } : {}),
          webviewLog: '',
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

        // webview 腿就绪：等 DRIVE_SERVER 行 + 探针；不走 tk 的 ready 行协议
        if (leg === 'webview') {
          let port = drivePort
          try {
            const matched = await waitForMatch(session, openTimeoutMs, (line) => {
              const hit = matchDriveServerLine(line)
              return hit ? { drive_server: true, port: hit.port } : null
            })
            port = Number(matched.port)
            session.httpPort = port
            await probeDriveServer(port, Math.min(opTimeoutMs, 8_000))
          } catch (error) {
            traceLine(session, 'evt', { event: 'open-failed', error: String(error), stdout_tail: session.webviewLog.slice(-400) })
            killSession(session, 'open-failed')
            return {
              output:
                `${error instanceof Error ? error.message : String(error)}（webview 驱动腿未就绪——主程序启动抛异常/依赖未装/窗口未达都会如此，` +
                `会话已清理；stdout 尾部：${truncate(session.webviewLog || '（无输出）', 300)}）`,
              isError: true,
            }
          }
          traceLine(session, 'evt', { event: 'ready', leg: 'webview', port })
          emitDriveTelemetry('desktop_drive_session_started', projectId, {
            harness_session_id: sessionId,
            agent_session_id: agentSessionId,
            entry,
            actor: 'explorer',
            harness: 'webview',
            port,
          })
          return {
            output: [
              `驱动会话已建立（webview 腿）：${sessionId}`,
              `入口 ${entry} · 控制服务器 127.0.0.1:${port}（/call 逻辑层 + /eval DOM JS）· 窗口隐藏不打扰用户`,
              '下一步：read 拿 DOM 快照（状态条/输入/按钮/列表行/气泡）→ act（click/set_text 按元素 id；js=同步表达式直执行；call=直调 Api 方法如 list_items 观察逻辑层状态）→ report 逐条上报 → close。',
            ].join('\n'),
            detail: { session_id: sessionId, entry, leg: 'webview', port },
          }
        }

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
          if (!step || typeof step !== 'object' || typeof step.op !== 'string' || !ACT_OPS.has(step.op)) {
            return { output: 'steps 每项须为合法动词对象（op+target/value 等）。', isError: true }
          }
          // 腿专属动词分流（批8 下半）：tk 腿 select/keys；webview 腿 js/call
          if (session.leg === 'webview' && !WEBVIEW_ACT_OPS.has(step.op)) {
            return { output: `动词 ${step.op} 不适用 webview 腿（可用：click/set_text/js/call）——键盘/选择类用 js 动词（new KeyboardEvent(...) 后 dispatchEvent）。`, isError: true }
          }
          if (session.leg === 'tk' && !TK_ACT_OPS.has(step.op)) {
            return { output: `动词 ${step.op} 不适用 tkinter 腿（可用：click/set_text/select/keys）。`, isError: true }
          }
          if (step.op !== 'keys' && step.op !== 'js' && step.op !== 'call' && typeof step.target !== 'string') {
            return { output: 'click/set_text/select 需要 target（控件 id 或元素 id）。', isError: true }
          }
          if (step.op === 'js' && (typeof step.js !== 'string' || !step.js.trim())) {
            return { output: 'js 动词需要 js 参数（同步 JS 表达式；不 await Promise）。', isError: true }
          }
          if (step.op === 'call' && typeof step.api !== 'string') {
            return { output: 'call 动词需要 api 参数（Api 桥方法名，如 list_items）。', isError: true }
          }
          if (step.hold_ms !== undefined && (typeof step.hold_ms !== 'number' || step.hold_ms < 0 || step.hold_ms > 2_000)) {
            return { output: 'hold_ms 须为 0~2000 的毫秒数（keys 专用）。', isError: true }
          }
        }
        const results: Array<Record<string, unknown>> = []
        let failedAt = -1
        let budgetStop = false
        for (let index = 0; index < steps.length; index += 1) {
          const step = steps[index] as { op: string; target?: string; value?: unknown; hold_ms?: unknown; js?: unknown; api?: unknown; args?: unknown }
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
            response =
              session.leg === 'webview'
                ? await dispatchWebviewAct(
                    session,
                    {
                      op: step.op,
                      target: typeof step.target === 'string' ? step.target : undefined,
                      value: step.value === undefined ? undefined : String(step.value),
                      js: typeof step.js === 'string' ? step.js : undefined,
                      api: typeof step.api === 'string' ? step.api : undefined,
                      args: Array.isArray(step.args) ? step.args : undefined,
                    },
                    opTimeoutMs,
                  )
                : await requestOp(session, payload, opTimeoutMs)
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

      // ── read：读动词直通（双腿） ──
      if (command === 'read') {
        const op = typeof input.op === 'string' && READ_OPS.has(input.op) ? input.op : 'read'
        if (session.ops >= MAX_OPS_PER_SESSION) {
          return { output: `op 预算用尽（${MAX_OPS_PER_SESSION}）：基于已读状态收尾。`, isError: true }
        }
        session.ops += 1
        if (session.leg === 'webview') {
          // read_file/list_files：工具侧直读项目根（webview 腿无进程内 harness，同界同限额）
          if (op === 'read_file') {
            const relPath = typeof input.path === 'string' ? input.path : ''
            const result = webviewReadFile(session.root, relPath)
            if ('error' in result) return { output: `读取失败（${result.error}）`, isError: true }
            traceLine(session, 'req', { op, path: relPath })
            traceLine(session, 'res', { path: result.path, truncated: result.truncated, bytes: result.content.length })
            return {
              output: truncate(`路径 ${result.path}${result.truncated ? '（截断）' : ''}\n${result.content}`, 8_000),
              detail: { op, data: result },
            }
          }
          if (op === 'list_files') {
            const result = webviewListFiles(session.root)
            traceLine(session, 'req', { op })
            traceLine(session, 'res', { files: result.files.length, truncated: result.truncated })
            return { output: truncate(JSON.stringify(result, null, 1), 8_000), detail: { op, data: result } }
          }
          // read：缺省 DOM 快照；自定义同步 js 可代
          const customJs = typeof input.js === 'string' && input.js.trim() ? input.js.trim() : ''
          let response: Record<string, unknown>
          try {
            response = await webviewPost(session.httpPort ?? 0, '/eval', { js: customJs || WEBVIEW_DOM_SNAPSHOT_JS }, opTimeoutMs)
          } catch (error) {
            killSession(session, 'killed')
            return { output: `${error instanceof Error ? error.message : String(error)}（会话已终止）`, isError: true }
          }
          traceLine(session, 'req', { op: 'read', js: customJs ? customJs.slice(0, 400) : '(dom-snapshot)' })
          traceLine(session, 'res', response)
          if (response.ok !== true) {
            return { output: `读取失败（webview: ${String(response.error ?? '')}）`, isError: true }
          }
          const data = {
            ...(typeof response.result === 'object' && response.result !== null ? (response.result as Record<string, unknown>) : { value: response.result }),
            stdout_tail: session.webviewLog.slice(-400),
          }
          return { output: truncate(JSON.stringify(data, null, 1), 8_000), detail: { op, data } }
        }
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
        if (session.leg === 'webview') {
          // webview 腿：无 stdin close 动词——taskkill 进程树（含 WebView2 子进程）
          killSession(session, 'closed')
          const summary = {
            steps: session.ops,
            wall_ms: Date.now() - session.startedAt,
            findings: session.findings.length,
          }
          traceLine(session, 'evt', { event: 'closed', reason: typeof input.reason === 'string' ? input.reason : '', ...summary })
          return {
            output: `会话已收口（webview 腿进程树终止）：动词 ${summary.steps} 次 · 墙钟 ${Math.round(summary.wall_ms / 1000)}s · 本次上报发现 ${summary.findings} 条。${input.reason ? `收尾原因：${String(input.reason)}` : ''}`,
            detail: summary,
          }
        }
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

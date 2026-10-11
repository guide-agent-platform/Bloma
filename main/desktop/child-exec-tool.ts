/**
 * implement 子会话受控执行工具（2026-10-05 方案 B：quick 真实红绿闭环缺口根治）。
 *
 * 根因（eba1cb83 狗粮实证）：quick 直通道按拍板不产契约，而 run_project_driver 是
 * 契约声明制——子会话写了自测脚本（自测.py 等 4 个）却全链无门执行，功能正确性
 * 只能靠交付时 LAUNCH 冒烟（验「窗口能开」不验功能）。本工具把受控执行刀发到
 * implement 子会话手里：写完自测当场跑，红绿闭环收敛在一次委派内部。
 *
 * 收窄口径（裁决边界从「执行归父」修订为「implement 子会话可有受控执行」）：
 * - 只跑 `python`（解析为绝对路径后 execFile，无 shell 解释；真解释器是 python，
 *   python3 是 MS Store 空壳——陷阱 29）；目标必须是项目根内已存在的 .py 文件；
 * - env 白名单：最小生存 env + PATH + TEMP/TMP + PYTHONIOENCODING（无渠道密钥/
 *   无 BLOMA_*，防子进程拿到上游凭据）；cwd 钉死项目根；
 * - 超时硬停（缺省 90s，上限 180s）；每子会话执行次数上限（缺省 12，防失控循环）；
 * - spawn/解释器解析可注入（测试零真实子进程）；执行器复用 execFileDriverSpawn
 *   （超时强杀/ENOENT/退出码语义与契约驱动同源）。
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { execFile } from 'node:child_process'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { execFileDriverSpawn, DriverExecutionError, parseDriverStdout, routeDriverOutcome, type DriverSpawn } from './process-driver'
import { findProject } from '../project/project-service'

const DEFAULT_TIMEOUT_MS = 90_000
const MAX_TIMEOUT_MS = 180_000
const MIN_TIMEOUT_MS = 5_000
const DEFAULT_MAX_RUNS = 12
const MAX_ARGS = 8
/** 最小生存 env（同 process-driver MINIMUM_SURVIVAL_ENV 家族）+ PATH/TEMP——解释器解析与临时目录刚需。 */
const CHILD_EXEC_ENV_KEYS: readonly string[] = [
  'SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP',
]

export interface ChildScriptRunnerDeps {
  spawn?: DriverSpawn
  resolvePython?: () => Promise<string>
  maxRuns?: number
  defaultTimeoutMs?: number
}

/** 解析 python 绝对路径（where python 首个命中；进程内缓存）。 */
let cachedPython: string | undefined
export async function defaultResolvePython(): Promise<string> {
  if (cachedPython) return cachedPython
  return await new Promise<string>((resolvePromise, reject) => {
    execFile('where', ['python'], { windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(new Error('python-not-found: 主机 PATH 上未找到 python（用 probe_desktop_env 探测环境，勿编造运行结果）'))
        return
      }
      const first = String(stdout).split(/\r?\n/).map((line) => line.trim()).find(Boolean)
      if (!first) {
        reject(new Error('python-not-found: where python 无输出'))
        return
      }
      cachedPython = first
      resolvePromise(first)
    })
  })
}

export function buildChildExecEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of CHILD_EXEC_ENV_KEYS) {
    const value = parentEnv[key]
    if (value !== undefined) env[key] = value
  }
  // 输出编码归一（同 buildDriverEnv：Windows Python 缺省 GBK console 代码页，utf8 解码会乱）
  env.PYTHONIOENCODING = parentEnv.PYTHONIOENCODING ?? 'utf-8'
  return env
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = text.slice(0, Math.floor(maxChars * 0.6))
  const tail = text.slice(-Math.floor(maxChars * 0.3))
  return `${head}\n……（中略 ${text.length - head.length - tail.length} 字符）……\n${tail}`
}

export function buildChildScriptRunnerTool(projectId: string, deps: ChildScriptRunnerDeps = {}): AgentLoopTool {
  const spawn = deps.spawn ?? execFileDriverSpawn
  const resolvePython = deps.resolvePython ?? defaultResolvePython
  const maxRuns = deps.maxRuns ?? DEFAULT_MAX_RUNS
  const defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  let runs = 0

  return {
    name: 'run_project_script',
    description:
      '在项目目录真实执行 Python 自测：script 指向已有 .py，或 code 提供短代码（两者只能选一个，无需创建临时脚本）。' +
      '区分进程退出与业务断言：退出码0只说明脚本正常退出；声明的 PASS/FAIL/BLOCKED 场景按回读判断。脚本须在项目根内；短代码在同一工作目录执行；缺省90秒、上限180秒；' +
      '全程至多 12 次。推荐输出用 `PASS/FAIL <场景名>` 行锚点（场景名与契约声明一致，平台复跑可对账）。' +
      'GUI 程序请写无头自测（构造逻辑对象断言，不要真开主循环）。',
    input_schema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '项目根内相对路径（如 自测.py），必须 .py 且已存在' },
        code: { type: 'string', description: '单次 Python 短代码，最多 16000 字符；与 script 互斥，在项目目录执行，沿用相同解释器和环境隔离' },
        args: { type: 'array', items: { type: 'string' }, description: '传给脚本的参数（至多 8 个）' },
        timeout_ms: { type: 'number', description: `超时毫秒（${MIN_TIMEOUT_MS / 1000}s~${MAX_TIMEOUT_MS / 1000}s，缺省 90s）` },
      },
    },
    execute: async (input) => {
      if (runs >= maxRuns) {
        return {
          output: `执行预算用尽（${maxRuns} 次）：剩余工作请基于已有红绿结果收尾，如实把未验证项写进 DELIVERY.md，不要反复尝试。`,
          isError: true,
          budgetExhausted: true,
        }
      }
      const script = typeof input.script === 'string' ? input.script.trim() : ''
      const inlineCode = typeof input.code === 'string' ? input.code : ''
      if (Boolean(script) === Boolean(inlineCode.trim()) || inlineCode.length > 16_000) {
        return { output: '提供 script 或 code 中的一项；code 最多 16000 字符。', isError: true }
      }
      if (script && isAbsolute(script)) {
        return { output: 'script 必须是项目根内相对路径（如 自测.py），不接受绝对路径。', isError: true }
      }
      const project = findProject(projectId)
      const root = project?.root_path
      if (!root) {
        return { output: `项目不存在（projectId=${projectId}），无法定位工作目录。`, isError: true }
      }
      let rootReal: string
      let target: string
      try {
        rootReal = realpathSync(root)
        target = script ? realpathSync(resolve(rootReal, script)) : rootReal
      } catch {
        return { output: `脚本不存在：${script}（先 write_file 写入项目根再运行）`, isError: true }
      }
      if (script && !target.startsWith(rootReal + sep)) {
        return { output: `脚本越界：${script} 不在项目根内。`, isError: true }
      }
      if (script && !target.toLowerCase().endsWith('.py')) {
        return { output: `只允许运行 .py 脚本（当前：${script}）。`, isError: true }
      }
      try {
        if (script && !statSync(target).isFile()) {
          return { output: `目标不是文件：${script}`, isError: true }
        }
      } catch {
        return { output: `脚本不可读：${script}`, isError: true }
      }
      const args = Array.isArray(input.args)
        ? input.args.filter((item): item is string => typeof item === 'string').slice(0, MAX_ARGS)
        : []
      const requested = typeof input.timeout_ms === 'number' ? input.timeout_ms : defaultTimeoutMs
      const timeoutMs = Math.min(Math.max(Math.round(requested) || defaultTimeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)

      let python: string
      if (existsSync(join(rootReal, '.venv', 'Scripts', 'python.exe'))) {
        // venv 一致性（2026-10-05 迁移批）：install_packages 建过 .venv 后，自测自动改用
        // venv 解释器——第三方依赖（pystray/sounddevice 等）只在 venv 里，系统 python
        // import 不到会造成「装了还红」的假故障。
        python = join(rootReal, '.venv', 'Scripts', 'python.exe')
      } else {
        try {
          python = await resolvePython()
        } catch (error) {
          return { output: error instanceof Error ? error.message : String(error), isError: true }
        }
      }

      const startedAt = Date.now()
      runs += 1
      const label = script || '单次短代码'
      try {
        const { code, stdout, stderr } = await spawn({
          command: [python, ...(script ? [target] : ['-c', inlineCode]), ...args],
          timeoutMs,
          env: buildChildExecEnv(process.env),
          cwd: rootReal,
        })
        const durationMs = Date.now() - startedAt
        const parsed = parseDriverStdout(stdout)
        const routing = routeDriverOutcome(code, parsed.scenarios)
        const verificationStatus = routing.routing !== 'pass' ? routing.routing : parsed.scenarios.some(s => s.outcome === 'pass') ? 'pass' : 'not_reported'
        const verdict = `进程退出码 ${code}；场景回读：${verificationStatus === 'not_reported' ? '未报告，不能据退出码宣称业务通过' : routing.reason}`
        return {
          isError: routing.routing !== 'pass',
          output: [
            `运行 ${label}${args.length > 0 ? ` ${args.join(' ')}` : ''}（真实执行，${durationMs}ms）`,
            verdict,
            `--- stdout ---`,
            truncate(stdout, 8_000) || '（空）',
            `--- stderr（尾 2KB）---`,
            truncate(stderr, 2_000) || '（空）',
            `（剩余执行预算 ${maxRuns - runs}/${maxRuns} 次）`,
          ].join('\n'),
          detail: { script: label, code, durationMs, run_index: runs, verification_status: verificationStatus },
        }
      } catch (error) {
        if (error instanceof DriverExecutionError) {
          return {
            output: `执行失败（${error.kind}）：${error.message}。timeout=环境类不要反复重试；not-found=解释器路径问题，用 probe_desktop_env 诊断。`,
            isError: true,
            feedback: { schema_version: 1, execution: 'failed', verification: 'unverified', category: 'environment', recovery: 'prepare_environment', reason: error.kind },
          }
        }
        return { output: `执行异常：${error instanceof Error ? error.message : String(error)}`, isError: true }
      }
    },
  }
}

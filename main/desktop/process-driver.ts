/**
 * 桌面驱动执行器（批次 C，2026-09-24）——按工程契约 spawn 子进程 + 断言读回 + 三分类路由。
 *
 * 依据实施稿第二/六节：desktop-verify 阶段的验收执行器——「验证结论只看驱动
 * 执行回读，不采信模型自述」。安全边界三件：
 *   1. 契约声明制：只执行 contract.json 里 driver/self_check 注册过的命令（schema 校验前置）；
 *   2. env 白名单：子进程环境只透传白名单变量 + 最小生存集（SystemRoot/PATH 等——
 *      Windows 下缺 SystemRoot 子进程直接异常，属已知平台事实）；
 *   3. 超时硬停：契约 timeout_ms（1s-10min 有界）到点强杀，按 timeout 分类。
 *
 * 三分类路由（批次 D 接修复轮）：
 *   pass（0/全绿）  → 允许推进；
 *   fail（1/有断言失败）→ 路由进修复轮（blocked 之外的一切失败）；
 *   blocked（2/环境缺失 或 timeout/spawn 失败）→ 不进修复轮（转装配/人工）。
 *
 * 断言读回：stdout 行级锚点解析（PASS/FAIL/BLOCKED/SUMMARY——骨架 driver-skeleton.py
 * 的输出契约）；锚点缺失时以退出码为准（契约声明制下退出码是驱动作者的自声明语义，
 * 锚点是增强取证——两者冲突以更保守者为准）。
 *
 * spawn 注入式（DriverSpawn）：单测零真实子进程；生产 execFileDriverSpawn。
 */

import { execFile } from 'node:child_process'
import { violatesCommandBlacklist, type ProjectContract } from './contract-schema'

// =========================================================================
// 执行面类型
// =========================================================================

/** 驱动执行请求（命令 + 超时 + 环境——由契约派生，执行器不收自由命令）。 */
export interface DriverCommandRequest {
  command: readonly string[]
  timeoutMs: number
  /** 白名单过滤后的子进程环境（执行器拼最小生存集，spawn 实现不再自加）。 */
  env: Record<string, string>
  cwd: string
}

/** 可注入的子进程执行面。 */
export type DriverSpawn = (request: DriverCommandRequest) => Promise<{ code: number; stdout: string; stderr: string }>

/** 驱动失败形态（DriverExecutionError.code 区分路由）。 */
export type DriverFailureKind = 'not-found' | 'timeout' | 'spawn-failed'

/** 驱动执行错误（spawn 层异常翻译；非「驱动断言失败」——断言失败是合法结果）。 */
export class DriverExecutionError extends Error {
  constructor(
    public readonly kind: DriverFailureKind,
    message: string,
  ) {
    super(message)
  }
}

// =========================================================================
// 结果与路由
// =========================================================================

/** 单场景读回（行级锚点解析产物）。 */
export interface DriverScenarioOutcome {
  name: string
  outcome: 'pass' | 'fail' | 'blocked' | 'skipped'
}

/** 驱动执行结果（driver-report.json 的内存形态——对齐阶段表 desktop-verify gate 产物）。 */
export interface DriverExecutionReport {
  /** 三分类路由结论。 */
  routing: 'pass' | 'fail' | 'blocked'
  /** 驱动退出码（超时/未起为 null）。 */
  exitCode: number | null
  /** 行级锚点读回（缺锚点时为空数组——以退出码为准）。 */
  scenarios: DriverScenarioOutcome[]
  /** SUMMARY 行解析（驱动自报计数；与 scenarios 不一致时报告携带两者供裁决）。 */
  summaryLine: string | null
  /** stdout 截断快照（取证；上限 8KB）。 */
  stdoutExcerpt: string
  stderrExcerpt: string
  /** 执行的命令（留档）。 */
  command: string
  durationMs: number
  /** 路由原因（人读，进报告与事件流）。 */
  routingReason: string
  startedAt: string
}

/** 三分类路由判定（纯函数：退出码 + 读回锚点合成）。 */
export function routeDriverOutcome(exitCode: number, scenarios: DriverScenarioOutcome[]): { routing: 'pass' | 'fail' | 'blocked'; reason: string } {
  const failed = scenarios.filter((s) => s.outcome === 'fail')
  const blocked = scenarios.filter((s) => s.outcome === 'blocked')
  // 锚点读回优先（比退出码保守）：
  // - 任何 BLOCKED 锚点 → blocked（哪怕退出码 0——驱动作者可能误写 main 路由）
  // - 无 BLOCKED 但有 FAIL 锚点 → fail（哪怕退出码 0/2——fail 必须进修复轮）
  if (blocked.length > 0) {
    return { routing: 'blocked', reason: `驱动读回含 ${blocked.length} 个 BLOCKED 场景（环境类，不进修复轮）：${blocked.map((s) => s.name).join('、')}` }
  }
  if (failed.length > 0) {
    return { routing: 'fail', reason: `驱动读回含 ${failed.length} 个 FAIL 场景（路由进修复轮）：${failed.map((s) => s.name).join('、')}` }
  }
  // 锚点全绿（或无锚点）→ 退出码裁决
  if (exitCode === 0) {
    return scenarios.length > 0
      ? { routing: 'pass', reason: `退出码 0，读回 ${scenarios.filter((s) => s.outcome === 'pass').length}/${scenarios.length} 场景全绿` }
      : { routing: 'pass', reason: '退出码 0（无行级锚点，按契约退出码语义判定）' }
  }
  if (exitCode === 2) {
    return { routing: 'blocked', reason: '退出码 2（契约语义：环境阻塞，不进修复轮）' }
  }
  return { routing: 'fail', reason: `退出码 ${exitCode}（契约语义：失败，路由进修复轮）` }
}

// =========================================================================
// env 白名单
// =========================================================================

/**
 * Windows 子进程最小生存集（不可剔除——缺 SystemRoot 子进程异常，PATH 缺失找不到
 * 系统 DLL；这些不构成「环境透传」，是进程能活着的平台事实）。
 */
const MINIMUM_SURVIVAL_ENV: readonly string[] = ['SystemRoot', 'SystemDrive', 'ComSpec', 'PATHEXT', 'windir']

/** 按契约白名单过滤环境：生存集 + 白名单交集（其余一律不透传）。 */
export function buildDriverEnv(contract: ProjectContract, parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of MINIMUM_SURVIVAL_ENV) {
    const value = parentEnv[key]
    if (value !== undefined) env[key] = value
  }
  for (const key of contract.env_whitelist) {
    const value = parentEnv[key]
    if (value !== undefined) env[key] = value
  }
  // PATH：契约声明 BLOMA_* 之外的 PATH 一律重建为最小集（驱动解释器解析靠绝对路径
  // venv python，不依赖 PATH 搜索；保留 PATH 会扩大子进程可达面）
  return env
}

// =========================================================================
// 断言读回（行级锚点解析——对齐 driver-skeleton.py 输出契约）
// =========================================================================

/** stdout 行级锚点解析（PASS/FAIL/BLOCKED/SKIP 场景行 + SUMMARY 行）。 */
export function parseDriverStdout(stdout: string): { scenarios: DriverScenarioOutcome[]; summaryLine: string | null } {
  const scenarios: DriverScenarioOutcome[] = []
  let summaryLine: string | null = null
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    // SUMMARY 行（取最后一条——驱动多次打印时以终值为准）
    if (/^SUMMARY\b/.test(line)) {
      summaryLine = line
      continue
    }
    // 场景行：PASS|FAIL|BLOCKED|SKIP <name>（主名=首段非空白非冒号；支持中文——P0-1a 实证，
    // 2026-10-02：旧 `(\S+)\b` 的 \b 在中文字符间不存在词边界，中文名场景静默解析失败，
    // 裁判门把「全 PASS 中文场景」误判零覆盖；ASCII 名不受影响）
    const match = /^(PASS|FAIL|BLOCKED|SKIP)\s+([^\s:]+)/.exec(line)
    if (match) {
      const outcomeMap = { PASS: 'pass', FAIL: 'fail', BLOCKED: 'blocked', SKIP: 'skipped' } as const
      scenarios.push({ name: match[2], outcome: outcomeMap[match[1] as keyof typeof outcomeMap] })
    }
  }
  return { scenarios, summaryLine }
}

// =========================================================================
// 执行器主体
// =========================================================================

/** 驱动执行输入。 */
export interface RunDriverInput {
  contract: ProjectContract
  /** 工作目录（沙箱内项目根——契约相对命令的解析根）。 */
  cwd: string
  /** 驱动命令选择：driver（默认）| self_check（打包冒烟共用）。 */
  which?: 'driver' | 'self_check'
  parentEnv?: NodeJS.ProcessEnv
  spawn: DriverSpawn
}

const OUTPUT_EXCERPT_LIMIT = 8 * 1024

/**
 * 执行契约声明的驱动命令并生成三分类报告。
 *
 * 前置（fail-closed）：契约命令再次过黑名单（schema 校验后二道防线——防契约
 * 对象在内存中被改）；self_check 面缺省时不可执行（返回 blocked 报告而非抛错——
 * 报告语义自洽）。spawn 异常翻译为 blocked 路由（not-found/timeout/spawn-failed
 * 都是环境类，不进修复轮）。
 */
export async function runContractDriver(input: RunDriverInput): Promise<DriverExecutionReport> {
  const { contract, cwd, spawn } = input
  const which = input.which ?? 'driver'
  const startedAt = new Date().toISOString()
  const start = Date.now()

  const commandSpec = which === 'driver' ? contract.driver : contract.self_check
  const commandLabel = which === 'driver' ? 'driver' : 'self_check'
  if (!commandSpec) {
    return {
      routing: 'blocked',
      exitCode: null,
      scenarios: [],
      summaryLine: null,
      stdoutExcerpt: '',
      stderrExcerpt: '',
      command: `（契约未声明 ${commandLabel}）`,
      durationMs: Date.now() - start,
      routingReason: `契约未声明 ${commandLabel} 命令（声明制：未注册不可执行）`,
      startedAt,
    }
  }

  const blacklistHit = violatesCommandBlacklist(commandSpec.command)
  if (blacklistHit) {
    return {
      routing: 'blocked',
      exitCode: null,
      scenarios: [],
      summaryLine: null,
      stdoutExcerpt: '',
      stderrExcerpt: '',
      command: commandSpec.command.join(' '),
      durationMs: Date.now() - start,
      routingReason: `安全拦截：${blacklistHit}`,
      startedAt,
    }
  }

  const timeoutMs = which === 'driver' ? contract.driver.timeout_ms : 30_000
  const env = buildDriverEnv(contract, input.parentEnv ?? process.env)

  try {
    const { code, stdout, stderr } = await spawn({ command: commandSpec.command, timeoutMs, env, cwd })
    const { scenarios, summaryLine } = parseDriverStdout(stdout)
    // self_check 面：退出码 + 可选 stdout 锚点（不走场景路由——契约 expect 语义）
    if (which === 'self_check') {
      const expect = contract.self_check?.expect_stdout_contains
      const anchorOk = expect === undefined || stdout.includes(expect)
      const routing = code === contract.self_check?.expect_exit && anchorOk ? 'pass' : 'fail'
      return {
        routing,
        exitCode: code,
        scenarios,
        summaryLine,
        stdoutExcerpt: stdout.slice(0, OUTPUT_EXCERPT_LIMIT),
        stderrExcerpt: stderr.slice(0, OUTPUT_EXCERPT_LIMIT),
        command: commandSpec.command.join(' '),
        durationMs: Date.now() - start,
        routingReason: routing === 'pass'
          ? `自检通过（退出码 ${code}${expect ? ` + 锚点「${expect}」命中` : ''}）`
          : `自检未过（退出码 ${code}（期望 ${contract.self_check?.expect_exit}）${expect && !anchorOk ? `；锚点「${expect}」未命中` : ''}）`,
        startedAt,
      }
    }
    const route = routeDriverOutcome(code, scenarios)
    return {
      routing: route.routing,
      exitCode: code,
      scenarios,
      summaryLine,
      stdoutExcerpt: stdout.slice(0, OUTPUT_EXCERPT_LIMIT),
      stderrExcerpt: stderr.slice(0, OUTPUT_EXCERPT_LIMIT),
      command: commandSpec.command.join(' '),
      durationMs: Date.now() - start,
      routingReason: route.reason,
      startedAt,
    }
  } catch (error) {
    const kind = error instanceof DriverExecutionError ? error.kind : 'spawn-failed'
    return {
      routing: 'blocked',
      exitCode: null,
      scenarios: [],
      summaryLine: null,
      stdoutExcerpt: '',
      stderrExcerpt: error instanceof Error ? error.message.slice(0, OUTPUT_EXCERPT_LIMIT) : String(error),
      command: commandSpec.command.join(' '),
      durationMs: Date.now() - start,
      routingReason: `执行未完成（${kind}——环境类，不进修复轮）：${error instanceof Error ? error.message : String(error)}`,
      startedAt,
    }
  }
}

// =========================================================================
// 生产 spawn 实现
// =========================================================================

/** 生产驱动 spawn：execFile + 超时强杀 + ENOENT/超时翻译（cwd 强制——契约相对根）。 */
export function execFileDriverSpawn(request: DriverCommandRequest): Promise<{ code: number; stdout: string; stderr: string }> {
  // 首跑深修（2026-09-26）：原惰性 require 在 esbuild ESM 产物里抛 Dynamic require 错误——改静态 import
  const [command, ...args] = request.command
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { timeout: request.timeoutMs, cwd: request.cwd, env: request.env, windowsHide: true, maxBuffer: 1024 * 512, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
          if (err.code === 'ENOENT') {
            reject(new DriverExecutionError('not-found', `命令不存在：${command}（venv 未装配或解释器路径错）`))
            return
          }
          if (err.killed || err.signal === 'SIGTERM') {
            reject(new DriverExecutionError('timeout', `驱动超时（>${request.timeoutMs}ms）强杀`))
            return
          }
          if (typeof err.code === 'number') {
            resolve({ code: err.code, stdout: stdout ?? '', stderr: stderr ?? '' })
            return
          }
          reject(new DriverExecutionError('spawn-failed', err.message))
          return
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

/**
 * 桌面环境探测器（批次 B，2026-09-24）——desktop-arch 阶段环境清单的实测回填器。
 *
 * 探测三项（P1 路径前置）：
 *   python      解释器版本（坑库：Windows 只探 python，python3 是 MS Store 空壳）；
 *   venv-module venv 模块可用性（骨架隔离前提）；
 *   pyinstaller 打包器可用性（delivered 前打包自检前提）。
 *
 * 失败三分类（对齐实施稿「失败三分类路由」语汇，批次 C 驱动执行共用同一分类面）：
 *   not-found   命令不存在（spawn ENOENT）——装配类缺失，可引导安装；
 *   timeout     探测超时（默认 5s）——环境异常，建议人工介入；
 *   exec-failed 命令存在但执行失败——按 detail 归因。
 *
 * 纯注入设计：spawn 经 ProbeSpawn 注入（生产 execFileProbeSpawn / 测试桩），
 * 单测零真实子进程；真实探测留给接线后的集成路径。
 */

// =========================================================================
// 类型与分类
// =========================================================================

/** 探测项标识。 */
export type DesktopProbeId = 'python' | 'venv-module' | 'pyinstaller'

/** 失败三分类 + ok。 */
export type ProbeStatus = 'ok' | 'not-found' | 'timeout' | 'exec-failed'

/** 单项探测结果。 */
export interface ProbeResult {
  id: DesktopProbeId
  status: ProbeStatus
  /** 解析出的版本（python/pyinstaller；探测失败时缺省）。 */
  version?: string
  /** 人读摘要（原始输出片段或错误原因；进 env-checklist 与报告）。 */
  detail: string
  /** 实际执行的探测命令（回填环境清单留档）。 */
  probeCommand: string
}

/** 可注入的子进程执行面（code=退出码；notFound/timeout 由实现方翻译为状态抛 ProbeError）。 */
export interface ProbeSpawn {
  (command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>
}

/** 探测层错误（实现方翻译 ENOENT/超时后抛出；runProbe 捕获归类）。 */
export class ProbeError extends Error {
  constructor(
    public readonly kind: 'not-found' | 'timeout' | 'exec-failed',
    message: string,
  ) {
    super(message)
  }
}

// =========================================================================
// 探测定义（数据驱动——加探测项只加表）
// =========================================================================

interface ProbeSpec {
  id: DesktopProbeId
  args: readonly string[]
  /** 版本解析器（stdout+stderr 合并解析；无版本概念的探测返回 undefined）。 */
  parseVersion?: (combined: string) => string | undefined
}

const PROBE_SPECS: readonly ProbeSpec[] = [
  {
    id: 'python',
    args: ['--version'],
    parseVersion: (combined) => {
      // Python 3.4+ 输出 stdout；历史版本/某些嵌入环境输出 stderr——两路合并解析
      const match = combined.match(/Python\s+(\d+\.\d+(?:\.\d+)?)/i)
      return match?.[1]
    },
  },
  {
    id: 'venv-module',
    args: ['-c', 'import venv'],
    // import 成功（code=0）即无版本概念；失败时 detail 携带 stderr
  },
  {
    id: 'pyinstaller',
    args: ['-m', 'PyInstaller', '--version'],
    parseVersion: (combined) => {
      const match = combined.match(/(\d+\.\d+(?:\.\d+)?)/)
      return match?.[1]
    },
  },
]

/** 探测超时（毫秒）——版本类命令亚秒级完成，5s 覆盖冷启动杀软扫描余量。 */
export const PROBE_TIMEOUT_MS = 5000

/** 探测解释器命令（单一真源；Windows 坑库：禁 python3）。 */
export const PROBE_INTERPRETER = 'python'

// =========================================================================
// 探测执行
// =========================================================================

/** 执行单个探测项（异常归类三分类；成功解析版本）。 */
async function runProbe(spec: ProbeSpec, spawn: ProbeSpawn): Promise<ProbeResult> {
  const probeCommand = [PROBE_INTERPRETER, ...spec.args].join(' ')
  try {
    const { code, stdout, stderr } = await spawn(PROBE_INTERPRETER, spec.args, PROBE_TIMEOUT_MS)
    const combined = `${stdout}\n${stderr}`.trim()
    if (code !== 0) {
      return {
        id: spec.id,
        status: 'exec-failed',
        detail: `退出码 ${code}${combined ? `：${combined.slice(0, 200)}` : '（无输出）'}`,
        probeCommand,
      }
    }
    return {
      id: spec.id,
      status: 'ok',
      version: spec.parseVersion?.(combined),
      detail: combined.slice(0, 200) || '（无输出，退出码 0）',
      probeCommand,
    }
  } catch (error) {
    if (error instanceof ProbeError) {
      return { id: spec.id, status: error.kind, detail: error.message.slice(0, 200), probeCommand }
    }
    return {
      id: spec.id,
      status: 'exec-failed',
      detail: `探测异常：${error instanceof Error ? error.message : String(error)}`,
      probeCommand,
    }
  }
}

/** 全量探测（顺序执行——环境探测无并发收益，且输出序稳定利于断言/留档）。 */
export async function probeDesktopEnv(spawn: ProbeSpawn): Promise<ProbeResult[]> {
  const results: ProbeResult[] = []
  for (const spec of PROBE_SPECS) {
    results.push(await runProbe(spec, spawn))
  }
  return results
}

/** 环境就绪判定（三项全 ok；arch 阶段环境结论的机器判据）。 */
export function isDesktopEnvReady(results: readonly ProbeResult[]): boolean {
  return results.length > 0 && results.every((r) => r.status === 'ok')
}

// =========================================================================
// 生产实现（execFile；延迟导入边界由调用方负责——模块被单测 import 时不触发）
// =========================================================================

/** 生产 spawn：execFile + 超时 + ENOENT/超时翻译。 */
export function execFileProbeSpawn(command: string, args: readonly string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  // 动态 require 隔离：单测 import 本模块不拉 child_process（vitest 环境 node 内建可用，
  // 此处防御的是未来测试环境变化；正常运行零开销）
  const { execFile } = require('node:child_process') as typeof import('node:child_process')
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 64, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const err = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string }
          if (err.code === 'ENOENT') {
            reject(new ProbeError('not-found', `命令不存在：${command}`))
            return
          }
          if (err.killed || err.signal === 'SIGTERM') {
            reject(new ProbeError('timeout', `探测超时（>${timeoutMs}ms）：${command}`))
            return
          }
          // execFile 的 error 伴生退出码场景（非零退出）：视为有输出的执行结果而非异常
          if (typeof err.code === 'number') {
            resolve({ code: err.code, stdout: stdout ?? '', stderr: stderr ?? '' })
            return
          }
          reject(new ProbeError('exec-failed', `执行失败：${err.message}`))
          return
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' })
      },
    )
  })
}

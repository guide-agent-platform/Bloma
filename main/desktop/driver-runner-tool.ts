/**
 * 项目驱动执行工具（implement 阶段真实红绿反馈通道，2026-10-02 ada13257 狗粮案根治）。
 *
 * 事故背书：该案 37 个委派子会话无一能执行 `python driver.py`——explore 子会话只读、
 * implement 子会话有写无 shell、probe_desktop_env 只跑三条写死探测命令；而 implement
 * 任务书承诺「驱动断言逐条变绿」。调度员只能死磕一个无法兑现的承诺，最终卡死问用户。
 * probe 工具注释早已自认「此前子会话无任何执行通道，只能阻塞或编造」——arch 深修
 * 只补了 arch 的探测面，implement 的执行缺口直到本案才补上。
 *
 * 设计（与 verify 阶段同一执行器，零第二实现）：
 *   - 复用 runContractDriver：契约声明制（只执行 contract.json 注册的命令）+ 命令黑名单
 *     二道防线 + env 白名单 + 超时硬停（1s-10min 有界）——不接受任意命令；
 *   - 工具挂调度员面（平台侧人格），子会话仍纯写不执行；收口前跑一次拿真实红绿清单，
 *     失败项喂回同一委派线修复——反馈回路在 implement 内闭环，不再跌到 verify 拒收
 *     后整圈回炉；
 *   - 阶段白名单：仅 desktop-implement 的 extraTools 放行（其余阶段被
 *     checkDispatcherToolGate 拦截并教育）；verify 的「平台收口执行」纪律不受影响——
 *     驱动证据门仍由 finalize 路径的 runContractDriver 产出，不采信模型自述。
 *
 * spawn 注入式：单测零真实子进程；生产 execFileDriverSpawn。
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentLoopTool, ToolOutcome } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { parseProjectContract } from './contract-schema'
import { execFileDriverSpawn, runContractDriver, type DriverExecutionReport, type DriverSpawn } from './process-driver'

/** 契约路径（对齐 dispatcher-loop 的 CONTRACT_PATH，单一常量防漂移）。 */
const CONTRACT_RELATIVE_PATH = '00_SCAFFOLD/contract.json'

/** 驱动执行工具可注入依赖（测试桩零真实子进程、零真实项目解析）。 */
export interface ProjectDriverRunnerDeps {
  spawn?: DriverSpawn
  /** 项目根解析覆盖（缺省 sandboxRoot ?? findProject(projectId).root_path）。 */
  resolveRoot?: (projectId: string) => string | undefined
}

/** 截图目录（对齐阶段表截图约定：00_VERIFY/screenshots/S<场景号>.png）。 */
export const SCREENSHOTS_RELATIVE_PATH = '00_VERIFY/screenshots'

/** 报告 → 工具输出文本（人读 + 模型可据以路由修复）；screenshots=截图清单（调用方扫描，纯函数保持零 I/O）。 */
export function renderDriverReport(report: DriverExecutionReport, screenshots: readonly string[] = []): string {
  const lines: string[] = [
    `驱动执行结果（平台真实 spawn，非推断）：${report.routing.toUpperCase()}`,
    `- 命令：${report.command}`,
    `- 退出码：${report.exitCode ?? 'null（未起/超时）'}｜耗时：${report.durationMs}ms`,
    `- 路由原因：${report.routingReason}`,
  ]
  if (report.scenarios.length > 0) {
    const passed = report.scenarios.filter((s) => s.outcome === 'pass').length
    lines.push(`- 场景读回：${passed}/${report.scenarios.length} PASS`)
    for (const s of report.scenarios) {
      lines.push(`  · [${s.outcome.toUpperCase()}] ${s.name}`)
    }
  }
  if (report.summaryLine) lines.push(`- ${report.summaryLine}`)
  // 刀3（2026-10-02 呈现层）：截图清单入报告——调度员/通知卡的证据索引
  if (screenshots.length > 0) {
    lines.push(`- 程序截图（${screenshots.length} 张）：${screenshots.join('、')}`)
  }
  if (report.stdoutExcerpt) lines.push(`- stdout 摘录（≤8KB）：\n${report.stdoutExcerpt}`)
  if (report.stderrExcerpt) lines.push(`- stderr 摘录：\n${report.stderrExcerpt}`)
  lines.push('三分类语义：pass=可推进；fail=失败清单交同一委派线修复后复跑；blocked=环境类（装配/人工），不进修复轮。')
  return lines.join('\n')
}

/**
 * 构建调度员侧项目驱动执行工具。
 *
 * fail-closed 语义（全部返回 isError 文本，不抛错不崩 loop）：
 *   - 项目根不可解析 → blocked 指引；
 *   - contract.json 缺失/不合法 → contract-invalid 教育文案（对齐 verify 任务书的
 *     「契约形态一字不差」要求，指引修契约而非绕过）。
 */
export function buildProjectDriverRunnerTool(projectId: string, deps: ProjectDriverRunnerDeps = {}): AgentLoopTool {
  const resolveRoot =
    deps.resolveRoot ??
    ((pid: string) => {
      const project = findProject(pid)
      return project?.root_path
    })
  return {
    name: 'run_project_driver',
    description:
      '真实执行本项目的驱动验收命令（平台收口 spawn：契约声明制 + 命令黑名单 + env 白名单 + 超时硬停，不接受任意命令）。' +
      'desktop-implement 阶段获得真实红绿反馈的唯一通道：收口前运行一次，失败清单交同一委派线修复后复跑，' +
      '全部场景 PASS 才可申请推进确认。blocked 为环境类问题，不要反复重试。',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx): Promise<ToolOutcome> => {
      let root: string | undefined
      try {
        root = resolveRoot(projectId)
      } catch {
        root = undefined
      }
      if (!root) {
        return {
          output: `项目根不可解析（projectId=${projectId}）：无法定位驱动工作目录。请确认项目存在后再试；这是 blocked 类问题，不要绕过。`,
          isError: true,
        }
      }
      let jsonText: string
      try {
        jsonText = await readFile(join(root, CONTRACT_RELATIVE_PATH), 'utf-8')
      } catch {
        return {
          output:
            `contract-invalid：${CONTRACT_RELATIVE_PATH} 不存在或不可读（项目根=${root}）。\n` +
            '驱动执行采用契约声明制——没有合法契约就没有可执行的命令。请先委派补齐契约（schema_version 数字 1 / entry / driver 对象含 command、timeout_ms、exit_code_semantics 三键 / assert_readback / env_whitelist / components），再复跑本工具。',
          isError: true,
        }
      }
      let contract
      try {
        contract = parseProjectContract(jsonText)
      } catch (error) {
        return {
          output:
            `contract-invalid：契约解析失败（${error instanceof Error ? error.message : String(error)}）。\n` +
            '契约是驱动执行的白名单来源，形态必须一字不差（schema_version 数字 1 / entry / driver 对象含 command、timeout_ms、exit_code_semantics 三键 / assert_readback / env_whitelist / components）。请委派修正契约后复跑——不要尝试绕过契约直接执行。',
          isError: true,
        }
      }
      const report = await runContractDriver({
        contract,
        cwd: root,
        spawn: deps.spawn ?? execFileDriverSpawn,
        parentEnv: process.env,
        signal: ctx.signal,
      })
      // 刀3：截图清单（目录缺失/不可读 → 空清单，不阻塞报告）
      let screenshots: string[] = []
      try {
        screenshots = (await readdir(join(root, SCREENSHOTS_RELATIVE_PATH), { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.png'))
          .map((entry) => `${SCREENSHOTS_RELATIVE_PATH}/${entry.name}`)
          .sort()
      } catch {
        // 目录不存在：正常路径（未到截图阶段/非 UI 项目）
      }
      return { output: renderDriverReport(report, screenshots), isError: report.routing !== 'pass', detail: { report } }
    },
  }
}

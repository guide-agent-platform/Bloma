/**
 * 桌面调度员会话运行器（批次 D，2026-09-24）——桌面线端到端接线。
 *
 * 把批次 A（阶段表/围栏/提示词）+ 批次 B（品类底稿/骨架）+ 批次 C（驱动执行）
 * 接到 runAgentLoop：一个调度员会话跑一个阶段，收口由裁决边界判定推进。
 *
 * 装配序（runDesktopDispatcherLoop）：
 *   1. 开关二道防线（BLOMA_DESKTOP_DISPATCH off → not-enabled，web 线字节级现状——
 *      意图路由层分流是一道，本层再验一次防直调）；
 *   2. 阶段解析（权威阶段 → PhaseNode；未接管阶段 → not-managed）；
 *   3. 工具面：只读五件（buildAgentTools research 裁剪筛选）+ 委派族（parent 全量）
 *      + web_research + 测试注入位（toolsOverride）；每个工具 execute 前过
 *      checkDispatcherToolGate 围栏（write_file/edit_file 即便误装配也被硬拦）；
 *   4. 系统提示词：buildDispatcherSystemPrompt（阶段数据动态构建）；
 *   5. runAgentLoop（压缩/steer/DSML 恢复/检查点全继承；permissionMode=allow-all
 *      对齐自动化管线惯例，围栏在工具包装层不在权限链——不动 web 线 permission-service）；
 *   6. 收口 finalizeDesktopDispatch：desktop-verify 驱动前置（runContractDriver 真实
 *      spawn + 报告落盘）→ manual 确认凭据校验 → evaluateAdvance 三关。
 *
 * assistant 轮次累积（收口检测的数据面）：publish('message_delta') 片段流 +
 * onTurn 轮界换页 + 收工轮残余收尾——中段收口消息里的推进标记不漏扫
 * （竞品 W17 教训：只扫末条会漏）。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentEvent } from '../../shared/types'
import type { AgentLoopInput, AgentLoopResult, AgentLoopTool, ToolOutcome } from '../agent/loop/agent-loop'
import { runAgentLoop } from '../agent/loop/agent-loop'
import { buildAgentTools } from '../agent/tools/agent-tools'
import { buildWebResearch } from '../agent/tools/web-tools'
import { buildDelegationTools } from '../agent/delegation/delegation-tools'
import { getDesktopPhase, type PhaseNode } from './dispatcher-phases'
import { checkDispatcherToolGate, evaluateAdvance, type AdvanceDecision } from './dispatcher-gate'
import { buildDispatcherSystemPrompt } from './dispatcher-prompt'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { parseProjectContract } from './contract-schema'
import { runContractDriver, execFileDriverSpawn, type DriverExecutionReport } from './process-driver'

// =========================================================================
// 运行输入/输出
// =========================================================================

/** 桌面调度员运行输入（编排层组装；沙箱/落盘谓词可注入）。 */
export interface DesktopDispatchRunInput {
  projectId: string
  sessionId: string
  requestId: string
  /** 权威阶段（存储阶段——桌面线从 desktop-arch 起；requirements 走向导管线） */
  currentPhase: string
  /** 初始 user 指令（阶段任务书已由系统提示词承载，这里是 kickoff 话术） */
  task: string
  query: AgentLoopInput['query']
  /** 渠道 env（runtime-fallback 解析后） */
  env: Record<string, string>
  maxTokens: number
  maxTurns?: number
  signal: AbortSignal
  /** 事件流发布（接线层转发给渲染端/事件总线） */
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 项目名（提示词模板与产物占位符共用） */
  projectName: string
  /** 项目沙箱根（产物验证/契约读取/驱动 cwd 的解析根）。 */
  sandboxRoot?: string
  /** 用户已确认的阶段 id 集（manual 门禁凭据——确认链由编排层/批次 E 维护） */
  confirmedPhases?: ReadonlySet<string>
  /** 报告落盘注入（生产 join(sandboxRoot, rel)+writeFile；测试桩收集）。 */
  writeReport?: (relativePath: string, content: string) => void
  /** 契约读取注入（生产读 sandboxRoot/00_SCAFFOLD/contract.json；测试桩）。 */
  readContract?: () => string | undefined
  /** 驱动 spawn 注入（生产 execFileDriverSpawn；测试桩）。 */
  driverSpawn?: Parameters<typeof runContractDriver>[0]['spawn']
  /** 测试注入位：附加工具（挂起工具等故障注入用；仍过围栏白名单）。 */
  toolsOverride?: AgentLoopTool[]
  /** 产物存在性谓词注入（缺省 sandboxRoot+existsSync）。 */
  artifactExists?: (relativePath: string) => boolean
}

/** 桌面调度员运行结果。 */
export interface DesktopDispatchRunResult {
  status: 'completed' | 'cancelled' | 'error' | 'not-enabled' | 'not-managed'
  /** loop 原始结果（not-enabled/not-managed 无）。 */
  loopResult?: AgentLoopResult
  /** 收口推进判定（completed 才有；cancelled/error 阶段未收口）。 */
  advance?: AdvanceDecision
  /** desktop-verify 阶段的驱动执行报告（该阶段才有）。 */
  driverReport?: DriverExecutionReport
  /** 阶段节点（解析成功才有）。 */
  phase?: PhaseNode
}

// =========================================================================
// 工具面装配 + 围栏包装
// =========================================================================

/** 只读五件（buildAgentTools research 裁剪里筛——勿整拿：research 面带 ask 冒泡版委派）。 */
const READONLY_TOOL_NAMES = new Set(['read_file', 'list_files', 'find', 'grep', 'web_fetch'])

/**
 * 装配调度员工具面：只读五件 + 委派族（parent）+ web_research。
 * compact_context 不装配（loop 自带自动压缩；白名单允许=未来可挂，装配面克制）。
 */
export function buildDispatcherTools(projectId: string): AgentLoopTool[] {
  const readonly = buildAgentTools({ projectId, role: 'research' }).filter((t) => READONLY_TOOL_NAMES.has(t.name))
  return [...readonly, ...buildDelegationTools('parent'), buildWebResearch(projectId)]
}

/**
 * 围栏包装：每个工具 execute 前过 checkDispatcherToolGate——deny 转 is_error
 * tool_result（模型可读教育文案自纠），不崩 loop。写族即使被误装配也被硬拦
 * （白名单 fail-closed 的执行位）。
 */
export function wrapWithDispatcherGate(tools: readonly AgentLoopTool[], phase: PhaseNode): AgentLoopTool[] {
  return tools.map((tool) => {
    const gate = checkDispatcherToolGate(phase, tool.name)
    if (gate === null) return tool
    return {
      ...tool,
      execute: async (input, ctx): Promise<ToolOutcome> => ({ output: gate.message, isError: true }),
    }
  })
}

// =========================================================================
// assistant 轮次累积器（收口检测数据面）
// =========================================================================

/** 累积器：message_delta 片段流入 → onTurn 换页 → 收尾 flush 残余。 */
export class AssistantTurnCollector {
  private buffer = ''
  private readonly turns: Array<Array<{ type: 'text'; text?: string }>> = []

  /** publish 转发钩子（接线层把它接到 loop 的 publish 上）。 */
  readonly onPublish = (type: AgentEvent['type'] | string, payload: Record<string, unknown>): void => {
    if (type === 'message_delta' && typeof payload.text === 'string') this.buffer += payload.text
  }

  /** 轮界（onTurn 转发钩子）：把累积 buffer 换页为一轮。 */
  readonly onTurnBoundary = (): void => {
    if (this.buffer.length > 0) {
      this.turns.push([{ type: 'text', text: this.buffer }])
      this.buffer = ''
    }
  }

  /** 收尾：残余 buffer（收工轮——无 tool_use 不触发 onTurn）收为最后一轮。 */
  flush(): ReadonlyArray<ReadonlyArray<{ type: 'text'; text?: string }>> {
    this.onTurnBoundary()
    return this.turns
  }
}

// =========================================================================
// 收口：驱动前置 + 确认凭据 + 三关
// =========================================================================

/** 驱动报告落盘相对路径（对齐阶段表 desktop-verify gate 产物）。 */
export const DRIVER_REPORT_PATH = '00_VERIFY/driver-report.json'

/** 契约默认路径（对齐批次 B 骨架）。 */
export const CONTRACT_PATH = '00_SCAFFOLD/contract.json'

/** finalize 的中间产物（驱动前置只发生在 desktop-verify）。 */
export interface DesktopFinalizeOutcome {
  advance: AdvanceDecision
  driverReport?: DriverExecutionReport
}

/**
 * 收口判定（非 verify 阶段——纯装配，I/O 全注入；desktop-verify 走 runVerifyFinalize
 * 异步完整版：驱动 spawn 是异步的）。
 * 1. manual 门禁：node.requiresUserConfirmation 且凭据集不含本阶段 → 拒绝
 *    （confirmation-required——确认链由编排层/批次 E 闭环，本层只认凭据）；
 * 2. evaluateAdvance 三关。
 */
export function finalizeDesktopDispatch(
  node: PhaseNode,
  input: DesktopDispatchRunInput,
  collector: AssistantTurnCollector,
): DesktopFinalizeOutcome {
  const turns = collector.flush()
  const vars = { project_name: input.projectName }
  const exists = input.artifactExists ?? ((rel: string) => Boolean(input.sandboxRoot) && existsSync(join(input.sandboxRoot!, rel)))

  // manual 确认凭据
  if (node.requiresUserConfirmation && !(input.confirmedPhases?.has(node.id) ?? false)) {
    return {
      advance: {
        decision: 'reject',
        reason: 'confirmation-required',
        discardedObservations: [],
        education:
          `阶段「${node.id}」需要用户确认后才能推进（manual 门禁：${node.gates.filter((g) => g.kind === 'manual').map((g) => g.description).join('；')}）。\n` +
          '请先向用户发起确认（说明产出与验收结论），取得同意后由平台登记确认凭据，再输出推进标记。',
      },
    }
  }

  return { advance: evaluateAdvance(turns, node.id, exists, vars) }
}

// =========================================================================
// 主运行器
// =========================================================================

/**
 * 运行一个桌面调度员阶段会话。
 *
 * 返回 not-enabled（开关 off）/ not-managed（阶段未接管，含 requirements 复用
 * 向导管线）时调用方走既有路径——web 线零接触。
 */
export async function runDesktopDispatcherLoop(input: DesktopDispatchRunInput): Promise<DesktopDispatchRunResult> {
  if (!isDesktopDispatchEnabled()) {
    return { status: 'not-enabled' }
  }
  const node = getDesktopPhase(input.currentPhase)
  if (!node || !node.dispatcherManaged) {
    return { status: 'not-managed' }
  }

  const collector = new AssistantTurnCollector()
  const basePublish = input.publish
  const publish: AgentLoopInput['publish'] = (type, payload) => {
    collector.onPublish(type, payload)
    basePublish(type, payload)
  }

  const tools = wrapWithDispatcherGate(
    [...buildDispatcherTools(input.projectId), ...(input.toolsOverride ?? [])],
    node,
  )

  const system = buildDispatcherSystemPrompt(node, {
    projectName: input.projectName,
    completedPhases: [],
  })

  const loopResult = await runAgentLoopSafe(input, node, tools, system, publish, collector)

  if ('safeError' in loopResult) {
    return { status: 'error', phase: node }
  }
  if (loopResult.status !== 'completed') {
    // turn_limit/budget_exhausted 等终态统一归 error（阶段未收口，编排层决定重跑或转 blocked）
    const status = loopResult.status === 'cancelled' ? 'cancelled' : 'error'
    return { status, loopResult, phase: node }
  }

  // desktop-verify：异步驱动前置（完整版）
  if (node.id === 'desktop-verify') {
    const driven = await runVerifyFinalize(node, input, collector)
    return { status: 'completed', loopResult, advance: driven.advance, driverReport: driven.driverReport, phase: node }
  }

  const outcome = finalizeDesktopDispatch(node, input, collector)
  return { status: 'completed', loopResult, advance: outcome.advance, phase: node }
}

/** loop 调用（断流等 query 异常按 fail-soft 转 error 状态——调度员是无人值守自动化，不向上冒泡）。 */
async function runAgentLoopSafe(
  input: DesktopDispatchRunInput,
  node: PhaseNode,
  tools: AgentLoopTool[],
  system: string,
  publish: AgentLoopInput['publish'],
  collector: AssistantTurnCollector,
): Promise<AgentLoopResult | { safeError: true; message: string }> {
  try {
    return await runAgentLoop({
      system,
      task: input.task,
      tools,
      query: input.query,
      env: input.env,
      sessionId: input.sessionId,
      projectId: input.projectId,
      requestId: input.requestId,
      maxTokens: input.maxTokens,
      maxTurns: input.maxTurns ?? 24,
      permissionMode: 'allow-all',
      signal: input.signal,
      publish,
      onTurn: () => collector.onTurnBoundary(),
    })
  } catch (error) {
    // 断流等 query 异常：fail-soft 转 error 状态（调度员是无人值守自动化，不向上冒泡）
    return { safeError: true, message: error instanceof Error ? error.message : String(error) }
  }
}

/** desktop-verify 专用收口（驱动执行是异步 spawn，单独完整版：契约→驱动→报告落盘→三关）。 */
async function runVerifyFinalize(
  node: PhaseNode,
  input: DesktopDispatchRunInput,
  collector: AssistantTurnCollector,
): Promise<DesktopFinalizeOutcome> {
  const turns = collector.flush()
  const vars = { project_name: input.projectName }

  if (node.requiresUserConfirmation && !(input.confirmedPhases?.has(node.id) ?? false)) {
    return {
      advance: {
        decision: 'reject',
        reason: 'confirmation-required',
        discardedObservations: [],
        education:
          `阶段「${node.id}」需要用户确认后才能推进。\n` +
          '请先向用户发起交付确认，取得同意后由平台登记确认凭据，再输出推进标记。',
      },
    }
  }

  const contractText = input.readContract?.()
  if (contractText === undefined) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [CONTRACT_PATH] }],
        discardedObservations: [],
        education: `工程契约缺失（${CONTRACT_PATH}）——驱动执行的前提不存在。请先委派补齐工程契约，再进入验证收口。`,
      },
    }
  }
  let contract
  try {
    contract = parseProjectContract(contractText)
  } catch (error) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [CONTRACT_PATH] }],
        discardedObservations: [],
        education: `工程契约不合法：${error instanceof Error ? error.message : String(error)}\n驱动执行 fail-closed。请委派修复契约后重试。`,
      },
    }
  }

  const report = await runContractDriver({
    contract,
    cwd: input.sandboxRoot ?? process.cwd(),
    spawn: input.driverSpawn ?? execFileDriverSpawn,
    parentEnv: process.env,
  })
  input.writeReport?.(DRIVER_REPORT_PATH, JSON.stringify(report, null, 2))

  if (report.routing !== 'pass') {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          `驱动执行未通过（${report.routing}）：${report.routingReason}\n` +
          '验证结论只看驱动执行回读——请按失败场景修复后重新收口（fail 路由进修复轮；blocked 属环境类需先解决装配）。',
      },
      driverReport: report,
    }
  }

  const exists = input.artifactExists
    ?? ((rel: string) => Boolean(input.sandboxRoot) && existsSync(join(input.sandboxRoot!, rel)))
  // 报告已落盘在 writeReport 注入位；存在性验证用「报告已产出」事实短路（谓词看不到
  // 注入桩写的路径时以 driverReport 存在为准）
  const existsWithReport = (rel: string) => (rel === DRIVER_REPORT_PATH ? true : exists(rel))
  return {
    advance: evaluateAdvance(turns, node.id, existsWithReport, vars),
    driverReport: report,
  }
}

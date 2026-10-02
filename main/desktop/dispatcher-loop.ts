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
 *   3b. 委派接线（2026-09-26 首跑修复）：注册父 loop 上下文 + 子工具集构建器——
 *      delegate_agent 可用性前提；收尾 disposeParentDelegationState（含异常路径）。
 *   3c. 子会话面（2026-09-26 首跑深修）：真实工程写范围（realFullstackVariant）+
 *      probe_desktop_env 环境探测工具；本 loop 关闭进度对账注入（非写型 loop 误注入）。
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
import { buildDomainTools } from '../coding/tool-handlers'
import { buildWebResearch } from '../agent/tools/web-tools'
import { buildDelegationTools } from '../agent/delegation/delegation-tools'
import { disposeParentDelegationState, registerParentLoopContext, setChildToolsBuilder } from '../agent/delegation/agent-collaboration'
import { categoryTemperature } from '../platform/llm/model-resolution'
import { trackAnalytics } from '../delivery/track-analytics'
import type { DelegationRunRole } from '../../shared/delegation-run-context'
import { getDesktopPhase, type PhaseNode } from './dispatcher-phases'
import { checkDispatcherToolGate, evaluateAdvance, type AdvanceDecision } from './dispatcher-gate'
import { buildDesktopChildBaseSystem, buildDispatcherSystemPrompt } from './dispatcher-prompt'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { execFileProbeSpawn, isDesktopEnvReady, probeDesktopEnv, type ProbeSpawn } from './check-env'
import { parseProjectContract } from './contract-schema'
import { runContractDriver, execFileDriverSpawn, type DriverExecutionReport } from './process-driver'
import { runSecurityScan } from '../verification/security-scan'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/document-engine'
import { requirementPriority } from '../model/prd-backplane'

/** P0-1 完整版（2026-10-02）：桌面线裁判门——judge-engine 确定性硬约束的桌面化子集。
 *  对齐 09-26 拍板「验收走驱动执行」：不复活 GWT/LLM 语义腿，只做零渠道依赖的
 *  fail-closed 规则门——① PRD 背板存在且功能项非空（judge ① 原语义）；② 驱动场景
 *  覆盖（judge ② 桌面化：P0 功能项数 ≤ driver 非 skipped 场景数，场景源=driver 回读
 *  锚点，非生成方自述）；③ 入口真实存在（judge ③ 存在性基线的契约制等价物：
 *  contract.entry 指向的文件在产物根存在）。附软对账（P0-1c）：P0 断言关键词 ↔
 *  driver 场景名命中率，只观测进遥测不阻断（防误杀，狗粮跑一轮看误杀率再议升硬门）。 */
function runDesktopJudgeGate(input: {
  projectId: string
  sandboxRoot?: string
  driverReport: DriverExecutionReport
  entryFile: string
}): { passed: boolean; hardFailures: string[]; coverageGaps: string[] } | null {
  let backplane: ReturnType<typeof readPrdBackplane>
  try {
    backplane = readPrdBackplane(input.projectId)
  } catch {
    return null // 无项目上下文（测试桩）：不阻断，留痕
  }
  const hardFailures: string[] = []
  const requirements = backplane.requirements ?? []
  // ① PRD 存在性（judge ①）
  if (requirements.length === 0) hardFailures.push('PRD 核心功能项为空——没有可验收的需求清单，不能交付')
  // ② 驱动场景覆盖（judge ② 桌面化）
  const p0Items = requirements.filter((item) => requirementPriority(item) === 'P0')
  const coveredScenarios = input.driverReport.scenarios.filter((scenario) => scenario.outcome !== 'skipped')
  if (coveredScenarios.length < p0Items.length) {
    hardFailures.push(
      `驱动场景覆盖不足：PRD 有 ${p0Items.length} 个核心（P0）功能项（${p0Items.map((i) => i.id).join('、')}），driver 只回读了 ${coveredScenarios.length} 个非 skipped 场景——每个核心功能项至少要有一个场景验证`,
    )
  }
  // ③ 入口存在（judge ③ 契约制等价物；driver 真实执行已由收口前置步骤保证）
  const rootPath = input.sandboxRoot
  if (rootPath && !existsSync(join(rootPath, input.entryFile))) {
    hardFailures.push(`工程契约声明的入口文件（${input.entryFile}）在产物中不存在——没有可运行的入口，不能交付`)
  }
  // 软对账（P0-1c）：P0 断言关键词在场景名中的命中率——观测不阻断。中文断言多是无
  // 分隔长句，逐词 split 会误报（实证：'添加待办后列表新增一条' vs 场景'添加待办场景'
  // 无一命中）——改 2-gram 滑窗从宽命中（漏报少；软观测只暴露完全没对上的缺口，
  // 精确口径待狗粮数据标定后再收）。
  const scenarioText = coveredScenarios.map((scenario) => scenario.name).join('\n')
  const coverageGaps: string[] = []
  for (const item of p0Items) {
    for (const assertion of item.behavior_assertions ?? []) {
      const cleaned = assertion.replace(/[→→，。;；\s]/g, '')
      const bigrams: string[] = []
      for (let index = 0; index + 2 <= cleaned.length; index += 1) bigrams.push(cleaned.slice(index, index + 2))
      const hit = bigrams.length === 0 || bigrams.some((bigram) => scenarioText.includes(bigram))
      if (!hit) coverageGaps.push(`${item.id}: ${assertion}`)
    }
  }
  return { passed: hardFailures.length === 0, hardFailures, coverageGaps }
}

/** 宿主强制安全扫描门（P0-1 缓解，2026-10-02）：返回 null = 无项目上下文/扫描器异常，
 *  跳过（行为等同旧世界）；返回扫描结果由调用方 fail-closed 裁决。 */
function runHostSecurityGate(input: { projectId: string; sandboxRoot?: string }):
  | { passed: boolean; blocking: number; scanned: number; listing: string }
  | null {
  let rootPath = input.sandboxRoot
  if (!rootPath) {
    try {
      rootPath = findProject(input.projectId).root_path
    } catch {
      return null // 无项目上下文（测试桩/纯会话）：不阻断，留痕
    }
  }
  try {
    const result = runSecurityScan({ project_id: input.projectId, root_path: rootPath })
    const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
    return {
      passed: result.passed,
      blocking: blocking.length,
      scanned: result.scanned_files,
      listing: blocking.slice(0, 10).map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n'),
    }
  } catch (error) {
    console.error('[desktop-verify] 宿主安全扫描执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}

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
  /** 需求摘要（首跑修复：PRD 背板 → 调度员系统提示词与子会话基底；编排层装配，缺省不注入） */
  requirementsDigest?: string
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
  /** P0-1c 软对账（2026-10-02）：P0 断言关键词未命中任何 driver 场景名的清单——
   *  只观测不阻断，进遥测供狗粮标定误杀率后再议升硬门。 */
  judgeCoverageGaps?: string[]
  /** 阶段节点（解析成功才有）。 */
  phase?: PhaseNode
}

// =========================================================================
// 工具面装配 + 围栏包装
// =========================================================================

/** 只读五件（buildAgentTools research 裁剪里筛——勿整拿：research 面带 ask 冒泡版委派）。 */
const READONLY_TOOL_NAMES = new Set(['read_file', 'list_files', 'find', 'grep', 'web_fetch'])

/** 子会话独立轮次上限（对齐 coding 线 DELEGATION_MAX_TURNS=12；就近自持避免跨域常量依赖）。 */
const DESKTOP_DELEGATION_MAX_TURNS = 12

/**
 * 装配调度员工具面：只读五件 + 委派族（parent）+ web_research。
 * compact_context 不装配（loop 自带自动压缩；白名单允许=未来可挂，装配面克制）。
 */
export function buildDispatcherTools(projectId: string): AgentLoopTool[] {
  const readonly = buildAgentTools({ projectId, role: 'research' }).filter((t) => READONLY_TOOL_NAMES.has(t.name))
  return [...readonly, ...buildDelegationTools('parent'), buildWebResearch(projectId)]
}

/**
 * 桌面线子会话工具集（首跑深修 2026-09-26）：真实工程件皆产物——项目内除基础设施
 * 目录（node_modules/.git/data-backups）外皆可写。原缺省走 web 静态规则（src/ 子树 +
 * .html/.js/.css），会拒绝 00_ARCH/*.md|.json、.py 等桌面交付物（首跑实证：门禁
 * 产物写不进去，架构子会话只能写探测文件）。realFullstackVariant 语义即「真实工程件」，
 * 命名沿用既有选项，后续统一。
 *
 * 安全门禁装配（全链路审查 P0-2，2026-10-01）：桌面线产物含在本机真实 spawn 执行的
 * Python（driver/scaffold）——implement/custom 子会话拼接 buildDomainTools 获得
 * run_security_scan（扫描器已扩 .py 与 Python 危险调用硬红线），生成方必须自扫自修；
 * worktree 隔离模式下 buildDomainTools 返回空（验证归父会话，防假验证，语义不变）。
 */
export function buildDesktopChildTools(projectId: string, role: DelegationRunRole, editFormat: 'diff' | 'whole'): AgentLoopTool[] {
  return [
    ...buildAgentTools({ projectId, role, editFormat, realFullstackVariant: true }),
    ...buildDomainTools({ projectId, role, editFormat, realFullstackVariant: true }),
  ]
}

/**
 * 桌面环境探测工具（首跑深修）：在真实主机执行 env 探测并回读结果——desktop-arch
 * 环境清单 [实证] 的唯一实测来源（此前子会话无任何执行通道，只能阻塞或编造）。
 * 探测项/三分类/超时复用 check-env；spawn 可注入（测试桩零真实子进程）。
 */
export function buildDesktopEnvProbeTool(spawn: ProbeSpawn = execFileProbeSpawn): AgentLoopTool {
  return {
    name: 'probe_desktop_env',
    description:
      '在真实主机探测 Windows 桌面开发环境（python 版本 / venv 模块 / PyInstaller 打包器），' +
      '逐项返回真实命令、状态（ok/not-found/timeout/exec-failed）与输出。' +
      'desktop-arch 环境清单与选型结论的 [实证] 来源；失败项按分类如实报告，不要编造。',
    input_schema: { type: 'object', properties: {} },
    execute: async () => {
      const results = await probeDesktopEnv(spawn)
      const lines = results.map(
        (item) => `- ${item.id}: ${item.status}${item.version ? ` (v${item.version})` : ''}｜${item.detail}｜命令: ${item.probeCommand}`,
      )
      return {
        output: `桌面环境探测结果（真实执行，非推断）：\n${lines.join('\n')}\n就绪判定（三项全 ok）：${isDesktopEnvReady(results) ? '是' : '否'}`,
        detail: { results },
      }
    },
  }
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
  /** P0-1c 软对账：裁判门附带的 P0 断言覆盖缺口（观测不阻断）。 */
  judgeCoverageGaps?: string[]
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
async function runDesktopDispatcherLoopInner(input: DesktopDispatchRunInput): Promise<DesktopDispatchRunResult> {
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
    workspaceHint: '产物按相对路径写入（项目目录即工作根；如 00_ARCH/、00_SCAFFOLD/、00_VERIFY/）。',
    ...(input.requirementsDigest ? { requirementsDigest: input.requirementsDigest } : {}),
  })

  // ── 委派协作接线（2026-09-26 首跑修复）──
  // 首跑实证：工具面带 delegate_agent，但本路径从未注册父 loop 上下文——一调用即抛
  // 「未找到父循环上下文」。对齐 coding generate.ts 的注册契约：父上下文（query/env/
  // 预算/权限/发布）+ 子工具集构建器（worker 需要文件写工具落盘产物）。
  registerParentLoopContext(input.sessionId, {
    query: input.query,
    env: input.env,
    maxTokens: input.maxTokens,
    maxTurns: input.maxTurns ?? 40,
    delegationMaxTurns: DESKTOP_DELEGATION_MAX_TURNS,
    permissionMode: 'allow-all',
    temperature: categoryTemperature('mvp'),
    system: buildDesktopChildBaseSystem(node, {
      projectName: input.projectName,
      ...(input.requirementsDigest ? { requirementsDigest: input.requirementsDigest } : {}),
    }),
    editFormat: 'diff',
    publish,
    // 首跑深修：子会话专用执行通道（环境探测）；仅注入本父会话产生的委派子会话
    childExtraTools: [buildDesktopEnvProbeTool()],
    // 工具面随父上下文隔离（P1-12，2026-10-02）：桌面子会话写面（realFullstackVariant）
    // 不再依赖全局单例——与 review 线并发时后注册者的全局覆盖不再串面。全局注册保留
    // 作缺省（单线场景/旧测试兼容）。
    childToolsBuilder: buildDesktopChildTools,
  })
  setChildToolsBuilder(buildDesktopChildTools)

  const loopResult = await runAgentLoopSafe(input, node, tools, system, publish, collector).finally(() =>
    // 收尾（含异常路径）：stop 未收敛子委派 + 清幂等缓存 + 注销父上下文
    disposeParentDelegationState(input.sessionId),
  )

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
    return { status: 'completed', loopResult, advance: driven.advance, driverReport: driven.driverReport, ...(driven.judgeCoverageGaps ? { judgeCoverageGaps: driven.judgeCoverageGaps } : {}), phase: node }
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
      // 首跑深修：24 轮两轮都在收口/确认卡前耗尽——桌面阶段按 longterm 档给 40
      maxTurns: input.maxTurns ?? 40,
      permissionMode: 'allow-all',
      // 首跑深修：调度员不写文件/不带自测工具——web 线进度对账三守卫不适用（首跑被反复误注入）
      disableProgressNudge: true,
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
        reason: 'contract-invalid',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [CONTRACT_PATH] }],
        discardedObservations: [],
        education: `工程契约不合法：${error instanceof Error ? error.message : String(error)}\n驱动执行 fail-closed。请对照任务书内的最小合规样例修正字段名与类型后重试。`,
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

  // 最低验证证据门（全链路审查 P1-5，2026-10-02）：零场景锚点 + 零 SUMMARY 自报的
  // 「空驱动」（exit 0 直通）不得作为验证凭据——生成方=验收方同源，零断言的 driver
  // 等于没验。要求场景锚点或 SUMMARY 行至少其一；两者皆无 → 按验证产物不足拒收。
  if (report.scenarios.length === 0 && report.summaryLine === null) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          '驱动报告没有任何验证证据（零场景锚点、零 SUMMARY 自报）——退出码 0 不能替代断言。' +
          '请让 driver 至少回读 1 个场景锚点（PASS/FAIL/BLOCKED 行）或输出 SUMMARY 行，再重新收口。',
      },
      driverReport: report,
    }
  }

  // 宿主强制安全扫描门（全链路审查 P0-1 缓解，2026-10-02）：driver pass ≠ 安全——
  // 扫描不再依赖子会话自愿调用，收口时宿主对产物根强制扫一遍（扫描器已含 .py 硬红线），
  // 高危/严重命中 → 拒收推进（fail-closed）。无项目上下文（测试桩/纯会话场景）时跳过，
  // 行为等同旧世界（不比旧世界差）；扫描器自身异常同样跳过并留痕（安全门不做可用性单点）。
  const securityGate = runHostSecurityGate(input)
  if (securityGate && !securityGate.passed) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          `宿主安全扫描未通过（${securityGate.blocking} 个高危/严重问题，扫描 ${securityGate.scanned} 个文件）：\n` +
          `${securityGate.listing}\n请修复后重新收口；扫描门是硬门（fail-closed），driver 通过不能豁免。`,
      },
      driverReport: report,
    }
  }

  const exists = input.artifactExists
    ?? ((rel: string) => Boolean(input.sandboxRoot) && existsSync(join(input.sandboxRoot!, rel)))
  // 报告已落盘在 writeReport 注入位；存在性验证用「报告已产出」事实短路（谓词看不到
  // 注入桩写的路径时以 driverReport 存在为准）
  const existsWithReport = (rel: string) => (rel === DRIVER_REPORT_PATH ? true : exists(rel))

  // 裁判门（P0-1a/1c，2026-10-02）：judge-engine 确定性硬约束的桌面化（PRD 存在/驱动
  // 场景覆盖 P0/入口真实存在）——零渠道依赖 fail-closed；软对账（P0 断言关键词 ↔ 场景
  // 名命中）不阻断，进遥测供狗粮标定。无项目上下文（测试桩）跳过不阻断。
  const judgeGate = runDesktopJudgeGate({
    projectId: input.projectId,
    sandboxRoot: input.sandboxRoot,
    driverReport: report,
    entryFile: contract.entry,
  })

  if (judgeGate && !judgeGate.passed) {
    return {
      advance: {
        decision: 'reject',
        reason: 'artifacts-missing',
        missingArtifacts: [{ gateId: 'driver-report', artifacts: [DRIVER_REPORT_PATH] }],
        discardedObservations: [],
        education:
          `裁判门未过（硬约束 ${judgeGate.hardFailures.length} 项）：\n${judgeGate.hardFailures.map((f) => `- ${f}`).join('\n')}\n` +
          '请补齐后重新收口；硬约束是交付底线，driver 通过不能豁免。',
      },
      driverReport: report,
      ...(judgeGate.coverageGaps.length > 0 ? { judgeCoverageGaps: judgeGate.coverageGaps } : {}),
    }
  }

  const outcome = evaluateAdvance(turns, node.id, existsWithReport, vars)

  // P0-1b（2026-10-02）：全绿收口（driver pass + 证据门 + 安全门 + 裁判门 + 阶段判定
  // 推进）拍 verified 快照——恢复消费端（latestVerifiedSnapshot 熔断回滚优先恢复）
  // 自此有生产写入方；快照失败不阻断推进（仅留痕，下次收口可补）。
  if (outcome.decision === 'advance' && judgeGate?.passed) {
    try {
      const { createSnapshot } = await import('../delivery/snapshots')
      await createSnapshot({
        request_id: input.requestId,
        project_id: input.projectId,
        kind: 'mvp',
        summary: `desktop-verify 全绿（driver ${report.scenarios.filter((s) => s.outcome === 'pass').length}/${report.scenarios.length} 场景 + 安全扫描 + 裁判硬约束）`,
        include_documents: true,
        health_status: 'healthy',
        verification: 'verified',
      })
    } catch (error) {
      console.error('[desktop-verify] verified 快照创建失败（不阻断推进，下次收口可补）：', error)
    }
  }

  return {
    advance: outcome,
    driverReport: report,
    ...(judgeGate && judgeGate.coverageGaps.length > 0 ? { judgeCoverageGaps: judgeGate.coverageGaps } : {}),
  }
}

// ── 运行遥测（telemetry 最小版，2026-10-01）：狗粮数据设施────────────────────
// 每段 dispatcher run 落一条 analytics（阶段/终态/轮数/工具与委派计数/推进判定/
// 驱动报告/时长）；狗粮复盘（收敛轮数、子会话使用度、拒收模式）从数据说话，
// 对齐竞品 E2E 观察员度量的最小等价。fire-and-forget：失败不反噬业务。
export async function runDesktopDispatcherLoop(input: DesktopDispatchRunInput): Promise<DesktopDispatchRunResult> {
  const startedAt = Date.now()
  const result = await runDesktopDispatcherLoopInner(input)
  recordDispatchRunTelemetry(input, result, startedAt)
  return result
}

function recordDispatchRunTelemetry(
  input: DesktopDispatchRunInput,
  result: DesktopDispatchRunResult,
  startedAt: number,
): void {
  try {
    const loopResult = result.loopResult
    const toolCalls = loopResult?.toolCalls ?? []
    trackAnalytics({
      request_id: `desktop-dispatch-${input.sessionId}-${startedAt}`,
      event: {
        event_type: 'desktop_dispatch_run',
        project_id: input.projectId,
        session_id: input.sessionId,
        payload: {
          phase: result.phase?.id,
          status: result.status,
          loop_status: loopResult?.status,
          turns: loopResult?.turns,
          tool_calls: {
            total: toolCalls.length,
            ok: toolCalls.filter((c) => c.status === 'ok').length,
            error: toolCalls.filter((c) => c.status === 'error').length,
            delegate: toolCalls.filter((c) => typeof c.name === 'string' && c.name.startsWith('delegate')).length,
          },
          usage: loopResult?.usage
            ? {
                input: loopResult.usage.inputTokens,
                output: loopResult.usage.outputTokens,
                est_total: loopResult.usage.estTotalTokens,
              }
            : undefined,
          advance: result.advance
            ? result.advance.decision === 'advance'
              ? { decision: 'advance', target: result.advance.target }
              : {
                  decision: 'reject',
                  reason: result.advance.reason,
                  ...(result.advance.missingArtifacts ? { missing_artifacts: result.advance.missingArtifacts } : {}),
                  ...(result.advance.education ? { education: result.advance.education.slice(0, 400) } : {}),
                }
            : undefined,
          driver: result.driverReport,
          // P0-1c 软对账观测（2026-10-02）：P0 断言未命中场景名清单 + 计数——狗粮标定
          // 误杀率的数据面（命中≠验证充分，未命中也不阻断——只暴露对账缺口供复盘）。
          judge_coverage_gaps: result.judgeCoverageGaps ?? [],
          duration_ms: Date.now() - startedAt,
        },
        privacy_level: 'masked',
      },
    })
  } catch {
    // 遥测失败不反噬业务（analytics 写盘兜底已有；此处防未预期形状）
  }
}

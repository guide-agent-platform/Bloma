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

import { existsSync, renameSync } from 'node:fs'
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
import { recordDispatchRunTelemetry, recordDispatchStartTelemetry } from './dispatcher-telemetry'
import type { DelegationRunRole } from '../../shared/delegation-run-context'
import { getDesktopPhase, type PhaseNode } from './dispatcher-phases'
import { checkDispatcherToolGate, type AdvanceDecision } from './dispatcher-gate'
import { buildDesktopChildBaseSystem, buildDispatcherSystemPrompt } from './dispatcher-prompt'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { execFileProbeSpawn, isDesktopEnvReady, probeDesktopEnv, type ProbeSpawn } from './check-env'
import type { runContractDriver, DriverExecutionReport } from './process-driver'
import { buildChildScriptRunnerTool } from './child-exec-tool'
import { buildDriveAppTool, disposeDriveSessions } from './drive-app-tool'
import { buildInstallPackagesTool } from './install-packages-tool'
import { provisionDesktopSkeletonV2 } from './skeleton-provision'
import { findProject } from '../project/project-service'
import { buildProjectDriverRunnerTool } from './driver-runner-tool'
import { recordPhaseCheckpoint } from './phase-checkpoint'
import { runVerifyFinalize, finalizeDesktopDispatch } from './dispatcher-finalize'

// 拆分 re-export（批10 旧账③ R7，2026-10-07）：收口判定族迁至 dispatcher-finalize.ts，
// 旧路径消费者与测试零断链（hub 化惯例；与 dispatcher-telemetry 拆分同款）。
export { DRIVER_REPORT_PATH, FAULT_KILL_REPORT_PATH, CONTRACT_PATH, finalizeDesktopDispatch, type DesktopFinalizeOutcome } from './dispatcher-finalize'

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
  /** 形状段（批9 工件2）：{{shape_brief}}/{{shape_verify_brief}} 任务书注入；缺省空串=无形状增强。 */
  shapeBrief?: string
  shapeVerifyBrief?: string
  /** 快速模式（2026-10-03 拍板）：quick 项目跳过 arch/scaffold，本阶段用阶段表的
   *  快速版任务书/约束（无骨架前提的从零实现）；收口直通道见 desktop-route。 */
  quickMode?: boolean
  /** 上一轮已验证结论（刀2 checkpoint 消费：同阶段重跑注入，勿重验直接收口）。 */
  verifiedConclusion?: string
  /** 项目沙箱根（产物验证/契约读取/驱动 cwd 的解析根）。 */
  sandboxRoot?: string
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
  /** error 状态的异常摘要（2026-10-03：断流/空流等 query 异常原文，供渠道故障归因与人话卡）。 */
  error_message?: string
  /** 收口推进判定（completed 才有；cancelled/error 阶段未收口）。 */
  advance?: AdvanceDecision
  /** desktop-verify 阶段的驱动执行报告（该阶段才有）。 */
  driverReport?: DriverExecutionReport
  /** P0-1c 软对账（2026-10-02）：P0 断言关键词未命中任何 driver 场景名的清单——
   *  只观测不阻断，进遥测供狗粮标定误杀率后再议升硬门。 */
  judgeCoverageGaps?: string[]
  /** 批6 测试有效性反证（2026-10-06）：AST 反空 + P0 故障种子击杀结果（verify 收口
   *  且工具可用时才有；遥测 payload.fault_kill 的数据源）。 */
  testEffectiveness?: import('./test-effectiveness').TestEffectivenessOutcome
  /** 刀2 checkpoint（2026-10-02）：advance 分支写入的阶段存证（null/缺省=未写入或
   *  容错失败；遥测 payload.checkpoint 的数据源）。 */
  checkpoint?: { stage: string }
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
  // run_project_driver：常驻装配、阶段白名单放行（ada13257 根治——implement 真实红绿通道；
  // 其余阶段被 checkDispatcherToolGate 拦截教育）。工具本体在 driver-runner-tool.ts。
  return [...readonly, ...buildDelegationTools('parent'), buildWebResearch(projectId), buildProjectDriverRunnerTool(projectId)]
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
    // 方案 B（2026-10-05）：implement 子会话受控执行刀——quick 无契约时真实红绿
    // 自测的唯一通道（eba1cb83 实证：4 个自测脚本写了没门跑）；仅 implement 角色装配。
    // 迁移批同族加 install_packages（声明制 venv 安装，P1 依赖自由度）。
    ...(role === 'implement'
      ? [buildChildScriptRunnerTool(projectId), buildInstallPackagesTool(projectId)]
      : []),
    // 探索驱动测试 A 档（2026-10-05，实施稿预审修订版）：research 子会话装配驱动桥。
    // 探索者与 implement 结构性分离（反自证）：只读面 + 驱动面，无任何写工具；
    // 不进调度员常驻面（探索由 verify 编排器委派，见 dispatcher-phases verify 任务书）。
    ...(role === 'research' ? [buildDriveAppTool(projectId)] : []),
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

  // 骨架 v2 物化（批8 下半）：scaffold/implement 阶段入口把平台骨架复制进项目根
  // （幂等 skip-existing，不覆盖子会话成果）——任务书引用 ui/PATTERNS.md 的前提。
  // quick 模式不物化 00_SCAFFOLD 契约件（无工程化验收）。fail-open：资产异常只留痕。
  if (node.id === 'desktop-scaffold' || node.id === 'desktop-implement') {
    try {
      const rootForProvision = input.sandboxRoot ?? findProject(input.projectId).root_path
      if (rootForProvision) {
        const provisioned = provisionDesktopSkeletonV2(rootForProvision, input.projectName, {
          includeScaffold: node.id === 'desktop-scaffold',
        })
        if (provisioned.failed.length > 0 || provisioned.missing.length > 0) {
          console.warn('[skeleton-provision] 部分资产未物化：', JSON.stringify(provisioned))
        }
      }
    } catch (error) {
      console.warn('[skeleton-provision] 物化跳过（项目根不可解析）：', error instanceof Error ? error.message : String(error))
    }
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
    ...(input.verifiedConclusion ? { verifiedConclusion: input.verifiedConclusion } : {}),
    ...(input.quickMode ? { quickMode: true } : {}),
    ...(input.shapeBrief || input.shapeVerifyBrief ? { shapeBrief: input.shapeBrief, shapeVerifyBrief: input.shapeVerifyBrief } : {}),
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
      ...(input.quickMode ? { quickMode: true } : {}),
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
    // 收尾（含异常路径）：stop 未收敛子委派 + 清幂等缓存 + 注销父上下文 + 探索会话兜底清理
    void Promise.resolve(disposeParentDelegationState(input.sessionId)).finally(() => disposeDriveSessions(input.projectId)),
  )

  if ('safeError' in loopResult) {
    return { status: 'error', phase: node, error_message: loopResult.message }
  }
  if (loopResult.status !== 'completed') {
    // turn_limit/budget_exhausted 等终态统一归 error（阶段未收口，编排层决定重跑或转 blocked）
    const status = loopResult.status === 'cancelled' ? 'cancelled' : 'error'
    return { status, loopResult, phase: node }
  }

  // desktop-verify：异步驱动前置（完整版）
  if (node.id === 'desktop-verify') {
    // 探索会话记录轮转（批10.5 审查B P1-2，2026-10-08）：drive-sessions.json 是追加式
    // 存储，旧判定下历史 disposed 永久计入——每轮 verify 开始时轮转为 .prev（保留一份
    // 历史），本轮 MVP 门只看本轮探索真相（回炉重验后旧降级不再永久呈现）。
    // findings 同点轮转（批11 审查修复，2026-10-08）：旧轮探索发现（含旧 P0）若不随轮
    // 转清退，回炉重验后仍永久呈现于 mvp-review 发现段——狗粮门策略读发现段会被旧 P0
    // 驱动重复回炉；产品门不受影响（findings 不阻塞），旧问题修复由本轮 driver/击杀
    // 全绿背书。
    if (input.sandboxRoot) {
      try {
        const verifyDir = join(input.sandboxRoot, '00_VERIFY')
        for (const rel of ['drive-sessions.json', 'drive-findings.json']) {
          const p = join(verifyDir, rel)
          if (existsSync(p)) renameSync(p, join(verifyDir, rel.replace(/\.json$/, '.prev.json')))
        }
      } catch {
        // 轮转失败不阻断收口（呈现侧退化为旧行为）
      }
    }
    const driven = await runVerifyFinalize(node, input, collector)
    return {
      status: 'completed',
      loopResult,
      advance: driven.advance,
      driverReport: driven.driverReport,
      ...(driven.judgeCoverageGaps ? { judgeCoverageGaps: driven.judgeCoverageGaps } : {}),
      ...(driven.checkpoint ? { checkpoint: driven.checkpoint } : {}),
      phase: node,
    }
  }

  const outcome = finalizeDesktopDispatch(node, input, collector)
  // 刀2 checkpoint：门禁全绿待推进时落阶段存证（快照+结论）——同阶段重跑注入防重验。
  if (outcome.advance.decision === 'advance') {
    const checkpoint = await recordPhaseCheckpoint({
      projectId: input.projectId,
      requestId: input.requestId,
      stage: node.id,
      gates: node.gates.filter((g) => g.kind === 'artifact' || g.kind === 'driver').map((g) => `${g.id}: 产物核验通过`),
      summary: `desktop 阶段「${node.id}」门禁全绿待推进`,
      verification: 'recoverable',
    })
    return { status: 'completed', loopResult, advance: outcome.advance, ...(checkpoint ? { checkpoint } : {}), phase: node }
  }
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

// ── 运行遥测（telemetry 最小版，2026-10-01）：狗粮数据设施────────────────────
// 每段 dispatcher run 落一条 analytics（阶段/终态/轮数/工具与委派计数/推进判定/
// 驱动报告/时长）；狗粮复盘（收敛轮数、子会话使用度、拒收模式）从数据说话，
// 对齐竞品 E2E 观察员度量的最小等价。fire-and-forget：失败不反噬业务。
export async function runDesktopDispatcherLoop(input: DesktopDispatchRunInput): Promise<DesktopDispatchRunResult> {
  const startedAt = Date.now()
  recordDispatchStartTelemetry(input, startedAt)
  const result = await runDesktopDispatcherLoopInner(input)
  recordDispatchRunTelemetry(input, result, startedAt)
  return result
}

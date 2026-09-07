/**
 * 修复轮（P2 失败回流闭环，入口 A/B 共用零件；实施稿 §4.1）。
 *
 * 定位：终验失败（GWT 探针 / 构建门禁）从「模型末轮盲查自修」升级为结构化回流——
 * 失败证据 → RepairTask 队列 → 定向修复轮（窄任务二次 runAgentLoop）→ 全量 GWT
 * 重验（D2：不做失败子集，防改坏已过场景）→ 收敛或预算耗尽后走现状熔断口径
 * （陷阱 37 一字不改）。
 *
 * 边界（D1/D4/D5）：
 * - RepairTask 是 main 进程内部结构，**不进 shared/types.ts**——不跨 IPC、渲染端
 *   不消费；进 shared 反而触发四层链路与 ipc-contract 维护成本；
 * - judge 与安全扫描第一版不接修复轮（防与 judge_return 双修复流打架）；
 * - 修复卡约束写卡尾而非 system prompt——任务级约束随任务消失，不污染常驻段。
 *
 * 本文件分两批落位：PR-A 纯函数（类型 + 任务组装 + 卡片渲染 + 预算/轮次解析）；
 * PR-B 补 runRepairLoop 运行时（依赖注入 system 组装器，防与编程编排器循环 import）。
 */

import type { GwtTestResult } from '../gwt-service'
import type { BuildGateResult } from './build-gate'
import type { ProjectMode, AgentEvent } from '../../shared/types'
import type { ThinkingLevel } from '../../shared/reasoning-profile'
import type { SDKQuery } from '../orchestrator'
import { runAgentLoop, type AgentLoopResult } from './agent-loop'
import { buildAgentTools } from './agent-tools'
import { categoryTemperature, resolveGenerationMaxTokens } from '../model-resolution'
import { resolveChannelEnv } from '../runtime-fallback'
import { trackAnalytics } from '../platform-services'
import { appendProjectLearning } from '../learnings-log'

export type RepairSource = 'gwt' | 'build'

export interface RepairTask {
  /** 内部编号 r-1/r-2…（陷阱 42：编号内部化，组装时按序生成不猜号） */
  id: string
  source: RepairSource
  /** EARS 风格期望（When/While/If 触发 → 效果）＝场景名后半的断言原文，零改写 */
  claim: string
  /** 场景锚点 `${itemId} ${assertion}`（gwt）或省略（build，证据自带路径行号） */
  location?: string
  /** C4 探针视角 reason 原文 / esbuild stderr 摘要——零新采集，直接用 */
  evidence: string
}

/** 修复预算缺省（D6：quick 延迟敏感 1 轮；longterm 2 轮）；BLOMA_REPAIR_BUDGET 覆盖。 */
export const REPAIR_BUDGET_DEFAULTS: Record<ProjectMode, number> = { quick: 1, longterm: 2 }

/** 修复轮 maxTurns 缺省（窄任务小预算，远小于主 loop 24/40）；BLOMA_REPAIR_TURNS 覆盖。 */
export const REPAIR_MAX_TURNS_DEFAULTS: Record<ProjectMode, number> = { quick: 12, longterm: 16 }

/** env 正整数解析（对齐 resolveAgentLoopMaxTurns 口径：非数字/≤0 回退缺省）。 */
function resolvePositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  // 先取整再校验：'0.5' 不得 floor 成 0 让修复轮零预算
  const floored = Math.floor(parsed)
  return Number.isFinite(parsed) && floored > 0 ? floored : fallback
}

/** 修复预算上限（模式缺省 + BLOMA_REPAIR_BUDGET 覆盖）；计数落 project.test_repair_count。 */
export function resolveRepairBudget(mode: ProjectMode): number {
  return resolvePositiveIntEnv(process.env.BLOMA_REPAIR_BUDGET, REPAIR_BUDGET_DEFAULTS[mode])
}

/** 修复轮 maxTurns（模式缺省 + BLOMA_REPAIR_TURNS 覆盖）。 */
export function resolveRepairMaxTurns(mode: ProjectMode): number {
  return resolvePositiveIntEnv(process.env.BLOMA_REPAIR_TURNS, REPAIR_MAX_TURNS_DEFAULTS[mode])
}

/**
 * 场景名（`${itemId} ${assertion}`）→ 断言原文（claim）。
 *
 * 场景名由 gwt-runner scenarioName 拼接，第一个空格前是 F 编号锚点；claim 机械
 * 取后半零改写（场景名里的 assertion 本身就是 EARS 化断言，P0 经 earsifier）。
 * 异常形态（无空格/空白）兜底整串，不抛错。
 */
function claimFromScenario(scenario: string): string {
  const idx = scenario.indexOf(' ')
  const claim = idx >= 0 ? scenario.slice(idx + 1).trim() : scenario.trim()
  return claim || '断言未通过（场景名缺失断言原文）'
}

/** 场景名 → F 编号锚点（渲染「断言锚点 = F-xxx」定位行用）；无空格形态返回 undefined。 */
function itemIdFromScenario(scenario: string): string | undefined {
  const idx = scenario.indexOf(' ')
  return idx > 0 ? scenario.slice(0, idx) : undefined
}

/**
 * 终验证据 → 修复任务队列（纯函数，入口 A/B 共用）。
 *
 * - GWT：failure_summary 逐条转换（claim=断言原文 / location=场景锚点 / evidence=
 *   reason 原文——已含 C4 探针视角：触发状态、可见元素前后计数、探针清单）；
 * - build（PR-C 并入）：buildGate.status === 'failed' 追加构建任务，evidence 取
 *   esbuild stderr 摘要；passed/skipped 不产生任务（v1 口径：只有 failed 可修）；
 * - `unverified[]` 是「待评估不计失败」（§8.1 静态启发式防误杀），**不得**组装成
 *   修复任务——锁定用例见 tests/unit/coding/repair-loop.test.ts。
 */
export function buildRepairTasks(input: { testResult: GwtTestResult; buildGate?: BuildGateResult }): RepairTask[] {
  const tasks: RepairTask[] = []
  for (const failure of input.testResult.failure_summary) {
    tasks.push({
      id: `r-${tasks.length + 1}`,
      source: 'gwt',
      claim: claimFromScenario(failure.scenario),
      location: failure.scenario,
      evidence: failure.reason,
    })
  }
  if (input.buildGate?.status === 'failed') {
    tasks.push({
      id: `r-${tasks.length + 1}`,
      source: 'build',
      claim: '工程构建通过（esbuild 打包校验模块图完整，import 可解析）',
      evidence: input.buildGate.detail?.trim() || 'esbuild 打包校验失败（无详细错误输出）',
    })
  }
  return tasks
}

// =========================================================================
// 修复轮运行时（PR-B；实施稿 §4.3）
// =========================================================================

/** 修复轮内 web_research 预算（窄任务外呼上限，实施稿 §4.3）。 */
const REPAIR_WEB_RESEARCH_BUDGET = 2

/** 统一的取消边界（与编程编排器同款口径）。 */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('AGENT_CANCELLED')
}

/** 修复模式段（追加在背板锚定 system 之后：当前处于定向修复轮，任务卡即全部工作）。 */
const REPAIR_MODE_SECTION = [
  '【修复模式】当前处于定向修复轮：下方的修复任务卡是本轮全部工作，完成后简要总结即可。',
  '不要重新生成整个项目，不要改动修复任务卡之外的任何文件或功能。',
].join('\n')

export interface RepairLoopInput {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  /** 停止信号（陷阱 42：全程贯穿；abort 后不发卡、不落收尾决策日志） */
  signal?: AbortSignal
  channel_id?: string
  query: SDKQuery
  /** 本轮修复任务（入口组装器用 buildRepairTasks 产出） */
  tasks: RepairTask[]
  /** 当前修复轮次（从 1 起；预算计数落 project.test_repair_count） */
  round: number
  /** system 组装器（编程编排器注入 buildLoopSystemWithOverride 同款背板锚定 + 骨架地图；
   * 参数 = 修复轮解析出的 editFormat；依赖注入防与编排器循环 import） */
  buildSystem: (editFormat: 'diff' | 'whole') => string
  /** 思考档位（编排器解析后传入；缺省不传 = loop 内部缺省） */
  thinkingLevel?: ThinkingLevel
  /** 事件发布（编排器 publish 包装） */
  publish: (type: AgentEvent['type'], payload: Record<string, unknown>) => void
}

export interface RepairRoundResult {
  status: 'completed' | 'cancelled' | 'budget_exhausted' | 'error'
  tasks: RepairTask[]
  loopResult?: AgentLoopResult
}

/**
 * 定向修复轮（入口 A/B 共用）：窄任务二次 runAgentLoop（D3：全新调用，无
 * historyTurns；背板锚定 system + 修复卡即全部上下文）。
 *
 * - 渠道解析一律走 resolveChannelEnv（陷阱 23；category='mvp'，requireTools）；
 * - 渠道不可用 / loop 异常 → status:'error' 不阻断交付链（修复轮是增强不是依赖，
 *   调用方按现状熔断口径收口）；
 * - cancelled → throw AGENT_CANCELLED（U5 同款：不补脚手架、不终验、不改阶段），
 *   abort 后不发卡、不落收尾决策（陷阱 42）；
 * - 结束沉淀 learnings（kind:'repair_outcome'，静默失败不阻断），下轮 fresh loop
 *   经【历史经验】段注入。
 */
export async function runRepairLoop(input: RepairLoopInput): Promise<RepairRoundResult> {
  throwIfAborted(input.signal)

  // 渠道解析（陷阱 23）：与主 loop 同口径，勿手写解密块
  const resolution = resolveChannelEnv({
    channelId: input.channel_id,
    category: 'mvp',
    projectId: input.project_id,
    sessionId: input.session_id,
    requireTools: true,
  })
  if (!resolution.env || !resolution.channel) {
    // fail-open：修复渠道不可用不阻断交付链，如实留痕后由入口走现状熔断
    appendProjectLearning(input.project_id, {
      kind: 'repair_outcome',
      text: `修复轮（第 ${input.round} 轮）未执行：渠道不可用（${resolution.unusableReason ?? 'unknown'}）`,
      meta: { status: 'error', round: input.round, reason: resolution.unusableReason },
    })
    return { status: 'error', tasks: input.tasks }
  }
  const env = resolution.env
  const channel = resolution.channel
  const editFormat = channel.models?.find((candidate) => candidate.enabled && candidate.name === env.ANTHROPIC_MODEL)?.edit_format ?? 'diff'

  throwIfAborted(input.signal)

  let loopResult: AgentLoopResult
  try {
    loopResult = await runAgentLoop({
      system: `${input.buildSystem(editFormat)}\n\n${REPAIR_MODE_SECTION}`,
      task: renderRepairTaskCard(input.tasks),
      // 窄任务小预算：web_research 限 2 防长 loop 无节制外呼（主 loop 为 4）
      toolBudget: { web_research: REPAIR_WEB_RESEARCH_BUDGET },
      tools: buildAgentTools({
        projectId: input.project_id,
        editFormat,
        // 埋点通道复用（self_repair_triggered, via:'repair_loop'）
        onRepairRound: (round) => {
          trackAnalytics({
            request_id: input.request_id,
            event: {
              event_type: 'self_repair_triggered',
              project_id: input.project_id,
              session_id: input.session_id,
              payload: { attempt: round, category: 'test_error', via: 'repair_loop' },
              privacy_level: 'research_safe',
            },
          })
        },
      }),
      query: input.query,
      env,
      sessionId: input.session_id,
      projectId: input.project_id,
      requestId: input.request_id,
      maxTokens: resolveGenerationMaxTokens(channel),
      maxTurns: resolveRepairMaxTurns(input.mode),
      permissionMode: 'allow-all',
      temperature: categoryTemperature('mvp'),
      providerType: channel.provider_type,
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      signal: input.signal ?? new AbortController().signal,
      publish: input.publish,
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('AGENT_CANCELLED')) throw err
    // 修复轮自身异常不阻断交付链：如实沉淀后按现状熔断收口
    appendProjectLearning(input.project_id, {
      kind: 'repair_outcome',
      text: `修复轮（第 ${input.round} 轮）异常终止：${err instanceof Error ? err.message : String(err)}`,
      meta: { status: 'error', round: input.round },
    })
    return { status: 'error', tasks: input.tasks }
  }

  // U5 同款口径：取消后不补脚手架、不终验、不改阶段、不发卡（陷阱 42）
  if (loopResult.status === 'cancelled') {
    throw new Error(`AGENT_CANCELLED: 修复轮已取消（${loopResult.turns} 轮），中止终验`)
  }

  appendProjectLearning(input.project_id, {
    kind: 'repair_outcome',
    text: `修复轮（第 ${input.round} 轮）：${loopResult.status}，${loopResult.turns} 轮 / ${loopResult.toolCalls.length} 次工具调用`,
    meta: { status: loopResult.status, round: input.round, tasks: input.tasks.map((task) => task.id) },
  })

  return { status: 'completed', tasks: input.tasks, loopResult }
}

/** 修复卡尾注三项硬约束（D5：写卡尾而非 system，随任务消失不污染常驻段）。 */
const REPAIR_CARD_CONSTRAINTS = [
  '三项硬约束（必须遵守）：',
  '1. 只修复上面列出的项，不要改动其他任何文件或功能；',
  '2. 每完成一项修复，立即用浏览器自验：run_preview 打开页面，手动触发对应操作确认效果；',
  '3. 禁止重构与本轮修复无关的代码。',
]

function renderGwtTaskBlock(task: RepairTask): string {
  const anchor = task.location ? itemIdFromScenario(task.location) : undefined
  const lines = [
    `### [${task.id}] ${task.location ?? task.claim}`,
    `- 期望：${task.claim}`,
    `- 实际：${task.evidence}`,
  ]
  if (anchor) lines.push(`- 定位：先用 grep/read_file 定位相关实现代码；断言锚点 = ${anchor}`)
  return lines.join('\n')
}

function renderBuildTaskBlock(task: RepairTask): string {
  return [
    `### [${task.id}] 构建失败（esbuild 打包校验未通过）`,
    `- 期望：${task.claim}`,
    `- 实际：${task.evidence}`,
    '- 定位：按报错中的文件路径与行号定位 import 引用，修正或补齐对应模块',
  ].join('\n')
}

/**
 * 修复任务队列 → 修复卡（纯文本注入，EARS 句式任务卡 + 卡尾三约束）。
 *
 * 修复卡是纯文本不是可解析 JSON——不适用截断重试逻辑（陷阱 7 只管代码型 JSON）；
 * 修复轮产物校验靠 GWT 重验而非解析。空队列返回空串（组装器幂等：无任务即不注入）。
 */
export function renderRepairTaskCard(tasks: RepairTask[]): string {
  if (tasks.length === 0) return ''
  const blocks = tasks.map((task) => (task.source === 'gwt' ? renderGwtTaskBlock(task) : renderBuildTaskBlock(task)))
  return [`## 修复任务（共 ${tasks.length} 项，只修这些，不要动其他任何文件/功能）`, ...blocks, REPAIR_CARD_CONSTRAINTS.join('\n')].join(
    '\n\n',
  )
}

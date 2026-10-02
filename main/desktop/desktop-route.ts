/**
 * 桌面线路由器（接线批，2026-09-24）——runAgent 意图分流 + PRD 确认改道 + 凭据链。
 *
 * 刀1（2026-10-02 确认协议重设计）：中间阶段 manual 门全部撤除——门禁全绿自动
 * 推进，人工只保留 Intent 层（PRD 确认）与异常处理（停止词/blocked 放行/门禁耗尽
 * 人话卡）。旧确认卡回传按协议升级告知兼容处理，不再发新卡。
 *
 * 承接批次 D 的 runDesktopDispatcherLoop 与批次 E 的拒收闭环：
 *   分流（agent-dispatch 调用）：BLOMA_DESKTOP_DISPATCH on 且项目 template_type=
 *   desktop_tool 且 desktop_phase 在桌面表内 → 本路由接管全部消息（含卡回传）；
 *   PRD 改道（prd-confirm 调用）：桌面项目 PRD 确认后不进 web 线草图，置
 *   desktop_phase='desktop-arch' 进入桌面线并跑首个阶段。
 *
 * 架构边界（R1）：desktop 域不运行时依赖 orchestration——事件发布/消息落盘经
 * deps 注入（orchestration 层适配 makeEvent/appendAgentMessage）；SDKQuery 等
 * 仅类型导入（豁免）。
 *
 * 开关字节锁：所有入口先过 isDesktopDispatchEnabled；off 时调用方短路，web 线
 * 零行为变化。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../../shared/types'
import type { SDKQuery } from '../orchestration/orchestrator' // 类型导入豁免（R1）
import { findProject, updateProject } from '../project/project-service'
import { getDesktopPhase, getNextDesktopPhase } from './dispatcher-phases'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { runDesktopDispatcherLoop, type DesktopDispatchRunInput, type DesktopDispatchRunResult } from './dispatcher-loop'
import { clearRejectionOnAdvance, createRejectionLedger, decideRejectionLoop, registerRejection, type RejectionLedger } from './advance-rejection-loop'
import { buildBlockedNoticeCard, buildDeliveredNoticeCard, digestDeliveryDoc } from './notice-cards'
import { classifyUserDesktopIntent } from './user-intent-lexicon'
import { readDesktopRequirementsDigest } from './requirement-digest'

// =========================================================================
// 桌面线判定
// =========================================================================

/** 项目记录的最小判定面（Project 子集——测试可不落盘构造）。 */
export interface DesktopLineProjectLike {
  template_type: string
  desktop_phase?: string
}

/** 桌面线是否接管该项目的消息路由（开关 + 品类 + 已进入桌面阶段）。 */
export function isDesktopLineActive(project: DesktopLineProjectLike | undefined): boolean {
  if (!isDesktopDispatchEnabled()) return false
  if (!project || project.template_type !== 'desktop_tool') return false
  const phase = project.desktop_phase
  return typeof phase === 'string' && getDesktopPhase(phase) !== undefined
}

/** 改道判定（PRD 确认点用）：开关 + 品类即改道（desktop_phase 未设也进——正在进入）。 */
export function shouldEnterDesktopLine(project: DesktopLineProjectLike | undefined): boolean {
  return isDesktopDispatchEnabled() && project?.template_type === 'desktop_tool'
}

// =========================================================================
// 路由依赖注入（orchestration 层适配）
// =========================================================================

/** 路由层外部效应面（测试全桩化；生产由 agent-dispatch 注入）。 */
export interface DesktopRouteDeps {
  /** 事件发布（生产=streamPublisher∘makeEvent；type+payload 直传）。 */
  publish: (input: { sessionId: string; projectId: string }, type: AgentEvent['type'], payload: Record<string, unknown>) => void
  /** 助手消息落盘（生产=appendAgentMessage）。 */
  persistAssistant: (sessionId: string, text: string) => void
  /** 内部标记落盘（生产=appendAgentMessage system role）。 */
  persistSystem: (sessionId: string, text: string) => void
  /** 终态事件（生产=persistTerminalMessage+completed 事件；路由收尾统一调）。
   *  P2-01：outcome 区分成功收口与未收口/取消——成功终态与未收口不再共用同一 success 事件
   *  （旧口径桌面未收口也发 subtype:success，下游/渲染端误当跑完）。 */
  complete: (sessionId: string, projectId: string, outcome?: 'success' | 'incomplete') => void
  /** 驱动 spawn 注入（可选；生产缺省 execFileDriverSpawn，测试桩 pass/fail）。 */
  driverSpawn?: DesktopDispatchRunInput['driverSpawn']
  /** 需求摘要注入（首跑修复：PRD 背板 → 调度员系统提示词与子会话基底；编排层装配，缺省不注入）。 */
  requirementsDigest?: (projectId: string) => string | undefined
}

// =========================================================================
// 账本（项目级内存态；进程重启丢失可接受——拒收计数是短期防环状态）
// =========================================================================

const ledgers = new Map<string, RejectionLedger>()

function ledgerOf(projectId: string): RejectionLedger {
  let ledger = ledgers.get(projectId)
  if (!ledger) {
    ledger = createRejectionLedger()
    ledgers.set(projectId, ledger)
  }
  return ledger
}

/** 测试隔离：清空账本。 */
export function resetDesktopRouteLedgersForTests(): void {
  ledgers.clear()
}

// =========================================================================
// PRD 确认改道
// =========================================================================

/**
 * 进入桌面线（PRD 确认后改道）：置 desktop_phase=desktop-arch 并跑首个阶段。
 * 返回 true=已改道（调用方不再走 runSketchTask）；false=不该改道（调用方走原路径）。
 */
export async function enterDesktopLine(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal },
  query: SDKQuery,
  env: Record<string, string>,
  deps: DesktopRouteDeps,
): Promise<boolean> {
  const project = findProject(input.projectId)
  if (!shouldEnterDesktopLine(project)) return false
  const projectName = project?.name ?? input.projectId
  updateProject(input.projectId, { desktop_phase: 'desktop-arch' })
  deps.publish(input, 'stage_changed', { stage: 'desktop-arch' })
  deps.publish(input, 'message_delta', { text: `PRD 已确认。本项目为桌面品类，切换到桌面调度员线：从「桌面选型与架构」阶段开始（web 草图流程跳过）。` })
  await runDesktopStage(input, query, env, 'desktop-arch', deps, projectName, 0)
  return true
}

// =========================================================================
// 消息路由主入口（agent-dispatch 分流调用）
// =========================================================================

/** 路由输入面（orchestration 层从 AgentSendMessageInput 抽取）。 */
export interface DesktopRouteInput {
  projectId: string
  sessionId: string
  requestId: string
  /** 用户消息文本（card_option 回传时为选项说明，仅留痕用） */
  content: string
  /** card_option 回传的选项 id（metadata.source==='card_option' 时有值） */
  cardOptionId?: string
  query: SDKQuery
  env: Record<string, string>
  maxTokens: number
  /** 取消信号（透传调度员 loop；缺省不可取消） */
  signal?: AbortSignal
}

/** 确认卡选项 id 前缀（刀1 前的旧协议；保留仅用于识别旧卡回传——不再发新卡）。 */
export const DESKTOP_CONFIRM_OPTION_PREFIX = 'desktop_confirm:'

/**
 * 桌面线消息路由（接管后全部消息进这里）：
 * - 旧确认卡回传（刀1 协议升级）：如实告知已无需人工确认，照常跑当前阶段；
 * - 停止/反悔词（user-intent-lexicon）：置 desktop_blocked + 人话卡，不跑调度员；
 * - blocked 态（继续词或普通消息）：人工出场即放行，清 blocked 后跑当前阶段；
 * - 普通消息 → 当前桌面阶段调度员 run + 收口处理。
 */
export async function handleDesktopDispatchMessage(
  input: DesktopRouteInput,
  deps: DesktopRouteDeps,
): Promise<void> {
  const project = findProject(input.projectId)
  const projectName = project?.name ?? input.projectId
  const phaseId = project?.desktop_phase ?? 'desktop-arch'

  // ── 旧确认卡回传（刀1 兼容）：确认卡已不再发出，点击旧卡如实告知并照常推进 ──
  if (input.cardOptionId && input.cardOptionId.startsWith(DESKTOP_CONFIRM_OPTION_PREFIX)) {
    deps.publish(input, 'message_delta', {
      text: '确认协议已升级：中间阶段不再需要人工确认，门禁全绿自动推进。已按当前阶段继续处理你的消息。',
    })
    await runDesktopStage({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: input.content, signal: input.signal }, input.query, input.env, phaseId, deps, projectName, 0)
    return
  }

  // ── 文本意图分流（刀1：用户权力出口——停止词立即暂停流水线）──
  const intent = classifyUserDesktopIntent(input.content)
  if (intent === 'stop') {
    const node = getDesktopPhase(phaseId)
    updateProject(input.projectId, {
      desktop_blocked: { reason: 'user-stop', note: input.content.slice(0, 200), at: new Date().toISOString() },
    })
    deps.publish(input, 'message_delta', {
      text: buildBlockedNoticeCard({
        phaseTitle: node?.title ?? phaseId,
        whatHappened: `你已叫停「${node?.title ?? phaseId}」阶段，流水线暂停。`,
      }),
    })
    deps.persistSystem(input.sessionId, `[decision] desktop-stop ${phaseId}（用户停止词命中，转 blocked）`)
    deps.complete(input.sessionId, input.projectId, 'incomplete')
    return
  }

  // ── blocked 态放行：继续词=放行授权；普通消息=人工出场即放行（带意见干活）──
  if (project?.desktop_blocked) {
    updateProject(input.projectId, { desktop_blocked: undefined })
    const node = getDesktopPhase(phaseId)
    if (intent === 'continue') {
      deps.publish(input, 'message_delta', { text: `已放行，从「${node?.title ?? phaseId}」阶段继续。` })
    }
    deps.persistSystem(input.sessionId, `[decision] desktop-unblock ${phaseId}（${intent === 'continue' ? '继续词放行' : '人工出场放行'}）`)
  }

  await runDesktopStage({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: input.content, signal: input.signal }, input.query, input.env, phaseId, deps, projectName, 0)
}

// =========================================================================
// 单阶段执行 + 收口处理
// =========================================================================

/** 一次 run 内自动续跑的阶段数上限（推进链防失控；确认门/拒收会自然断链）。 */
export const MAX_AUTO_ADVANCE_CHAIN = 3

async function runDesktopStage(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal },
  query: SDKQuery,
  env: Record<string, string>,
  phaseId: string,
  deps: DesktopRouteDeps,
  projectName: string,
  chainDepth: number,
): Promise<void> {
  const node = getDesktopPhase(phaseId)
  if (!node) {
    deps.publish(input, 'message_delta', { text: `桌面阶段「${phaseId}」不在阶段表内（数据异常）。请人工检查项目状态。` })
    deps.complete(input.sessionId, input.projectId)
    return
  }
  const project = findProject(input.projectId)
  const sandboxRoot = project?.root_path
  // 首跑修复：需求摘要（PRD 背板 → 调度员/子会话上下文；deps 覆写位供测试与异地装配）
  const requirementsDigest = deps.requirementsDigest
    ? deps.requirementsDigest(input.projectId)
    : readDesktopRequirementsDigest(input.projectId)

  const loopInput: DesktopDispatchRunInput = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    currentPhase: phaseId,
    task: input.content,
    query,
    env,
    maxTokens: 640000,
    signal: input.signal ?? new AbortController().signal,
    publish: (type, payload) => {
      // 调度员 loop 的过程事件按原类型直通渲染端（首跑修复：此前误折叠为 message_delta，
      // tool_call/delegation 等事件类型丢失——工具行与协作胶囊的实时显示都依赖真实类型）。
      deps.publish(input, type, payload)
    },
    projectName,
    requirementsDigest,
    sandboxRoot,
    driverSpawn: deps.driverSpawn,
    readContract: () => {
      const path = sandboxRoot ? join(sandboxRoot, '00_SCAFFOLD', 'contract.json') : undefined
      if (path && existsSync(path)) return readFileSync(path, 'utf8')
      return undefined
    },
    writeReport: (rel, content) => {
      if (!sandboxRoot) return
      const path = join(sandboxRoot, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content, 'utf8')
    },
  }
  const result = await runDesktopDispatcherLoop(loopInput)
  await settleDesktopStage(input, query, env, result, phaseId, deps, projectName, chainDepth)
}

/**
 * 收口处理（刀1 重设计）：advance → 落 desktop_phase + 清拒收账 + （链预算内）
 * 自动续跑下一阶段；终态（delivered）→ 交付通知卡（通知≠确认，不阻塞不等待）；
 * reject → 拒收闭环（账本+防环+续接）；闭环耗尽 → desktop_blocked + 人话卡
 * （人工是异常处理器不是流水线工位）。
 */
async function settleDesktopStage(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal },
  query: SDKQuery,
  env: Record<string, string>,
  result: DesktopDispatchRunResult,
  phaseId: string,
  deps: DesktopRouteDeps,
  projectName: string,
  chainDepth: number,
): Promise<void> {
  // ── loop 未完成（取消/断流）：话术收尾，阶段不动 ──
  if (result.status !== 'completed' || !result.advance) {
    const why = result.status === 'cancelled' ? '已停止' : '运行异常中断'
    deps.publish(input, 'message_delta', { text: `桌面阶段「${phaseId}」本轮未收口（${why}）。阶段进度未变化，可重新发起。` })
    deps.complete(input.sessionId, input.projectId, 'incomplete')
    return
  }

  const decision = result.advance

  // ── advance：落阶段 + 清账 + 自动续跑（链预算内；终态/非接管节点不续跑）──
  if (decision.decision === 'advance') {
    const ledger = ledgerOf(input.projectId)
    clearRejectionOnAdvance(ledger, phaseId)
    const next = getNextDesktopPhase(phaseId)
    const nextNode = next !== null ? getDesktopPhase(next) : undefined
    if (next === null || nextNode?.dispatcherManaged === false) {
      // 终态（delivered）：终态字段收口 + 交付通知卡（刀1：通知≠确认——不阻塞不等待，
      // 用户回复修改意见走迭代）；不续跑（delivered 是哨兵节点，无任务可跑）
      const finalPhase = next ?? 'delivered'
      updateProject(input.projectId, { desktop_phase: finalPhase, status: 'completed', current_stage: 'completed' })
      deps.publish(input, 'stage_changed', { stage: finalPhase })
      deps.publish(input, 'message_delta', { text: buildDeliveredNoticeCard(assembleDeliveredNotice(input.projectId, projectName, phaseId, result)) })
      deps.persistSystem(input.sessionId, `[decision] desktop-advance ${phaseId} → ${finalPhase}（终态，交付通知卡已发）`)
      deps.complete(input.sessionId, input.projectId)
      return
    }
    updateProject(input.projectId, { desktop_phase: next })
    deps.publish(input, 'stage_changed', { stage: next })
    deps.persistSystem(input.sessionId, `[decision] desktop-advance ${phaseId} → ${next}`)
    if (chainDepth + 1 >= MAX_AUTO_ADVANCE_CHAIN) {
      deps.publish(input, 'message_delta', { text: `阶段「${phaseId}」已通过门禁推进到「${next}」。本轮自动推进预算已用完——发送任意消息继续下一阶段。` })
      deps.complete(input.sessionId, input.projectId)
      return
    }
    deps.publish(input, 'message_delta', { text: `阶段「${phaseId}」门禁通过，自动进入「${next}」。` })
    await runDesktopStage(input, query, env, next, deps, projectName, chainDepth + 1)
    return
  }

  // ── reject：拒收闭环（四要素——可见+驱动+防环+降级）──
  const ledger = ledgerOf(input.projectId)
  const action = decideRejectionLoop(ledger, phaseId, decision)
  registerRejection(ledger, phaseId, action.family, action.count)

  // 刀1（2026-10-02）：confirmation-required 分支已随阶段表撤 manual 门删除——
  // 中间阶段门禁全绿即推进，确认卡不再发出；拒收只剩教育续接与降级两态。

  // 教育可见 + 续接指令驱动（systemInitiated 语义：下一轮任务即续接指令；
  // 当前接线以「续接指令作为下一条用户输入自动重跑同阶段」实现自动驱动，防环账本兜底）
  deps.publish(input, 'message_delta', { text: action.education })
  if (action.continuation && !action.degrade) {
    deps.persistSystem(input.sessionId, `[decision] desktop-reject ${phaseId}（${decision.reason}）第 ${action.count} 次闭环，续接驱动`)
    await runDesktopStage(
      { projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: action.continuation },
      query, env, phaseId, deps, projectName, chainDepth,
    )
    return
  }
  // 降级（第 3+ 次）：转 blocked + 人话卡（刀1：出什么事/两个选项/最新证据——
  // 人工是异常处理器，只在修复轮耗尽时出场；继续词放行见 handleDesktopDispatchMessage）
  const node = getDesktopPhase(phaseId)
  updateProject(input.projectId, {
    desktop_blocked: { reason: 'gate-exhausted', note: decision.reason, at: new Date().toISOString() },
  })
  const evidenceHint = extractEvidenceHint(decision)
  deps.publish(input, 'message_delta', {
    text: buildBlockedNoticeCard({
      phaseTitle: node?.title ?? phaseId,
      whatHappened: `「${node?.title ?? phaseId}」阶段连续 ${action.count} 次未通过门禁（${decision.reason}），自动修复已到上限，流水线暂停。`,
      ...(evidenceHint ? { evidence: evidenceHint } : {}),
    }),
  })
  deps.persistSystem(input.sessionId, `[decision] desktop-reject ${phaseId}（${decision.reason}）第 ${action.count} 次闭环已降级转 blocked（人话卡已发）`)
  deps.complete(input.sessionId, input.projectId)
}

/** 拒收教育 → 人话证据行（「执行证据：」段优先，否则「发生了什么：」段，截 200 字）。 */
function extractEvidenceHint(decision: { education?: string }): string | undefined {
  const edu = decision.education ?? ''
  const evidence = edu.match(/执行证据：(.+)/)
  if (evidence) return evidence[1].slice(0, 200)
  const what = edu.match(/发生了什么：(.+)/)
  if (what) return what[1].slice(0, 200)
  const firstLine = edu.split(/\r?\n/).find((line) => line.trim().length > 0)
  return firstLine ? firstLine.slice(0, 200) : undefined
}

/** delivered 通知卡装配数据（读项目根 DELIVERY.md/契约 entry；展示性数据 fail-open）。 */
function assembleDeliveredNotice(
  projectId: string,
  projectName: string,
  fromPhase: string,
  result: DesktopDispatchRunResult,
) {
  const root = findProject(projectId)?.root_path
  let entryFile: string | undefined
  let deliveryDigest: string | undefined
  if (root) {
    try {
      const parsed = JSON.parse(readFileSync(join(root, '00_SCAFFOLD', 'contract.json'), 'utf8')) as { entry?: unknown }
      if (typeof parsed.entry === 'string') entryFile = parsed.entry
    } catch {
      // 展示性数据 fail-open：契约缺失/不可解析时通知卡省略入口行
    }
    try {
      deliveryDigest = digestDeliveryDoc(readFileSync(join(root, 'DELIVERY.md'), 'utf8'))
    } catch {
      // 同上：DELIVERY.md 缺失时只提示位置
    }
  }
  const report = result.driverReport
  const driverSummary = report && report.scenarios.length > 0
    ? { passed: report.scenarios.filter((s) => s.outcome === 'pass').length, total: report.scenarios.length }
    : undefined
  return {
    projectName,
    fromPhaseTitle: getDesktopPhase(fromPhase)?.title ?? fromPhase,
    ...(entryFile ? { entryFile } : {}),
    ...(deliveryDigest ? { deliveryDigest } : {}),
    ...(driverSummary ? { driverSummary } : {}),
  }
}

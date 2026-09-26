/**
 * 桌面线路由器（接线批，2026-09-24）——runAgent 意图分流 + PRD 确认改道 + 凭据链。
 *
 * 承接批次 D 的 runDesktopDispatcherLoop 与批次 E 的拒收闭环，把它们接进编排层：
 *   分流（agent-dispatch 调用）：BLOMA_DESKTOP_DISPATCH on 且项目 template_type=
 *   desktop_tool 且 desktop_phase 在桌面表内 → 本路由接管全部消息（含卡回传）；
 *   PRD 改道（prd-confirm 调用）：桌面项目 PRD 确认后不进 web 线草图，置
 *   desktop_phase='desktop-arch' 进入桌面线并跑首个阶段。
 *
 * 确认凭据链（manual 门禁闭环）：收口拒收 confirmation-required → 发确认卡
 * （user_decision_required，选项 id=desktop_confirm:<phase>）→ 用户点选 →
 * card_option 回传进本路由 → 登记 desktop_confirmed_phases → 下轮收口放行。
 *
 * 架构边界（R1）：desktop 域不运行时依赖 orchestration——事件发布/消息落盘经
 * deps 注入（orchestration 层适配 makeEvent/appendAgentMessage）；SDKQuery 等
 * 仅类型导入（豁免）。
 *
 * 开关字节锁：所有入口先过 isDesktopDispatchEnabled；off 时调用方短路，web 线
 * 零行为变化。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AgentEvent } from '../../shared/types'
import type { SDKQuery } from '../orchestration/orchestrator' // 类型导入豁免（R1）
import { findProject, updateProject } from '../project/project-service'
import { getDesktopPhase, getNextDesktopPhase } from './dispatcher-phases'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { runDesktopDispatcherLoop, type DesktopDispatchRunInput, type DesktopDispatchRunResult } from './dispatcher-loop'
import { clearRejectionOnAdvance, createRejectionLedger, decideRejectionLoop, registerRejection, type RejectionLedger } from './advance-rejection-loop'
import { computeEntryFingerprint } from '../verification/gwt-service'
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

/** 确认卡选项 id 前缀（凭据链协议：desktop_confirm:<phase>）。 */
export const DESKTOP_CONFIRM_OPTION_PREFIX = 'desktop_confirm:'

/**
 * 桌面线消息路由（接管后全部消息进这里）：
 * - 确认卡回传（选项 id 匹配前缀）→ 登记凭据 → 立即重跑当前阶段收口（凭据已备，
 *   门禁放行即推进）；
 * - 普通消息 → 当前桌面阶段调度员 run + 收口处理。
 */
export async function handleDesktopDispatchMessage(
  input: DesktopRouteInput,
  deps: DesktopRouteDeps,
): Promise<void> {
  const project = findProject(input.projectId)
  const projectName = project?.name ?? input.projectId
  const phaseId = project?.desktop_phase ?? 'desktop-arch'

  // ── 确认卡回传：校验卡有效性（nonce/阶段/产物指纹）→ 凭据登记 + 重跑收口 ──
  if (input.cardOptionId && input.cardOptionId.startsWith(DESKTOP_CONFIRM_OPTION_PREFIX)) {
    // 选项 id 协议：desktop_confirm:<phase>[:<nonce>]（nonce 段为 P2-01 新增；旧卡无此段）
    const [, rawPhase, cardNonce] = input.cardOptionId.split(':')
    const confirmedPhase = (rawPhase ?? '').trim()
    // P2-01（2026-09-26 运行审计）：确认卡绑定阶段+nonce+产物指纹——旧卡不得重跑旧阶段。
    const staleReason =
      cardNonce !== project?.desktop_confirm_nonce || !project?.desktop_confirm_nonce
        ? '该确认卡已失效（不是当前待确认卡——可能已被新卡替换或已使用过）'
        : confirmedPhase !== project?.desktop_phase
          ? `该确认卡已过期（阶段已推进到「${project?.desktop_phase ?? '未知'}」）`
          : (() => {
              const expected = project?.desktop_confirm_fingerprint
              if (!expected) return undefined
              const current = computeEntryFingerprint(project!.root_path)
              return current && current.sha256 !== expected ? '产物在确认前已被修改（指纹不一致）' : undefined
            })()
    if (staleReason) {
      deps.publish(input, 'message_delta', { text: `确认未生效：${staleReason}。请按当前阶段的待办重新确认或继续说明诉求。` })
      deps.complete(input.sessionId, input.projectId, 'incomplete')
      return
    }
    if (getDesktopPhase(confirmedPhase)) {
      const existing = new Set(project?.desktop_confirmed_phases ?? [])
      existing.add(confirmedPhase)
      updateProject(input.projectId, { desktop_confirmed_phases: [...existing], desktop_confirm_nonce: undefined, desktop_confirm_fingerprint: undefined })
      deps.persistSystem(input.sessionId, `[decision-card] 桌面阶段确认：${confirmedPhase}（凭据已登记）`)
      deps.publish(input, 'message_delta', { text: `已确认「${getDesktopPhase(confirmedPhase)?.title ?? confirmedPhase}」，继续推进。` })
      await runDesktopStage({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: input.content, signal: input.signal }, input.query, input.env, confirmedPhase, deps, projectName, 0)
      return
    }
    // 非法选项 id：如实告知，不推进不崩
    deps.publish(input, 'message_delta', { text: '收到确认回传，但选项不匹配任何桌面阶段——已忽略。请继续说明你的诉求。' })
    deps.complete(input.sessionId, input.projectId, 'incomplete')
    return
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
    confirmedPhases: new Set(project?.desktop_confirmed_phases ?? []),
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
 * 收口处理：advance → 落 desktop_phase + 清拒收账 + （链预算内）自动续跑下一阶段；
 * reject → 拒收闭环（账本+防环；confirmation-required 发确认卡，其余教育回播）。
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
      // 终态（delivered）：终态字段收口，不续跑（delivered 是哨兵节点，无任务可跑）
      const finalPhase = next ?? 'delivered'
      updateProject(input.projectId, { desktop_phase: finalPhase, status: 'completed', current_stage: 'completed' })
      deps.publish(input, 'stage_changed', { stage: finalPhase })
      deps.publish(input, 'message_delta', { text: `桌面线交付完成（阶段「${phaseId}」→ ${finalPhase}）。产物在项目目录，后续迭代走既有流程。` })
      deps.persistSystem(input.sessionId, `[decision] desktop-advance ${phaseId} → ${finalPhase}（终态）`)
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

  if (decision.reason === 'confirmation-required' && !action.degrade) {
    // 发确认卡（凭据链入口）；教育文案同步可见
    deps.publish(input, 'message_delta', { text: action.education })
    deps.persistSystem(input.sessionId, `[decision-card] 桌面阶段确认｜继续沟通（${phaseId}）`)
    // P2-01：卡绑定当前阶段 + 一次性 nonce + 发卡时产物指纹（确认回传须全部匹配）
    const confirmNonce = randomUUID()
    // 发卡上下文无外层 project 变量：就地读取（阶段收口后产物指纹）
    const confirmFingerprint = computeEntryFingerprint(findProject(input.projectId)?.root_path ?? '')?.sha256
    updateProject(input.projectId, {
      desktop_confirm_nonce: confirmNonce,
      ...(confirmFingerprint ? { desktop_confirm_fingerprint: confirmFingerprint } : { desktop_confirm_fingerprint: undefined }),
    })
    deps.publish(input, 'user_decision_required', {
      kind: 'desktop_phase_confirm',
      title: `确认·${getDesktopPhase(phaseId)?.title ?? phaseId}`,
      questions: [
        { id: `${DESKTOP_CONFIRM_OPTION_PREFIX}${phaseId}:${confirmNonce}`, label: '确认通过', description: '本阶段产出与验收结论确认无误，推进到下一阶段' },
        { id: 'desktop_confirm:cancel', label: '还有问题', description: '在对话里说明问题，调度员继续处理' },
      ],
    })
    deps.complete(input.sessionId, input.projectId)
    return
  }

  if (decision.reason === 'confirmation-required' && action.degrade) {
    // 降级：确认拒收反复发生（模型反复在未确认时推标记）——教育+转人工，无卡无续接
    deps.publish(input, 'message_delta', { text: action.education })
    deps.complete(input.sessionId, input.projectId)
    return
  }

  // 其余拒因：教育可见 + 续接指令驱动（systemInitiated 语义：下一轮任务即续接指令；
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
  // 降级（第 3+ 次）：教育 + 转人工，不再续接
  deps.persistSystem(input.sessionId, `[decision] desktop-reject ${phaseId}（${decision.reason}）第 ${action.count} 次闭环已降级转人工`)
  deps.complete(input.sessionId, input.projectId)
}

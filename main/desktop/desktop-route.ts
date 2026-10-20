/**
 * 桌面线路由器（接线批，2026-09-24）——runAgent 意图分流 + PRD 确认改道 + 凭据链。
 *
 * 刀1（2026-10-02 确认协议重设计）：中间阶段 manual 门全部撤除——门禁全绿自动
 * 推进，人工只保留 Intent 层（PRD 确认）与异常处理（停止词/blocked 放行/门禁耗尽
 * 人话卡）。旧确认卡回传按协议升级告知兼容处理，不再发新卡。
 *
 * quick 跳过 arch/scaffold及契约verify，先过核心/安全/启动门；v2实验另经独立V审阅。
 * 各阶段的事实、依赖、权限与交付仍由宿主裁决。
 *
 * 承接批次 D 的 runDesktopDispatcherLoop 与批次 E 的拒收闭环：
 *   分流（agent-dispatch 调用）：BLOMA_DESKTOP_DISPATCH on 且项目 template_type=
 *   desktop_tool/game 且 desktop_phase 在桌面表内 → 本路由接管全部消息（含卡回传）；
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
import { readConfirmedUxBinding } from '../project/ux-binding'
import { holdExperimentBeforeImplement, readExperiment, recordExperiment, recordExperimentBoundary } from './dispatch-experiment'
import { readPrdBackplane } from '../project/prd-store'
import { getDesktopPhase, getNextDesktopPhase } from './dispatcher-phases'
import { isDesktopDispatchEnabled } from './dispatcher-switch'
import { runDesktopDispatcherLoop, type DesktopDispatchRunInput, type DesktopDispatchRunResult } from './dispatcher-loop'
import { clearRejectionOnAdvance, createRejectionLedger, decideRejectionLoop, registerRejection, type RejectionLedger } from './advance-rejection-loop'
import { buildBlockedNoticeCard, buildDeliveredNoticeCard } from './notice-cards'
import { assembleDeliveredNotice } from './delivered-notice'
import { runLaunchSmoke, type LaunchSmokeResult } from './launch-smoke'
import { recordDeliveryOutcomeTelemetry } from './dispatcher-telemetry'

/** 启动冒烟门缺省实现（2026-10-04；批1 2026-10-06 起服务 quick/longterm 双路）：读项目根
 *  真实 spawn 一次——宽限期内退出（含启动即崩）即不通过，stdout/stderr 尾部随卡回传修复轮；
 *  有 window_title 时走联合判定档（探针：窗口可见/消息循环响应/稳定期/优雅关闭/错误框），
 *  截图落 00_VERIFY/screenshots（delivered 卡自动嵌图）。项目根缺失/异常返回 null 跳过
 *  留痕（冒烟门不做可用性单点）。 */
async function defaultLaunchSmokeGate(projectId: string): Promise<LaunchSmokeResult | null> {
  try {
    const project = findProject(projectId)
    if (!project?.root_path) return null
    return await runLaunchSmoke(project.root_path)
  } catch (error) {
    console.error('[desktop-quick] 启动冒烟执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}
import { classifyUserDesktopIntent } from './user-intent-lexicon'
import {
  confirmMvpDelivered,
  consumeMvpPendingForRework,
  holdForMvpConfirm,
  isMvpConfirmPending,
  isMvpEvidenceCurrent,
  isMvpFeedbackMessage,
  resolveMvpConfirmAnswer,
} from './mvp-confirm'
import { attachActiveCorrectionFeedback, startCorrectionSession, finishCorrectionSession, hasActiveCorrectionSession } from './correction-session'
import { buildCheckpointConclusion } from './phase-checkpoint'
import { verificationFingerprint } from './verification-fingerprint'
import { ensureCoreDelivery, resetCoreDeliveryState, clearCoreDeliveryRetries } from './core-delivery'
import { readProjectAttempts, consumeProjectAttempt, resetProjectAttemptScope } from '../platform/execution/project-attempts'
import type { CoreVerificationResult } from './core-verification'
import { createChannelFailureTracker, observeChannelFailure, type ChannelFailureTracker } from './channel-failure-watch'
import { readDesktopRequirementsDigest, readDesktopShapeBriefs } from './requirement-digest'
import { readProductionDigest } from './production-context'
import { runQuickProductionReview, ensureQuickProductionReview } from './quick-production-review'
import { runSecurityScan } from '../verification/security-scan'

// =========================================================================
// 桌面线判定
// =========================================================================

/** 项目记录的最小判定面（Project 子集——测试可不落盘构造）。 */
export interface DesktopLineProjectLike {
  template_type: string
  desktop_phase?: string
}

/** 桌面线接纳的品类（2026-10-05 拍板：game 直进桌面线）：desktop_tool 主力品类 +
 *  game（游戏词族判型保留——prd-engine 的 GDD 注入依赖 game 类型；游戏天然是
 *  Windows 桌面产物，不再发「网页生成线已下线」形态卡绕一跳。形态卡只留给
 *  web_fullstack/ai_app 这类真 web 品类）。 */
export const DESKTOP_LINE_TEMPLATE_TYPES: ReadonlySet<string> = new Set(['desktop_tool', 'game'])

/** 桌面线是否接管该项目的消息路由（开关 + 品类 + 已进入桌面阶段）。 */
export function isDesktopLineActive(project: DesktopLineProjectLike | undefined): boolean {
  if (!isDesktopDispatchEnabled()) return false
  if (!project || !DESKTOP_LINE_TEMPLATE_TYPES.has(project.template_type)) return false
  const phase = project.desktop_phase
  return typeof phase === 'string' && getDesktopPhase(phase) !== undefined
}

/** 改道判定（PRD 确认点用）：开关 + 品类即改道（desktop_phase 未设也进——正在进入）。 */
export function shouldEnterDesktopLine(project: DesktopLineProjectLike | undefined): boolean {
  return isDesktopDispatchEnabled() && DESKTOP_LINE_TEMPLATE_TYPES.has(project?.template_type ?? '')
}

// =========================================================================
// 路由依赖注入（orchestration 层适配）
// =========================================================================

/** 路由层外部效应面（测试全桩化；生产由 agent-dispatch 注入）。 */
export interface DesktopRouteDeps {
  coreVerification?: (projectId: string) => Promise<CoreVerificationResult>
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
  /** 快速通道安全门注入（2026-10-03）：quick 直落 delivered 前的宿主安全扫描；
   *  缺省生产实现见 defaultQuickSecurityGate（无项目上下文返回 null 跳过留痕）。 */
  securityScan?: (projectId: string) => QuickSecurityGateResult | null
  /** 启动冒烟门注入（2026-10-04 呈现层收口）：quick 直落 delivered 前真实启动一次；
   *  缺省生产实现见 defaultLaunchSmokeGate（无项目上下文返回 null 跳过留痕）。 */
  launchSmoke?: (projectId: string) => Promise<LaunchSmokeResult | null>
}

// =========================================================================
// 账本（项目级内存态；进程重启丢失可接受——拒收计数是短期防环状态）
// =========================================================================

const ledgers = new Map<string, RejectionLedger>()

/** 刀5：项目级渠道故障侦测器（与拒收账本同生命周期——进程内状态）。 */
const channelTrackers = new Map<string, ChannelFailureTracker>()

function channelTrackerOf(projectId: string): ChannelFailureTracker {
  let tracker = channelTrackers.get(projectId)
  if (!tracker) {
    tracker = createChannelFailureTracker()
    channelTrackers.set(projectId, tracker)
  }
  return tracker
}

function ledgerOf(projectId: string): RejectionLedger {
  let ledger = ledgers.get(projectId)
  if (!ledger) {
    ledger = createRejectionLedger()
    const counts = readProjectAttempts(projectId).active
    for (const [scope, count] of Object.entries(counts)) if (scope.startsWith('stage:')) ledger.counts[scope.slice(6)] = count
    ledgers.set(projectId, ledger)
  }
  return ledger
}

/** 测试隔离：清空账本。 */
export function resetDesktopRouteLedgersForTests(): void {
  for (const [id, ledger] of ledgers) for (const phase of Object.keys(ledger.counts)) resetProjectAttemptScope(id, `stage:${phase}`)
  resetCoreDeliveryState()
  ledgers.clear()
  channelTrackers.clear()
}

/** 快速通道安全门结果（与 dispatcher-loop 宿主安全门同构：pass/blocking/scanned/listing）。 */
export interface QuickSecurityGateResult {
  passed: boolean
  blocking: number
  scanned: number
  listing: string
}

/** 快速通道安全门生产实现：对产物根跑静态扫描（高危/严重 fail-closed）；
 *  扫描器异常或无项目上下文返回 null（跳过留痕——安全门不做可用性单点，与
 *  dispatcher-loop runHostSecurityGate 同哲学）。 */
function defaultQuickSecurityGate(projectId: string): QuickSecurityGateResult | null {
  let rootPath: string | undefined
  try {
    rootPath = findProject(projectId).root_path
  } catch {
    return null
  }
  try {
    const result = runSecurityScan({ project_id: projectId, root_path: rootPath })
    const blocking = result.issues.filter((issue) => issue.severity === 'high' || issue.severity === 'critical')
    return {
      passed: result.passed,
      blocking: blocking.length,
      scanned: result.scanned_files,
      listing: blocking.slice(0, 10).map((issue) => `- ${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n'),
    }
  } catch (error) {
    console.error('[desktop-quick] 快速通道安全扫描执行失败（跳过本次门禁，留痕）：', error)
    return null
  }
}

// =========================================================================
// PRD 确认改道
// =========================================================================

/**
 * 进入桌面线（PRD 确认后改道）：置 desktop_phase=desktop-arch 并跑首个阶段。
 * 返回 true=已改道（调用方不再走 runSketchTask）；false=不该改道（调用方走原路径）。
 */
export async function enterDesktopLine(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal; images?: import('../../shared/types').PastedImageRef[]; initialMessagePersisted?: boolean },
  query: SDKQuery,
  env: Record<string, string>,
  deps: DesktopRouteDeps,
): Promise<boolean> {
  const project = findProject(input.projectId)
  if (!shouldEnterDesktopLine(project)) return false
  if (input.signal?.aborted) return true
  try { readConfirmedUxBinding(input.projectId, readPrdBackplane(input.projectId)) }
  catch (error) {
    deps.publish(input, 'message_delta', { text: `当前设计不能开工：${error instanceof Error ? error.message : String(error)}。请重新确认需求和设计。` })
    return true
  }
  const projectName = project?.name ?? input.projectId
  // 快速型直通道（2026-10-03）：quick 跳过 arch/scaffold，直接从 implement 快速版
  // 任务书起跑（从零做出可用应用）；长期型从 desktop-arch 完整工程链开始。
  const isQuick = project?.mode === 'quick'
  const startPhase = isQuick ? 'desktop-implement' : 'desktop-arch'
  updateProject(input.projectId, { desktop_phase: startPhase })
  deps.publish(input, 'stage_changed', { stage: startPhase })
  deps.publish(input, 'message_delta', { text: isQuick
    ? 'PRD 已确认。本项目为桌面品类（快速模式）：跳过选型与工程骨架，直接进入快速实现——从零做出一个可运行的桌面应用。'
    : `PRD 已确认。本项目为桌面品类，切换到桌面调度员线：从「桌面选型与架构」阶段开始（web 草图流程跳过）。` })
  await runDesktopStage(input, query, env, startPhase, deps, projectName, 0)
  return true
}

// =========================================================================
// 消息路由主入口（agent-dispatch 分流调用）
// =========================================================================

/** 路由输入面（orchestration 层从 AgentSendMessageInput 抽取）。 */
export interface DesktopRouteInput {
  images?: import('../../shared/types').PastedImageRef[]
  initialMessagePersisted?: boolean
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
  if (!input.cardOptionId) clearCoreDeliveryRetries(input.projectId)
  const project = findProject(input.projectId)
  const projectName = project?.name ?? input.projectId
  const phaseId = project?.desktop_phase ?? 'desktop-arch'

  // ── 旧确认卡回传（刀1 兼容）：确认卡已不再发出，点击旧卡如实告知并照常推进
  //（脑测修复 5，2026-10-03：旧卡也是人工出场——同步清 blocked 残留）──
  if (input.cardOptionId && input.cardOptionId.startsWith(DESKTOP_CONFIRM_OPTION_PREFIX)) {
    if (project?.desktop_blocked) updateProject(input.projectId, { desktop_blocked: undefined })
    deps.publish(input, 'message_delta', {
      text: '确认协议已升级：中间阶段不再需要人工确认，门禁全绿自动推进。已按当前阶段继续处理你的消息。',
    })
    await runDesktopStage({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: input.content, signal: input.signal, images: input.images, initialMessagePersisted: input.initialMessagePersisted }, input.query, input.env, phaseId, deps, projectName, 0)
    return
  }
  // ── MVP 确认门回传/反馈（2026-10-04 确认门新规）：longterm 交付前过目的最后一道门。
  // 确认 → 交付收口；「有要修改的」→ 提示具体意见（pending 保留，下一条普通消息回炉）；
  // 挂起期间任意普通非停止消息＝修改意见直接回炉 implement（【交付前迭代】，与
  // delivered 反馈同机制，改完重走 verify 再过本门）。──
  const mvpAnswer = resolveMvpConfirmAnswer(input)
  if (mvpAnswer === 'confirm') {
    if (!isMvpEvidenceCurrent(input.projectId)) {
      deps.publish(input, 'message_delta', { text: '当前版本需要重新验证，我会先检查再交付。' })
      consumeMvpPendingForRework(input)
      updateProject(input.projectId, { desktop_phase: 'desktop-verify' })
      await runDesktopStage(input, input.query, input.env, 'desktop-verify', deps, projectName, 0)
      return
    }
    if (!await ensureCoreDelivery(input, deps, feedback => runDesktopStage({ ...input, content: feedback, initialMessagePersisted: false }, input.query, input.env, 'desktop-implement', deps, projectName, 0, true))) return
    // 收口矩阵补齐（批11 审查修复，2026-10-08）：确认交付时若仍有活跃纠错会话——kill 实例；
    // 有未发送选区则如实告知已丢弃（不静默吞掉用户的点选，也不拦住交付决策）。
    if (hasActiveCorrectionSession(input.projectId)) {
      const finished = finishCorrectionSession({ projectId: input.projectId })
      if (finished.pickCount > 0) {
        deps.publish(input, 'message_delta', {
          text: `注意：修改预览里点选的 ${finished.pickCount} 处标记没有发送，本次未按它们修改，已按当前版本交付。`,
        })
      }
    }
    confirmMvpDelivered({ input, deps })
    recordExperimentBoundary(input.projectId, 'delivered', { via: 'mvp-confirm' })
    return
  }
  if (mvpAnswer === 'adjust') {
    deps.publish(input, 'message_delta', {
      text: '好的，要改哪里？直接说（例如「把倒计时改成进度条」），我改完重新验收，再请你确认交付。',
    })
    deps.complete(input.sessionId, input.projectId)
    return
  }
  // 批11 ②（2026-10-08）：先在程序里点点看——拉起修改预览实例（数据只读快照+页内
  // 点选层）；点选标记落盘 picks.jsonl，用户后续文字反馈/确认时自动并入（下分支）。
  if (mvpAnswer === 'pick') {
    const correctionStart = startCorrectionSession({ projectId: input.projectId })
    void Promise.resolve(correctionStart).then((started) => {
      if (started.ok) {
        deps.publish(input, 'message_delta', {
          text: '修改预览已打开（数据只读，不会动你的真实数据）：在预览窗口里直接点选不满意的地方；点完后回来把要改的直接告诉我，或点上面的「确认，交付」/「有要修改的」做决定。',
        })
      } else {
        deps.publish(input, 'message_delta', {
          text: `修改预览没能打开（${started.error ?? '未知原因'}）——你可以直接打字告诉我要改哪里，或点「确认，交付」。`,
        })
      }
      deps.complete(input.sessionId, input.projectId)
    })
    return
  }
  if (isMvpFeedbackMessage(input, classifyUserDesktopIntent(input.content) === 'stop')) {
    consumeMvpPendingForRework(input)
    // 批11 ②：活跃纠错会话的点选标记自动并入意见（finish=kill 实例+组装反馈单一来源）
    let feedbackContent = input.content
    const correctionAttached = attachActiveCorrectionFeedback(input.projectId, input.content)
    if (correctionAttached) feedbackContent = correctionAttached
    updateProject(input.projectId, { desktop_phase: 'desktop-implement', status: 'active', current_stage: 'iterating' })
    deps.publish(input, 'mvp_review_closed', {})
    deps.publish(input, 'stage_changed', { stage: 'desktop-implement' })
    deps.publish(input, 'message_delta', { text: '收到你的意见，先改再交：从「实现与交付说明」阶段按你的意见修改，改完重新走验收，再请你确认交付。' })
    await runDesktopStage(
      {
        projectId: input.projectId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        content: `【交付前迭代】用户对验收通过产物的修改意见，按此修改实现（其余功能与已验证行为保持不变）：${feedbackContent}`,
        signal: input.signal,
        images: input.images,
        initialMessagePersisted: input.initialMessagePersisted,
      },
      input.query, input.env, 'desktop-implement', deps, projectName, 0,
    )
    return
  }

  // ── delivered 交付后反馈（刀1 通知卡承诺兑现，脑测发现修复 2026-10-03）：
  // 通知卡引导「不满意？直接回复要改的地方」——任何消息按迭代意见回炉 implement
  // 段（复用完整门禁与红绿链），改完重走 verify 再交付。放在意图分流之前：交付后
  // 的「不满意/需要调整」等词是反馈不是叫停。
  if (phaseId === 'delivered') {
    updateProject(input.projectId, { desktop_phase: 'desktop-implement', status: 'active', current_stage: 'iterating' })
    deps.publish(input, 'stage_changed', { stage: 'desktop-implement' })
    deps.publish(input, 'message_delta', { text: '收到你的反馈，进入迭代：从「实现与交付说明」阶段按你的意见修改，改完会重新走驱动验收再交付。' })
    await runDesktopStage(
      {
        projectId: input.projectId,
        sessionId: input.sessionId,
        requestId: input.requestId,
        content: `【交付后迭代】用户对已交付产物的反馈，按此修改实现（其余功能与已验证行为保持不变）：${input.content}`,
        signal: input.signal,
        images: input.images,
        initialMessagePersisted: input.initialMessagePersisted,
      },
      input.query, input.env, 'desktop-implement', deps, projectName, 0,
    )
    return
  }

  // ── 文本意图分流（刀1：用户权力出口——停止词立即暂停流水线）──
  const intent = classifyUserDesktopIntent(input.content)
  if (intent === 'stop') {
    const node = getDesktopPhase(phaseId)
    updateProject(input.projectId, {
      desktop_blocked: { reason: 'user-stop', note: input.content.slice(0, 200), at: new Date().toISOString() },
    })
    // 审计 A-07（2026-10-04）：blocked 置位后发一次 stage_changed（paused 标记）——
    // 渲染端据此回填 currentProjectAtom，阶段条/头部能立即呈现「已暂停」态，
    // 不依赖用户翻聊天记录里的人话卡。
    deps.publish(input, 'stage_changed', { stage: phaseId, paused: true })
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
    resetProjectAttemptScope(input.projectId, `stage:${phaseId}`)
    delete ledgerOf(input.projectId).counts[phaseId]
    updateProject(input.projectId, { desktop_blocked: undefined })
    // 审计 A-07（2026-10-04）：放行同步发 stage_changed——渲染端回填后「已暂停」态立即解除。
    deps.publish(input, 'stage_changed', { stage: phaseId })
    const node = getDesktopPhase(phaseId)
    if (intent === 'continue') {
      deps.publish(input, 'message_delta', { text: `已放行，从「${node?.title ?? phaseId}」阶段继续。` })
    }
    deps.persistSystem(input.sessionId, `[decision] desktop-unblock ${phaseId}（${intent === 'continue' ? '继续词放行' : '人工出场放行'}）`)
  }

  await runDesktopStage({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId, content: input.content, signal: input.signal, images: input.images, initialMessagePersisted: input.initialMessagePersisted }, input.query, input.env, phaseId, deps, projectName, 0)
}

// =========================================================================
// 单阶段执行 + 收口处理
// =========================================================================

/** 一次 run 内自动续跑的阶段数上限（推进链防失控；确认门/拒收会自然断链）。
 *  脑测修复 2（2026-10-03）：3→4——链序 arch(0)→scaffold(1)→implement(2)→verify(3)，
 *  旧值 3 使 implement 推进后必停一次（「发送任意消息继续」），全程人工交互变成
 *  3 次破「PRD 确认 + delivered 验收 ≤2 次」口径；4 允许 verify 段自动起跑，
 *  其推进走终态分支不耗续跑预算，防失控语义不变（拒收/降级仍断链）。 */
export const MAX_AUTO_ADVANCE_CHAIN = 4

async function runDesktopStage(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal; images?: import('../../shared/types').PastedImageRef[]; initialMessagePersisted?: boolean },
  query: SDKQuery,
  env: Record<string, string>,
  phaseId: string,
  deps: DesktopRouteDeps,
  projectName: string,
  chainDepth: number,
  coreRepair = false,
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
    : ['desktop-implement', 'desktop-verify'].includes(phaseId) ? readProductionDigest(input.projectId) : readDesktopRequirementsDigest(input.projectId)
  let uxBinding: ReturnType<typeof readConfirmedUxBinding>
  try { uxBinding = readConfirmedUxBinding(input.projectId, readPrdBackplane(input.projectId)) }
  catch (error) {
    updateProject(input.projectId, { current_stage: 'blocked_for_user_decision' })
    deps.publish(input, 'message_delta', { text: `需求或界面设计版本已变化，本阶段暂停：${error instanceof Error ? error.message : String(error)}` })
    deps.complete(input.sessionId, input.projectId)
    return
  }
  if (phaseId === 'desktop-implement') {
    try {
      if (holdExperimentBeforeImplement(project, input.sessionId, { requirements_digest: requirementsDigest ?? '', ux_html: uxBinding?.html_path, ux_design: uxBinding?.design_path })) {
        deps.persistSystem(input.sessionId, '[experiment] prepared: Implement 尚未开始，等待冻结及隔离恢复。')
        deps.publish(input, 'message_delta', { text: '实验前序准备已完成，已停在 Implement 前。请通过内部实验工具冻结输入并恢复 A/B 分支。' })
        deps.complete(input.sessionId, input.projectId, 'incomplete')
        return
      }
    } catch (error) {
      deps.publish(input, 'message_delta', { text: `实验配置未通过，尚未启动实现：${error instanceof Error ? error.message : String(error)}` })
      deps.complete(input.sessionId, input.projectId, 'incomplete')
      return
    }
  }
  // 批9 工件2：形状任务书段（implement/verify 占位符注入；背板无 shape 时为空——任务书渲染空串）
  const shapeBriefs = readDesktopShapeBriefs(input.projectId)
  // 刀2 checkpoint 消费：当前阶段与存证一致（同阶段重跑——拒收续接/turn 耗尽/预算
  // 断链后的重入）时注入勿重验结论；跨阶段不注入（旧结论不作数）。
  const checkpoint = project?.desktop_checkpoint
  const currentFingerprint = checkpoint ? verificationFingerprint(sandboxRoot, { stage: phaseId, requirements: requirementsDigest ?? '' }) : undefined
  const verifiedConclusion = !coreRepair && checkpoint && currentFingerprint && checkpoint.fingerprint === currentFingerprint && checkpoint.stage === phaseId && checkpoint.verified_gates.length > 0
    ? buildCheckpointConclusion(checkpoint, getNextDesktopPhase(phaseId), currentFingerprint)
    : undefined

  const loopInput: DesktopDispatchRunInput = {
    projectId: input.projectId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    currentPhase: phaseId,
    task: input.content,
    images: input.images,
    initialMessagePersisted: input.initialMessagePersisted,
    query,
    env,
    maxTokens: 640000,
    signal: input.signal ?? new AbortController().signal,
    publish: (type, payload) => {
      // 调度员 loop 的过程事件按原类型直通渲染端（首跑修复：此前误折叠为 message_delta，
      // tool_call/delegation 等事件类型丢失——工具行与协作胶囊的实时显示都依赖真实类型）。
      deps.publish(input, type, payload)
      if (type.startsWith('delegation_') || type === 'usage_summary') {
        const experiment = readExperiment(input.projectId)
        if (experiment?.state === 'running') recordExperiment(experiment, type, { request_id: input.requestId, session_id: input.sessionId,
          ...(typeof payload.delegation_id === 'string' ? { delegation_id: payload.delegation_id } : {}),
          ...(typeof payload.child_session_id === 'string' ? { child_session_id: payload.child_session_id } : {}) })
      }
      // 刀5（2026-10-02）：委派失败归因侦测——同签名连续 2 次 → 渠道故障人话卡
      // （去抖一次；修复后用户回复「继续」走刀1 放行协议）。
      if (type === 'delegation_failed') {
        const failure = payload as { error?: string; channel?: string }
        if (typeof failure.error === 'string' && failure.error.length > 0) {
          const observation = observeChannelFailure(channelTrackerOf(input.projectId), {
            error: failure.error,
            channel: typeof failure.channel === 'string' ? failure.channel : undefined,
          })
          if (observation.notify && observation.card) {
            deps.publish(input, 'message_delta', { text: observation.card })
          }
        }
      }
    },
    projectName,
    requirementsDigest,
    ...(uxBinding?.html_path ? { uxSketchPath: uxBinding.html_path } : {}),
    ...(uxBinding?.design_path ? { uxDesignPath: uxBinding.design_path } : {}),
    ...(shapeBriefs.shapeBrief ? { shapeBrief: shapeBriefs.shapeBrief } : {}),
    ...(shapeBriefs.shapeVerifyBrief ? { shapeVerifyBrief: shapeBriefs.shapeVerifyBrief } : {}),
    ...(verifiedConclusion ? { verifiedConclusion } : {}),
    ...(project?.mode === 'quick' ? { quickMode: true } : {}),
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
  recordExperimentBoundary(input.projectId, 'stage_finished', { phase: phaseId, request_id: input.requestId, status: result.status, advance: result.advance?.decision })
  await settleDesktopStage(input, query, env, result, phaseId, deps, projectName, chainDepth)
}

/**
 * 收口处理（刀1 重设计）：advance → 落 desktop_phase + 清拒收账 + （链预算内）
 * 自动续跑下一阶段；终态（delivered）→ 交付通知卡（通知≠确认，不阻塞不等待）；
 * reject → 拒收闭环（账本+防环+续接）；闭环耗尽 → desktop_blocked + 人话卡
 * （人工是异常处理器不是流水线工位）。
 */
async function settleDesktopStage(
  input: { projectId: string; sessionId: string; requestId: string; content: string; signal?: AbortSignal; images?: import('../../shared/types').PastedImageRef[]; initialMessagePersisted?: boolean },
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
    // 断点落痕（批8 下半狗粮实证）：error 收口只发 UI 人话不落 JSONL，断点归因只能
    // 靠黑盒拼揍（16:53 断点排查 40 分钟）——loop 终态/终止原因/轮数进 [decision] 行，
    // JSONL 可独立还原（turn_limit 的 degenerate_output 尤其关键：渠道 DSML 退化
    // 与真崩溃在人话里无法区分）。
    const termination = (result.loopResult as { termination_detail?: { reason?: string; retries?: number } } | undefined)?.termination_detail
    deps.persistSystem(
      input.sessionId,
      `[decision] desktop-loop-end ${phaseId}（status=${result.status}${termination?.reason ? `, 终止原因=${termination.reason}${termination.retries !== undefined ? `(重试${termination.retries})` : ''}` : ''}）——${why}，阶段未收口`,
    )
    let line = `桌面阶段「${phaseId}」本轮未收口（${why}）。阶段进度未变化，可重新发起。`
    // 刀5 扩展（2026-10-03 e99e6319 事故）：主 loop 的 query 异常（含 EMPTY_MODEL_STREAM
    // 空流）与委派失败共用同签名计数——连续 2 次出渠道故障人话卡；未达阈值的异常也
    // 附错误摘要，渠道故障不再伪装成「没反应」。
    const errorMessage = result.error_message
    if (typeof errorMessage === 'string' && errorMessage.length > 0) {
      const observation = observeChannelFailure(channelTrackerOf(input.projectId), { error: errorMessage })
      if (observation.notify && observation.card) {
        line = observation.card
      } else {
        line += `\n错误摘要：${errorMessage.slice(0, 160)}`
      }
    }
    deps.publish(input, 'message_delta', { text: line })
    deps.complete(input.sessionId, input.projectId, 'incomplete')
    return
  }

  const decision = result.advance

  // ── advance：落阶段 + 清账 + 自动续跑（链预算内；终态/非接管节点不续跑）──
  if (decision.decision === 'advance') {
    const ledger = ledgerOf(input.projectId)
    clearRejectionOnAdvance(ledger, phaseId)
    resetProjectAttemptScope(input.projectId, `stage:${phaseId}`)
    const next = getNextDesktopPhase(phaseId)
    const nextNode = next !== null ? getDesktopPhase(next) : undefined
    if (next === null || nextNode?.dispatcherManaged === false) {
      // 终态（delivered）：终态字段收口 + 交付通知卡（刀1：通知≠确认——不阻塞不等待，
      // 用户回复修改意见走迭代）；不续跑（delivered 是哨兵节点，无任务可跑）
      const finalPhase = next ?? 'delivered'
      // ── MVP 确认门（2026-10-04 确认门新规，修订 10-02 刀1）：longterm 交付前交用户
      // 过目成品（quick 不设，快速直通道不变）；挂起不发通知不置 delivered，确认后收口。──
      if (finalPhase === 'delivered') {
        if (!await ensureCoreDelivery(input, deps, async feedback => {
          updateProject(input.projectId, { desktop_phase: 'desktop-implement' })
          await runDesktopStage({ ...input, content: feedback, initialMessagePersisted: false }, query, env, 'desktop-implement', deps, projectName, chainDepth, true)
        })) return
        const gateProject = findProject(input.projectId)
        if (gateProject?.mode === 'longterm' && !isMvpConfirmPending(input.projectId)) {
          // 交付门堵口（2026-10-06 批1，根因⑥「声明-消费不对称」）：implement 门禁要求
          // 产出 LAUNCH.json，但 longterm 交付链（verify→MVP 门→delivered）此前从不消费它
          // ——正常入口 python app.py 的平台级真实启动验证缺位，只依赖 driver 场景自觉
          // （S15 自写自检≠用户路径，弹幕单冻结 bug 的另一面）。MVP 门挂起前跑同款启动
          // 冒烟（联合判定档），失败停在 verify 出人话卡（判据/stderr 即修复靶子），
          // 与 quick 冒烟语义对齐：两单型交付前都真实启动一次。
          const smoke = await (deps.launchSmoke ? deps.launchSmoke(input.projectId) : defaultLaunchSmokeGate(input.projectId))
          if (!smoke || !smoke.passed) {
            deps.publish(input, 'message_delta', {
              text: buildBlockedNoticeCard({
                phaseTitle: getDesktopPhase(phaseId)?.title ?? phaseId,
                whatHappened: '交付前启动验证未通过——' + (smoke?.detail ?? '检查未执行完成，请补验') + '。程序必须在真实桌面会话中启动、出现可交互窗口并保持运行才算交付。',
                evidence: smoke?.outputExcerpt ?? '（无输出捕获）',
              }),
            })
            deps.persistSystem(input.sessionId, '[decision] desktop-longterm-launch-smoke ' + phaseId + '（未通过，停在 verify 待修复）：' + (smoke?.detail ?? '检查未完成'))
            deps.complete(input.sessionId, input.projectId, 'incomplete')
            return
          }
          holdForMvpConfirm({
            input,
            deps,
            fromPhase: phaseId,
            notice: assembleDeliveredNotice(input.projectId, projectName, phaseId, result),
          })
          recordExperimentBoundary(input.projectId, 'mvp_ready', { phase: phaseId })
          return
        }
      }
      updateProject(input.projectId, { desktop_phase: finalPhase, status: 'completed', current_stage: 'completed' })
      recordDeliveryOutcomeTelemetry(input.projectId, input.sessionId, 'terminal')
      recordExperimentBoundary(input.projectId, 'delivered', { via: 'terminal' })
      deps.publish(input, 'stage_changed', { stage: finalPhase })
      deps.publish(input, 'message_delta', { text: buildDeliveredNoticeCard(assembleDeliveredNotice(input.projectId, projectName, phaseId, result)) })
      deps.persistSystem(input.sessionId, `[decision] desktop-advance ${phaseId} → ${finalPhase}（终态，交付通知卡已发）`)
      deps.complete(input.sessionId, input.projectId)
      return
    }
    // quick以核心、安全、启动门收口，v2实验另有独立V审阅；失败保留产物，不宣布交付。
    if (next === 'desktop-verify') {
      const project = findProject(input.projectId)
      if (project?.mode === 'quick') {
        if (!await ensureCoreDelivery(input, deps, feedback => runDesktopStage({ ...input, content: feedback, initialMessagePersisted: false }, query, env, 'desktop-implement', deps, projectName, chainDepth, true))) return
        const securityGate = deps.securityScan
          ? deps.securityScan(input.projectId)
          : defaultQuickSecurityGate(input.projectId)
        if (!securityGate || !securityGate.passed) {
          deps.publish(input, 'message_delta', {
            text: buildBlockedNoticeCard({
              phaseTitle: getDesktopPhase(phaseId)?.title ?? phaseId,
              whatHappened: securityGate ? `快速交付前的安全扫描未通过（${securityGate.blocking} 个高危/严重问题，扫描 ${securityGate.scanned} 个文件），暂不交付。` : '安全检查未执行完成，程序已保留，请补验。',
              evidence: securityGate?.listing ?? '检查未完成',
            }),
          })
          deps.persistSystem(input.sessionId, `[decision] desktop-quick-security-gate ${phaseId}（${securityGate?.blocking ?? '未验证'}，停在 implement）`)
          deps.complete(input.sessionId, input.projectId, 'incomplete')
          return
        }
        // 启动冒烟门（2026-10-04 呈现层收口）：安全门过了还要真实启动一次——
        // 「程序能跑起来」是 quick 的验收标准；起不来留在 implement 出人话卡（stderr 尾部
        // 即修复靶子），过了才 delivered（截图已落 00_VERIFY/screenshots，通知卡自动嵌图）
        const smoke = await (deps.launchSmoke ? deps.launchSmoke(input.projectId) : defaultLaunchSmokeGate(input.projectId))
        if (!smoke || !smoke.passed) {
          deps.publish(input, 'message_delta', {
            text: buildBlockedNoticeCard({
              phaseTitle: getDesktopPhase(phaseId)?.title ?? phaseId,
              whatHappened: '交付前启动验证未通过——' + (smoke?.detail ?? '检查未执行完成，请补验') + '。程序必须能真实启动并保持运行才算交付。',
              evidence: smoke?.outputExcerpt ?? '（无输出捕获）',
            }),
          })
          deps.persistSystem(input.sessionId, '[decision] desktop-quick-launch-smoke ' + phaseId + '（未通过，停在 implement 待修复）：' + (smoke?.detail ?? '检查未完成'))
          deps.complete(input.sessionId, input.projectId, 'incomplete')
          return
        }
        if (!await ensureQuickProductionReview({ projectId: input.projectId, sessionId: input.sessionId, requestId: input.requestId,
          currentPhase: phaseId, task: input.content, query, env, maxTokens: 640000, signal: input.signal ?? new AbortController().signal,
          publish: (type, payload) => deps.publish(input, type, payload), projectName, sandboxRoot: project.root_path, quickMode: true }, {
          review: runQuickProductionReview,
          repair: feedback => runDesktopStage({ ...input, content: feedback, initialMessagePersisted: false }, query, env, 'desktop-implement', deps, projectName, chainDepth, true),
          publish: text => deps.publish(input, 'message_delta', { text }), stop: () => deps.complete(input.sessionId, input.projectId, 'incomplete'),
        })) return
        updateProject(input.projectId, { desktop_phase: 'delivered', status: 'completed', current_stage: 'completed' })
        recordDeliveryOutcomeTelemetry(input.projectId, input.sessionId, 'quick-direct')
        recordExperimentBoundary(input.projectId, 'delivered', { via: 'quick-direct' })
        deps.publish(input, 'stage_changed', { stage: 'delivered' })
        deps.publish(input, 'message_delta', { text: buildDeliveredNoticeCard(assembleDeliveredNotice(input.projectId, projectName, phaseId, result)) })
        deps.persistSystem(input.sessionId, `[decision] desktop-quick-delivered ${phaseId} → delivered（快速直通道：安全门${securityGate ? '通过' : '无项目上下文跳过'}；启动冒烟${smoke ? smoke.detail : '无项目上下文跳过'}，跳过 verify 工程验收）`)
        deps.complete(input.sessionId, input.projectId)
        return
      }
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
  consumeProjectAttempt(input.projectId, `stage:${phaseId}`)

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
  recordExperimentBoundary(input.projectId, 'gate_exhausted', { phase: phaseId, gate_reason: decision.reason })
  // 审计 A-07（同上）：blocked 置位同步发 stage_changed，渲染端回填后呈现暂停态。
  deps.publish(input, 'stage_changed', { stage: phaseId, paused: true })
  const evidenceHint = extractEvidenceHint(decision)
  deps.publish(input, 'message_delta', {
    text: buildBlockedNoticeCard({
      phaseTitle: node?.title ?? phaseId,
      whatHappened: decision.reason === 'driver-blocked' ? '验证环境未就绪，程序已保留；请先恢复环境后补验。' : `「${node?.title ?? phaseId}」阶段连续 ${action.count} 次未通过门禁（${decision.reason}），自动修复已到上限，流水线暂停。`,
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


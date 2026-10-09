/**
 * UX 草图确认门（2026-10-04 确认门新规，实施稿《Bloma-确认门与呈现层-20261004》）。
 *
 * 拍板矩阵：quick＝PRD+UX 两道；longterm＝PRD+UX+MVP 三道。本模块是 UX 门的主流程：
 * PRD 确认后生成沙箱外观草图 → 挂确认卡（确认开工/有要调整的/稍后再说/你帮我定）；
 * 确认后进桌面线。挂起/回传模式照抄 prd-confirm（per-project 内存 pending + 决策留痕 +
 * card_option 专属选项 id 拦截）；调整走有界轮次（UX_SKETCH_ADJUST_LIMIT，超限按当前
 * 版本开工并如实留痕）。
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, ProjectMode } from '../../shared/types'
import type { SketchRequirement } from '../coding/sketch-engine'
import type { SDKQuery } from '../orchestration/orchestrator'
import { recordDecision } from '../project/decision-log'
import { readPrdBackplane } from '../project/prd-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { enterDesktopLine, DESKTOP_LINE_TEMPLATE_TYPES } from '../desktop/desktop-route'
import { findProject } from '../project/project-service'
import { freezeConfirmedUxSketch, generateUxSketch, stageUxSketch } from './ux-sketch'
import { USER_STOP_KEYWORDS } from '../desktop/user-intent-lexicon'

/** UX 门回门意图词（2026-10-04 真机踩坑修复：「按草图开工」是 dismiss 提示语的原文，
 *  但回门只认 USER_CONTINUE_KEYWORDS（继续/确认……）不含「开工」——用户照提示操作
 *  却落回向导 generate_sketch 旧路重跑整套 PRD。中文 includes / ASCII 词边界间或命中即可。） */
export const UX_RESUME_KEYWORDS: readonly string[] = [
  '按草图开工', '按草图', '草图开工', '草图继续', '开工', '开始桌面', '开始交付', '进入桌面', '交付流程',
]

export function isUxResumeIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return UX_RESUME_KEYWORDS.some((kw) => trimmed.includes(kw))
}

type GuideEventPublisher = (event: AgentEvent) => void

export const UX_SKETCH_ADJUST_LIMIT = 3

export const UX_CONFIRM_OPTION_CONFIRM = 'ux_confirm_go'
export const UX_CONFIRM_OPTION_ADJUST = 'ux_adjust'
export const UX_CONFIRM_OPTION_DISMISS = 'ux_dismiss'
export const UX_CONFIRM_OPTION_DELEGATE = 'ux_delegate'

/** UX 门挂起上下文：与 PRD 卡 pending 同构（续跑桌面线所需全量）。 */
export interface PendingUxConfirm {
  request_id: string
  session_id: string
  project_id: string
  mode: ProjectMode
  channel_id?: string
  query: SDKQuery
  env: Record<string, string>
  publish: GuideEventPublisher
  signal?: AbortSignal
  /** 当前轮次（1 起，每次调整 +1） */
  round: number
  positioning: string
  requirements: SketchRequirement[]
  /** 上一版草图要点（调整轮的修订底稿） */
  sketchSummary?: string
}

const pendingUxConfirms = new Map<string, PendingUxConfirm>()
/** 点了「有要调整的」等反馈文本的中间态（同 pending 上下文 + 轮次）。 */
const pendingUxAdjusts = new Map<string, PendingUxConfirm>()

export function hasPendingUxConfirm(projectId: string): boolean {
  return pendingUxConfirms.has(projectId)
}

function takePendingUxConfirm(projectId: string): PendingUxConfirm | undefined {
  const pending = pendingUxConfirms.get(projectId)
  pendingUxConfirms.delete(projectId)
  return pending
}

function makeUxEvent(pending: Pick<PendingUxConfirm, 'session_id' | 'project_id'>, type: AgentEvent['type'], payload: Record<string, unknown>): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: pending.session_id,
    project_id: pending.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

/**
 * UX 门主流程（PRD 确认后调用）：旁白 → 生成草图（调整轮带反馈）→ 沙箱预览 +
 * ux_sketch_ready → 确认卡挂起。草图生成/沙箱失败如实降级（模板兜底 / 卡改文字版
 * 方案确认），门不挂死、不阻断开工路径。
 */
export async function runUxConfirmGate(pending: PendingUxConfirm, feedback?: string): Promise<void> {
  const publish = pending.publish
  const eventInput = { session_id: pending.session_id, project_id: pending.project_id }
  publish(makeUxEvent(eventInput, 'stage_changed', { stage: 'clarifying' }))
  publish(makeUxEvent(eventInput, 'message_delta', {
    text: feedback
      ? `好的，按你的意见「${feedback.slice(0, 60)}」调整草图，画好后再请你过目（约需一到三分钟）。`
      : 'PRD 已确认。我先把界面外观草图（低保真示意）画出来，在右侧预览给你过目——确认方向后开工（约需一到三分钟）。',
  }))

  let sketchUrl: string | null = null
  let sketchSource = 'llm'
  let sandboxFailure: string | undefined
  try {
    const sketch = await generateUxSketch({
      project_id: pending.project_id,
      session_id: pending.session_id,
      query: pending.query,
      env: pending.env,
      maxTokens: 640000,
      positioning: pending.positioning,
      requirements: pending.requirements,
      previousSummary: pending.sketchSummary,
      feedback,
      signal: pending.signal,
    })
    sketchSource = sketch.source
    const staged = await stageUxSketch({ project_id: pending.project_id, html: sketch.html })
    sketchUrl = staged.preview_url
  } catch (error) {
    console.error('[ux-confirm] 草图生成/沙箱失败（降级文字版方案确认）:', error)
    sandboxFailure = error instanceof Error ? error.message : String(error)
  }

  const round = pending.round
  pendingUxConfirms.set(pending.project_id, { ...pending, round })

  recordDecision({
    project_id: pending.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'ux_sketch_staged',
      title: `UX 外观草图已出（第 ${round} 轮${sketchSource === 'template' ? '，模板兜底' : ''}）`,
      why: 'PRD 确认后、开工前，交用户过目界面方向（确认门矩阵：quick/longterm 均设 UX 门）',
      detail: {
        round,
        sketch_source: sketchSource,
        preview_url: sketchUrl ?? undefined,
        sandbox_ok: sketchUrl !== null,
        ...(sandboxFailure ? { sandbox_failure: sandboxFailure.slice(0, 200) } : {}),
      },
    },
  })

  if (sketchUrl) {
    publish(makeUxEvent(eventInput, 'ux_sketch_ready', { preview_url: sketchUrl, round }))
    publish(makeUxEvent(eventInput, 'message_delta', {
      text: `草图画好了，已在右侧预览展示（第 ${round} 轮${sketchSource === 'template' ? '；网络原因用了简易版' : ''}）。看看界面方向对不对——确认后我就开工。`,
    }))
  } else {
    publish(makeUxEvent(eventInput, 'message_delta', {
      text: '草图预览服务暂时没起来，我用文字版方案替代：按需求清单的布局设想已在下方卡片里，确认后我就开工。',
    }))
  }

  publish(makeUxEvent(eventInput, 'user_decision_required', {
    kind: 'ux_confirm',
    title: '请确认界面草图',
    questions: [
      { id: UX_CONFIRM_OPTION_CONFIRM, label: '确认草图，开工', description: '按这个界面方向开始实现' },
      { id: UX_CONFIRM_OPTION_ADJUST, label: '有要调整的', description: '说说哪里要改，我重新画' },
      { id: UX_CONFIRM_OPTION_DELEGATE, label: '你帮我定', description: '按当前版本直接开工' },
      { id: UX_CONFIRM_OPTION_DISMISS, label: '稍后再说', description: '先不确认，回对话继续' },
    ],
  }))
}

/** 测试隔离：清两个 pending（生产无用）。 */
export function resetUxConfirmForTests(): void {
  pendingUxConfirms.clear()
  pendingUxAdjusts.clear()
}

/** 测试隔离种子（生产无用；批11 ①测试）：直接置挂起态/等反馈态。 */
export function seedUxConfirmForTests(pending: { project_id: string; session_id: string; round: number }): void {
  pendingUxConfirms.set(pending.project_id, {
    request_id: 'r-seed',
    session_id: pending.session_id,
    project_id: pending.project_id,
    mode: 'quick',
    query: {} as never,
    env: {},
    publish: () => undefined,
    signal: undefined,
    round: pending.round,
    positioning: 'seed',
    requirements: [],
  })
}

/** 测试隔离种子（等反馈态）。 */
export function seedUxAdjustWaitForTests(pending: { project_id: string; session_id: string; round: number }): void {
  seedUxConfirmForTests(pending)
  const taken = pendingUxConfirms.get(pending.project_id)
  if (taken) {
    pendingUxConfirms.delete(pending.project_id)
    pendingUxAdjusts.set(pending.project_id, taken)
  }
}

/** 确认卡回传识别：card_option 且选项 id 专属、pending 仍存活时才拦截。 */
export function resolveUxConfirmCardAnswer(input: AgentSendMessageInput): 'confirm' | 'adjust' | 'dismiss' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (
    optionId !== UX_CONFIRM_OPTION_CONFIRM
    && optionId !== UX_CONFIRM_OPTION_ADJUST
    && optionId !== UX_CONFIRM_OPTION_DISMISS
    && optionId !== UX_CONFIRM_OPTION_DELEGATE
  ) {
    return undefined
  }
  if (!hasPendingUxConfirm(input.project_id)) return undefined
  if (optionId === UX_CONFIRM_OPTION_CONFIRM || optionId === UX_CONFIRM_OPTION_DELEGATE) return 'confirm'
  if (optionId === UX_CONFIRM_OPTION_DISMISS) return 'dismiss'
  return 'adjust'
}

/** 用户确认（含让渡）：ack + 清预览 + 进桌面线。 */
export async function resumeUxConfirmConfirmed(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return false
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'ux_confirm',
      title: '用户确认界面草图',
      why: `用户在草图确认卡选择「确认开工」，第 ${pending.round} 轮版本`,
      detail: { round: pending.round },
    },
  })
  pending.publish(makeUxEvent(pending, 'ux_sketch_closed', {}))
  pending.publish(makeUxEvent(pending, 'message_delta', { text: '好，按这个界面方向开工，进入桌面交付流程。' }))
  pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'success' }))
  if (pending.signal?.aborted) return true
  try {
    freezeConfirmedUxSketch(pending.project_id)
  } catch (error) {
    pendingUxConfirms.set(pending.project_id, pending)
    pending.publish(makeUxEvent(pending, 'message_delta', { text: `保存已确认草图失败，尚未开工，请重试确认：${error instanceof Error ? error.message : String(error)}` }))
    return true
  }
  await enterDesktopLineFromPending(pending)
  return true
}

/** 点了「有要调整的」：转入等反馈文本态并提示。 */
export function startUxAdjustAwait(input: AgentSendMessageInput): void {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return
  pendingUxAdjusts.set(input.project_id, pending)
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'ux_confirm',
      title: '用户要求调整草图',
      why: '用户在草图确认卡选择「有要调整的」，等待具体反馈',
      detail: { round: pending.round },
    },
  })
  pending.publish(makeUxEvent(pending, 'message_delta', {
    text: '好的，要调整哪里？直接说（如「按钮太挤」「显示区要更大」「加一列历史记录」），我重新画。想按当前版本开工就说「继续」。',
  }))
  pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'success' }))
}

/** 稍后再说：pending 消费留痕，回对话继续（后续继续词可重发卡，见 republishUxCardFromArchive）。 */
export function consumeUxConfirmDismiss(input: AgentSendMessageInput): void {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'ux_confirm',
      title: '用户暂不确认草图，回对话继续',
      why: '用户在草图确认卡选择「稍后再说」——不开工，草图留在 00_UX 可回看',
    },
  })
  pending.publish(makeUxEvent(pending, 'ux_sketch_closed', {}))
  pending.publish(makeUxEvent(pending, 'message_delta', {
    text: '好的，草图先放着（存在项目 00_UX 目录，随时可回看）。想继续时说「按草图开工」；要改就直接说要改哪里。',
  }))
  pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'success' }))
}

/** 调整反馈识别：等反馈态下，普通消息（非停止词）作为草图修订反馈消费。 */
export function takeUxAdjustFeedback(input: AgentSendMessageInput): { pending: PendingUxConfirm; feedback: string } | undefined {
  if (input.metadata?.source === 'card_option') return undefined
  const pending = pendingUxAdjusts.get(input.project_id)
  if (!pending) return undefined
  const text = input.content.trim()
  if (!text) return undefined
  if (USER_STOP_KEYWORDS.some((word) => text.includes(word))) {
    pendingUxAdjusts.delete(input.project_id)
    return undefined
  }
  pendingUxAdjusts.delete(input.project_id)
  return { pending, feedback: text }
}

/**
 * 草图点选标记（批11 ①，2026-10-08）：UX 门挂起态收到 source=sketch_correction 的
 * 消息＝「点了有要调整的 + 给了意见」一步消化（右栏草图点选层组装的标记清单经
 * AGENT_SEND_MESSAGE 代发）——无需先点卡再打字；等反馈态同样适用（标记优先）。
 * 返回结构同 takeUxAdjustFeedback（复用 runUxAdjustRound 的有界回炉与轮次语义）。
 */
export function takeUxSketchCorrection(input: AgentSendMessageInput): { pending: PendingUxConfirm; feedback: string } | undefined {
  if (input.metadata?.source !== 'sketch_correction') return undefined
  const inAdjustWait = pendingUxAdjusts.has(input.project_id)
  const pending = (inAdjustWait ? pendingUxAdjusts : pendingUxConfirms).get(input.project_id)
  if (!pending) return undefined
  const text = input.content.trim()
  if (!text) return undefined
  if (inAdjustWait) pendingUxAdjusts.delete(input.project_id)
  else pendingUxConfirms.delete(input.project_id)
  return { pending, feedback: text }
}

/**
 * 等反馈态下收到继续词：按当前版本开工（consume + 确认链）。
 * 返回 false 表示不在等反馈态或非继续语义。
 */
export async function tryResumeUxAdjustAsConfirm(input: AgentSendMessageInput, isContinue: boolean): Promise<boolean> {
  if (input.metadata?.source === 'card_option') return false
  const pending = pendingUxAdjusts.get(input.project_id)
  if (!pending || !isContinue) return false
  pendingUxAdjusts.delete(input.project_id)
  pendingUxConfirms.set(input.project_id, pending)
  await resumeUxConfirmConfirmed(input)
  return true
}

/** 调整轮重入：带反馈重画（轮次 +1，超限按当前版本开工并如实留痕）。 */
export async function runUxAdjustRound(input: AgentSendMessageInput, taken: { pending: PendingUxConfirm; feedback: string }): Promise<void> {
  const { pending, feedback } = taken
  const nextRound = pending.round + 1
  if (nextRound > UX_SKETCH_ADJUST_LIMIT) {
    recordDecision({
      project_id: input.project_id,
      session_id: pending.session_id,
      entry: {
        type: 'ux_confirm',
        title: '草图调整轮次熔断，按当前版本开工',
        why: `已按用户意见调整 ${UX_SKETCH_ADJUST_LIMIT} 轮，不再重画——按当前版本开工，后续可在交付后迭代里继续改`,
        detail: { limit: UX_SKETCH_ADJUST_LIMIT, last_feedback: feedback.slice(0, 120) },
      },
    })
    pendingUxConfirms.set(input.project_id, pending)
    await resumeUxConfirmConfirmed(input)
    return
  }
  await runUxConfirmGate({ ...pending, round: nextRound, sketchSummary: pending.sketchSummary }, feedback)
}

/** 「稍后再说」后的回门：继续词语义 + 已确认 PRD + 未进桌面线 → 重发草图卡（归档草图重挂沙箱）。
 *  query/env 由调用方解析传入（guide 派发上下文里现成，不在本模块伪造）。 */
export async function republishUxCardFromArchive(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  context: { query: SDKQuery; env: Record<string, string> },
): Promise<boolean> {
  const project = findProject(input.project_id)
  if (!project || !DESKTOP_LINE_TEMPLATE_TYPES.has(project.template_type)) return false
  if (project.desktop_phase) return false
  const backplane = readPrdBackplane(input.project_id)
  if (!backplane?.user_confirmed_at) return false
  if (hasPendingUxConfirm(input.project_id) || pendingUxAdjusts.has(input.project_id)) return false
  await runUxConfirmGate({
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: project.mode ?? 'quick',
    channel_id: input.channel_id,
    query: context.query,
    env: context.env,
    publish,
    round: 1,
    positioning: backplane.positioning ?? '',
    requirements: backplane.requirements as SketchRequirement[],
  })
  return true
}

/** 进桌面线（与 prd-confirm 原桌面分支同款装配；UX 门成为唯一入口后此处收口）。 */
async function enterDesktopLineFromPending(pending: PendingUxConfirm): Promise<void> {
  await enterDesktopLine(
    { projectId: pending.project_id, sessionId: pending.session_id, requestId: pending.request_id, content: '开始桌面交付流程' },
    pending.query,
    pending.env,
    {
      publish: (_target, type, payload) => pending.publish(makeUxEvent(pending, type, payload)),
      persistAssistant: () => undefined,
      persistSystem: (sessionId, text) => appendSessionMessage(sessionId, { role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() }),
      complete: () => undefined,
    },
  )
}

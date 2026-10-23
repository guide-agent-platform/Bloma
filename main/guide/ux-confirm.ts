import { prepareGuiAcceptance } from '../desktop/gui-acceptance-preparation'
import { ConfirmationMap, loadGuideConfirmationForResume, archiveGuideConfirmation, clearGuideConfirmationFilesForTests } from './confirmation-journal'
/**
 * UX 草图确认门（2026-10-04 确认门新规，实施稿《Bloma-确认门与呈现层-20261004》）。
 *
 * 拍板矩阵：quick＝PRD+UX 两道；longterm＝PRD+UX+MVP 三道。本模块是 UX 门的主流程：
 * PRD 确认后生成沙箱外观草图 → 挂确认卡（确认开工/有要调整的/稍后再说/你帮我定）；
 * 确认后进桌面线。挂起/回传模式照抄 prd-confirm（per-project 内存 pending + 决策留痕 +
 * card_option 专属选项 id 拦截）；调整走有界轮次，超限等待明确选择，不代替用户确认。
 */
import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, ProjectMode } from '../../shared/types'
import type { SketchRequirement } from "../model/prd-backplane";
import type { SDKQuery } from '../orchestration/orchestrator'
import { recordDecision } from '../project/decision-log'
import { readPrdBackplane } from '../project/prd-store'
import { appendSessionMessage } from '../platform/sessions/session-tree'
import { enterDesktopLine, DESKTOP_LINE_TEMPLATE_TYPES } from '../desktop/desktop-route'
import { findProject, updateProject } from '../project/project-service'
import { freezeConfirmedUxSketch, freezeLeanUxSketch, stageUxSketch, type UxSketchGeneration } from './ux-sketch'
import { classifyUserDesktopIntent } from '../desktop/user-intent-lexicon'
import type { PrdBackplane } from '../model/prd-backplane'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { prdStructureIssues } from '../model/requirements-model'
import { FALLBACK_UX_SUMMARY, renderUxDesignSummary, uxDesignFingerprint, type UxDesign } from '../model/ux-design'
import { resolveChannelEnv } from '../platform/llm/runtime-fallback'
import { resolveGenerationMaxTokens } from '../platform/llm/model-resolution'
import { generateUxVisualDesign, type UxVisualEvidence, type UxVisualResult } from './ux-visual-pipeline'

/** UX 门回门意图词（2026-10-04 真机踩坑修复：「按草图开工」是 dismiss 提示语的原文，
 *  但回门只认 USER_CONTINUE_KEYWORDS（继续/确认……）不含「开工」——用户照提示操作
 *  却落回向导 generate_sketch 旧路重跑整套 PRD。中文 includes / ASCII 词边界间或命中即可。） */
export const UX_RESUME_KEYWORDS: readonly string[] = [
  '按草图开工', '按草图', '草图开工', '草图继续', '开工', '开始桌面', '开始交付', '进入桌面', '交付流程',
]

export function isUxResumeIntent(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return !isNegativeUxIntent(trimmed) && UX_RESUME_KEYWORDS.some((kw) => trimmed.includes(kw))
}

function isNegativeUxIntent(text: string): boolean {
  const instruction = text.replace(/不需要调整|(?:不用|无需|不必)(?:再)?(?:改|调整|重做)/g, '')
  return classifyUserDesktopIntent(instruction) === 'stop' || /(?:不要|不许|不想|不能|暂不|先不|别|勿|不)[^。！？!?]{0,16}(?:开工|确认|继续|开始|交付|推进|草图)|继续(?:改|调整)|再(?:改|调整|画)/.test(instruction)
}

type GuideEventPublisher = (event: AgentEvent) => void

export const UX_SKETCH_ADJUST_LIMIT = 3

export const UX_CONFIRM_OPTION_CONFIRM = 'ux_confirm_go'
export const UX_CONFIRM_OPTION_ADJUST = 'ux_adjust'
export const UX_CONFIRM_OPTION_DISMISS = 'ux_dismiss'
export const UX_CONFIRM_OPTION_DELEGATE = 'ux_delegate'
export const UX_CONFIRM_OPTION_RETRY = 'ux_retry'

/** UX 门挂起上下文：与 PRD 卡 pending 同构（续跑桌面线所需全量）。 */
export interface PendingUxConfirm {
  confirmationId?: string
  backplane?: PrdBackplane
  prdFingerprint?: string
  design?: UxDesign
  sketchHtml?: string
  sketchHash?: string
  adjustmentLimit?: number
  limitReached?: boolean
  unappliedFeedback?: string
  generationFailed?: boolean
  previewFailed?: boolean
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

const serializeUx = (value: PendingUxConfirm): Record<string, unknown> => {
  const { query, env, publish, signal, confirmationId, ...data } = value
  return data
}
const pendingUxConfirms = new ConfirmationMap<PendingUxConfirm>('ux', 'pending', value => value.prdFingerprint, serializeUx)
/** 点了「有要调整的」等反馈文本的中间态（同 pending 上下文 + 轮次）。 */
const pendingUxAdjusts = new ConfirmationMap<PendingUxConfirm>('ux', 'adjust', value => value.prdFingerprint, serializeUx)

export function hasPendingUxConfirm(projectId: string): boolean {
  return pendingUxConfirms.has(projectId)
}

function takePendingUxConfirm(projectId: string): PendingUxConfirm | undefined {
  const pending = pendingUxConfirms.get(projectId)
  pendingUxConfirms.delete(projectId)
  return pending
}

export function restoreUxConfirmation(input: AgentSendMessageInput, publish: GuideEventPublisher, context: { query: SDKQuery; env: Record<string, string>; signal?: AbortSignal }): boolean {
  let pending = pendingUxConfirms.get(input.project_id) ?? pendingUxAdjusts.get(input.project_id)
  let adjusting = pendingUxAdjusts.has(input.project_id)
  let saved: ReturnType<typeof loadGuideConfirmationForResume>
  try { saved = loadGuideConfirmationForResume('ux', input.project_id) }
  catch (error) { pendingUxConfirms.forget(input.project_id); pendingUxAdjusts.forget(input.project_id); throw error }
  if (!pending) {
    if (!saved) return false
    if (saved.session_id !== input.session_id) throw new Error('UX_CONFIRMATION_SESSION_CHANGED')
    const project = findProject(input.project_id)
    if (project.desktop_phase) return false
    const current = readPrdBackplane(input.project_id)
    if (!current.user_confirmed_at || saved.scope_hash !== prdScopeFingerprint(current)) {
      archiveGuideConfirmation('ux', input.project_id)
      throw new Error('UX_CONFIRMATION_SCOPE_CHANGED_ARCHIVED')
    }
    const data = saved.data as unknown as PendingUxConfirm
    if ((!data.design && !current.lean_brief && data.generationFailed !== true) || data.generationFailed !== undefined && typeof data.generationFailed !== 'boolean'
      || data.previewFailed !== undefined && typeof data.previewFailed !== 'boolean'
      || data.project_id !== input.project_id || data.session_id !== input.session_id || !Number.isSafeInteger(data.round) || data.round < 1
      || data.prdFingerprint !== saved.scope_hash || data.sketchHtml !== undefined && typeof data.sketchHtml !== 'string'
      || data.sketchHash !== undefined && !/^[a-f0-9]{64}$/.test(data.sketchHash)) throw new Error('UX_CONFIRMATION_INVALID')
    pending = { ...data, confirmationId: saved.id, ...context, publish }
    adjusting = saved.state === 'adjust' || saved.state === 'working' && Boolean(data.unappliedFeedback)
  }
  if (pending.session_id !== input.session_id) throw new Error('UX_CONFIRMATION_SESSION_CHANGED')
  ;(adjusting ? pendingUxAdjusts : pendingUxConfirms).bind(input.project_id, { ...pending, ...context, publish, request_id: input.request_id, channel_id: input.channel_id ?? pending.channel_id })
  return true
}
export function replayUxConfirmation(projectId: string): void {
  const pending = pendingUxConfirms.get(projectId)
  if (pending) publishUxCard(pending)
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
 * ux_sketch_ready → 确认卡挂起。生成或预览失败保留需求与意见，允许明确重试，
 * 不能以需求列表或文字替代用户要确认的界面。
 */
export async function runUxConfirmGate(pending: PendingUxConfirm, feedback?: string, retryPreview = false): Promise<void> {
  if (pending.signal?.aborted) return
  if (feedback && pending.unappliedFeedback && feedback !== pending.unappliedFeedback) feedback = /^(?:重试|再试一次|再试)$/.test(feedback.trim())
    ? pending.unappliedFeedback : `${pending.unappliedFeedback}\n补充意见：${feedback}`
  const current = readPrdBackplane(pending.project_id)
  if (!current.user_confirmed_at || prdStructureIssues(current).length) {
    pending.publish(makeUxEvent(pending, 'message_delta', { text: '需求尚未确认或存在结构问题，请先完成 PRD 确认，再整理界面设计。' }))
    pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'error' }))
    return
  }
  if (pending.prdFingerprint && pending.prdFingerprint !== prdScopeFingerprint(current)) {
    pending.publish(makeUxEvent(pending, 'message_delta', { text: '需求已变化，旧草图不能继续确认；请先确认新版 PRD，再生成对应设计。' }))
    return
  }
  const resolution = resolveChannelEnv({ channelId: pending.channel_id, category: 'sketch',
    projectId: pending.project_id, sessionId: pending.session_id })
  pending = { ...pending, env: resolution.env ?? pending.env, backplane: current, positioning: current.positioning, requirements: current.requirements,
    prdFingerprint: prdScopeFingerprint(current) }
  const revisionBase = pending
  const publish = pending.publish
  const eventInput = { session_id: pending.session_id, project_id: pending.project_id }
  publish(makeUxEvent(eventInput, 'stage_changed', { stage: 'clarifying' }))
  publish(makeUxEvent(eventInput, 'message_delta', {
    text: feedback
      ? `好的，按你的意见「${feedback.slice(0, 60)}」调整草图，画好后再请你过目（约需一到三分钟）。`
      : 'PRD 已确认。我先设计界面外观，在右侧展示静态预览，供你确认视觉与布局；实际操作会在桌面程序中实现（约需一到三分钟）。',
  }))

  let sketchUrl: string | null = null
  let reviewUrl: string | undefined
  let sketchSource = 'llm'
  let generation: UxSketchGeneration | undefined
  let visual: UxVisualEvidence | undefined
  try {
    const sketch: UxVisualResult = retryPreview && pending.previewFailed && pending.sketchHtml && (pending.design || current.lean_brief)
      ? { html: pending.sketchHtml, design: pending.design, source: 'llm' as const, generation: undefined, visual: undefined }
      : await generateUxVisualDesign({
      project_id: pending.project_id,
      session_id: pending.session_id,
      query: pending.query,
      env: pending.env,
      maxTokens: resolveGenerationMaxTokens(resolution.channel ?? {}),
      backplane: current,
      positioning: pending.positioning,
      requirements: pending.requirements,
      previousSummary: pending.sketchSummary,
      previousDesign: pending.design,
      previousHtml: pending.sketchHtml,
      feedback,
      signal: pending.signal,
      progress: text => { if (!pending.signal?.aborted) publish(makeUxEvent(eventInput, 'message_delta', { text: text + '\n' })) },
    })
    if (pending.signal?.aborted) return
    const latest = readPrdBackplane(pending.project_id)
    if (!latest.user_confirmed_at || prdScopeFingerprint(latest) !== pending.prdFingerprint) {
      pending.publish(makeUxEvent(pending, 'message_delta', { text: '设计生成期间需求已变化，本次结果没有进入确认。请先确认当前 PRD，再重新生成设计。' }))
      return
    }
    if (sketch.requires_prd_revision) {
      await returnToPrd(pending, feedback ?? sketch.requires_prd_revision)
      return
    }
    if (sketch.source !== 'llm' || !sketch.design && !current.lean_brief) throw new Error('UX_DESIGN_FAILED: 未生成完整界面设计，不能用需求清单代替草图')
    const design = sketch.design
    pending = { ...pending, design, sketchHtml: sketch.html, sketchSummary: design ? renderUxDesignSummary(design) : current.positioning,
      unappliedFeedback: undefined, generationFailed: false, previewFailed: false }
    sketchSource = sketch.source
    generation = sketch.generation
    visual = sketch.visual
    if (sketch.source === 'llm' && visual?.reasons.length) {
      publish(makeUxEvent(eventInput, 'message_delta', { text: '已保留当前设计；部分候选或自动视觉评审未完成，你仍可以查看当前稿并提出调整。\n' }))
    }
    const staged = await stageUxSketch({ project_id: pending.project_id, html: sketch.html, design, signal: pending.signal })
    if (pending.signal?.aborted) return
    pending.sketchHash = staged.html_hash
    sketchUrl = staged.preview_url
    reviewUrl = staged.review_url
  } catch (error) {
    if (pending.signal?.aborted) return
    console.error('[ux-confirm] 草图生成/预览失败，未进入设计确认:', error)
    const retainedDraft = (pending.design || current.lean_brief) && pending.sketchHtml && pending.generationFailed === false ? pending : revisionBase
    pending = { ...retainedDraft, sketchHash: undefined, generationFailed: true, previewFailed: retainedDraft !== revisionBase,
      ...(feedback ? { unappliedFeedback: feedback } : {}) }
    publish(makeUxEvent(pending, 'ux_sketch_closed', {}))
    publish(makeUxEvent(pending, 'message_delta', { text: feedback
      ? '这次调整未完成，已保留上一版和你的意见；本次不会开工，可重试调整。'
      : '这次界面草图生成或预览失败，已保留确认的需求；尚未开工。可以重新生成草图，或稍后再试。' }))
    recordDecision({ project_id: pending.project_id, session_id: pending.session_id, entry: { type: 'ux_sketch_failed',
      title: '界面草图未就绪，等待明确重试', why: error instanceof Error ? error.message : String(error), detail: { round: pending.round } } })
    pendingUxConfirms.set(pending.project_id, pending)
    publishUxCard(pending)
    publish(makeUxEvent(pending, 'message_completed', { subtype: 'incomplete' }))
    return
  }

  if (pending.signal?.aborted) return

  const round = pending.round
  pendingUxConfirms.set(pending.project_id, { ...pending, round })

  recordDecision({
    project_id: pending.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'ux_sketch_staged',
      title: `UX 外观草图已出（第 ${round} 轮）`,
      why: 'PRD 确认后、开工前，交用户过目界面方向（确认门矩阵：quick/longterm 均设 UX 门）',
      detail: {
        round,
        sketch_source: sketchSource,
        ...(generation ? { generation } : {}),
        ...(visual ? { visual } : {}),
        preview_url: sketchUrl ?? undefined,
        sandbox_ok: sketchUrl !== null,
      },
    },
  })

  if (sketchUrl) {
    publish(makeUxEvent(eventInput, 'ux_sketch_ready', { preview_url: sketchUrl, ...(reviewUrl ? { review_url: reviewUrl } : {}), round }))
    publish(makeUxEvent(eventInput, 'message_delta', {
      text: `草图画好了，已在右侧预览展示（第 ${round} 轮）。看看界面方向对不对——确认后我就开工。`,
    }))
  }

  publishUxCard(pending)
}

function publishUxCard(pending: PendingUxConfirm): void {
  const ready = confirmableSketch(pending)
  updateProject(pending.project_id, { current_stage: 'blocked_for_user_decision' })
  pending.publish(makeUxEvent(pending, 'stage_changed', { stage: 'blocked_for_user_decision' }))
  pending.publish(makeUxEvent(pending, 'user_decision_required', {
    kind: 'ux_confirm',
    title: !ready ? '草图尚未就绪，请选择下一步' : pending.unappliedFeedback ? '当前设计仍有未处理意见，请选择下一步' : '请确认界面草图',
    summary: ready ? pending.sketchSummary ?? '' : '已保留确认的需求和已有意见，尚未开始实现。',
    questions: [
      ...(ready ? [{ id: UX_CONFIRM_OPTION_CONFIRM, label: '确认草图，开工', description: '按这个界面方向开始实现' }]
        : [{ id: UX_CONFIRM_OPTION_RETRY, label: '重新生成草图', description: '沿用已确认需求和修改意见重试' }]),
      { id: UX_CONFIRM_OPTION_ADJUST, label: pending.limitReached ? '再调整一次' : '有要调整的', description: '说说哪里要改，我重新画' },
      ...(ready ? [{ id: UX_CONFIRM_OPTION_DELEGATE, label: '你帮我定', description: '按当前版本直接开工' }] : []),
      { id: UX_CONFIRM_OPTION_DISMISS, label: '稍后再说', description: '先不确认，回对话继续' },
    ],
  }))
}

function confirmableSketch(pending: PendingUxConfirm): boolean {
  return !pending.generationFailed && !pending.unappliedFeedback && Boolean(pending.sketchHash && (pending.design || pending.backplane?.lean_brief))
    // Historical requirements-list templates did not persist a source flag.
    && pending.design?.summary !== FALLBACK_UX_SUMMARY
}

export async function retryUxSketch(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return false
  await runUxConfirmGate({ ...pending, request_id: input.request_id }, pending.unappliedFeedback, true)
  return true
}

/** 测试隔离：清两个 pending（生产无用）。 */
export function resetUxConfirmForTests(): void {
  pendingUxConfirms.clear()
  pendingUxAdjusts.clear()
  clearGuideConfirmationFilesForTests('ux')
}
export function clearUxConfirmationMemoryForTests(): void { pendingUxConfirms.clear(); pendingUxAdjusts.clear() }
export function isUxAdjustAwait(projectId: string): boolean { return pendingUxAdjusts.has(projectId) }

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
export function resolveUxConfirmCardAnswer(input: AgentSendMessageInput): 'confirm' | 'adjust' | 'dismiss' | 'retry' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (
    optionId !== UX_CONFIRM_OPTION_CONFIRM
    && optionId !== UX_CONFIRM_OPTION_ADJUST
    && optionId !== UX_CONFIRM_OPTION_DISMISS
    && optionId !== UX_CONFIRM_OPTION_DELEGATE
    && optionId !== UX_CONFIRM_OPTION_RETRY
  ) {
    return undefined
  }
  if (!hasPendingUxConfirm(input.project_id)) return undefined
  if (optionId === UX_CONFIRM_OPTION_RETRY) return 'retry'
  if (optionId === UX_CONFIRM_OPTION_CONFIRM || optionId === UX_CONFIRM_OPTION_DELEGATE) return 'confirm'
  if (optionId === UX_CONFIRM_OPTION_DISMISS) return 'dismiss'
  return 'adjust'
}

/** 用户确认（含让渡）：ack + 清预览 + 进桌面线。 */
export async function resumeUxConfirmConfirmed(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return false
  if (pending.signal?.aborted) return true
  if (isNegativeUxIntent(input.content ?? '')) { pendingUxConfirms.set(input.project_id, pending); return true }
  try {
    const current = readPrdBackplane(input.project_id)
    if (!current.user_confirmed_at || prdStructureIssues(current).length || pending.prdFingerprint !== prdScopeFingerprint(current)) throw new Error('UX_PRD_VERSION_CHANGED: 当前需求尚未确认或版本已变化，请重新生成设计')
    if (!confirmableSketch(pending)) throw new Error('UX_SKETCH_NOT_READY: 没有可确认的完整界面草图，请重新生成')
    if (pending.sketchHash && current.lean_brief) freezeLeanUxSketch(pending.project_id, { prd: current, html_hash: pending.sketchHash })
    else if (pending.sketchHash && pending.design) freezeConfirmedUxSketch(pending.project_id, { prd: current, design: pending.design, html_hash: pending.sketchHash })
    else throw new Error('UX_DESIGN_MISSING')
    updateProject(input.project_id, { ux_confirmation: { prd_fingerprint: prdScopeFingerprint(current),
      design_hash: current.lean_brief ? pending.sketchHash! : uxDesignFingerprint(pending.design!), html_hash: pending.sketchHash ?? null } })
  } catch (error) {
    pendingUxConfirms.set(pending.project_id, pending)
    pending.publish(makeUxEvent(pending, 'message_delta', { text: `保存已确认草图失败，尚未开工，请重试确认：${error instanceof Error ? error.message : String(error)}` }))
    publishUxCard(pending)
    pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'incomplete' }))
    return true
  }
  if (pending.signal?.aborted) return true
  if (!await prepareGuiAcceptance({ projectId: pending.project_id, sessionId: pending.session_id, query: pending.query, env: pending.env, signal: pending.signal })) {
    pendingUxConfirms.set(input.project_id, pending)
    pending.publish(makeUxEvent(pending, 'message_delta', { text: '当前界面方向已保存，独立业务验收规则尚未准备完整，本次未启动实现。可重试确认，或由宿主补齐验收规则。' }))
    pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'incomplete' }))
    return true
  }
  pendingUxConfirms.save(pending, 'consumed')
  pending.publish(makeUxEvent(pending, 'ux_sketch_closed', {}))
  recordDecision({ project_id: input.project_id, session_id: pending.session_id, entry: { type: 'ux_confirm', title: '用户确认当前界面设计', why: '需求版本与设计版本核对通过，确认记录已保存', detail: { round: pending.round, prd_fingerprint: pending.prdFingerprint, html_hash: pending.sketchHash ?? null } } })
  pending.publish(makeUxEvent(pending, 'message_delta', { text: '好，按这个界面方向开工，进入桌面交付流程。' }))
  pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'success' }))
  await enterDesktopLineFromPending(pending)
  return true
}

/** 点了「有要调整的」：转入等反馈文本态并提示。 */
export function startUxAdjustAwait(input: AgentSendMessageInput): void {
  const pending = takePendingUxConfirm(input.project_id)
  if (!pending) return
  if (pending.limitReached) { pending.adjustmentLimit = pending.round + 1; pending.limitReached = false }
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
  pendingUxConfirms.save(pending, 'dismissed')
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
  if (isExplicitUxPause(text)) return undefined
  const feedback = pending.unappliedFeedback && pending.unappliedFeedback !== text
    ? /^(?:重试|再试一次|再试)$/.test(text) ? pending.unappliedFeedback : `${pending.unappliedFeedback}\n补充意见：${text}` : text
  pending.unappliedFeedback = feedback
  pendingUxAdjusts.delete(input.project_id)
  return { pending, feedback }
}

function isExplicitUxPause(text: string): boolean {
  return /^(?:停止|暂停|先停|取消)|(?:不要|别|暂不|先不|取消)[^。！？!?]{0,12}(?:开工|开始|生成|继续|推进)/.test(text.trim())
}

export function consumeUxPauseIntent(input: AgentSendMessageInput): boolean {
  const pending = pendingUxConfirms.get(input.project_id) ?? pendingUxAdjusts.get(input.project_id)
  if (!pending || input.metadata?.source === 'card_option' || !isExplicitUxPause(input.content)) return false
  pending.publish(makeUxEvent(pending, 'message_delta', { text: '先停在当前设计，本次没有开工。准备好后可明确确认，或继续提出调整意见。' }))
  pending.publish(makeUxEvent(pending, 'message_completed', { subtype: 'success' }))
  return true
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
  pending.unappliedFeedback = text
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
  if (!pending || !isContinue || isNegativeUxIntent(input.content)) return false
  pendingUxAdjusts.delete(input.project_id)
  pendingUxConfirms.set(input.project_id, pending)
  await resumeUxConfirmConfirmed(input)
  return true
}

/** 调整轮重入：带反馈重画（轮次 +1，超限暂停并等待明确选择）。 */
export async function runUxAdjustRound(input: AgentSendMessageInput, taken: { pending: PendingUxConfirm; feedback: string }): Promise<void> {
  const { pending, feedback } = taken
  const nextRound = pending.round + 1
  if (nextRound > (pending.adjustmentLimit ?? UX_SKETCH_ADJUST_LIMIT)) {
    recordDecision({
      project_id: input.project_id,
      session_id: pending.session_id,
      entry: {
        type: 'ux_confirm',
        title: '草图调整轮次到达上限，等待版本选择',
        why: '停止自动重画；预算耗尽不代表用户确认，不自动开工',
        detail: { limit: UX_SKETCH_ADJUST_LIMIT, last_feedback: feedback.slice(0, 120) },
      },
    })
    const paused = { ...pending, limitReached: true, unappliedFeedback: feedback }
    pendingUxConfirms.set(input.project_id, paused)
    pending.publish(makeUxEvent(pending, 'message_delta', { text: `本轮重画次数已到上限，你的意见「${feedback.slice(0, 100)}」尚未处理。请选择采用当前设计、再调整一次或稍后继续；本次没有开工。` }))
    publishUxCard(paused)
    return
  }
  await runUxConfirmGate({ ...pending, round: nextRound, sketchSummary: pending.sketchSummary }, feedback)
}

/** 「稍后再说」后的回门：继续词语义 + 已确认 PRD + 未进桌面线 → 重发草图卡（归档草图重挂沙箱）。
 *  query/env 由调用方解析传入（guide 派发上下文里现成，不在本模块伪造）。 */
export async function republishUxCardFromArchive(
  input: AgentSendMessageInput,
  publish: GuideEventPublisher,
  context: { query: SDKQuery; env: Record<string, string>; signal?: AbortSignal },
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
    signal: context.signal,
    publish,
    round: 1,
    positioning: backplane.positioning ?? '',
    requirements: backplane.requirements as SketchRequirement[],
  })
  return true
}

/** 进桌面线（与 prd-confirm 原桌面分支同款装配；UX 门成为唯一入口后此处收口）。 */
async function enterDesktopLineFromPending(pending: PendingUxConfirm): Promise<void> {
  const production = resolveChannelEnv({ channelId: pending.channel_id, category: 'mvp',
    projectId: pending.project_id, sessionId: pending.session_id })
  await enterDesktopLine(
    { projectId: pending.project_id, sessionId: pending.session_id, requestId: pending.request_id, content: '开始桌面交付流程', signal: pending.signal,
      maxTokens: resolveGenerationMaxTokens(production.channel ?? {}) },
    pending.query,
    production.env ?? pending.env,
    {
      publish: (_target, type, payload) => pending.publish(makeUxEvent(pending, type, payload)),
      persistAssistant: () => undefined,
      persistSystem: (sessionId, text) => appendSessionMessage(sessionId, { role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() }),
      complete: (_sessionId, _projectId, outcome) => pending.publish(makeUxEvent(pending, 'message_completed', { subtype: outcome ?? 'success' })),
    },
  )
}

async function returnToPrd(pending: PendingUxConfirm, feedback: string): Promise<void> {
  pendingUxConfirms.delete(pending.project_id)
  pendingUxAdjusts.delete(pending.project_id)
  if (pending.signal?.aborted) return
  pending.publish(makeUxEvent(pending, 'ux_sketch_closed', {}))
  if (readPrdBackplane(pending.project_id).lean_brief) {
    const { handleLeanGuide } = await import('./lean-guide')
    const resolution = resolveChannelEnv({ channelId: pending.channel_id, category: 'guide', projectId: pending.project_id, sessionId: pending.session_id })
    await handleLeanGuide({ project_id: pending.project_id, session_id: pending.session_id, request_id: pending.request_id,
      content: feedback, mode: pending.mode, current_stage: 'clarifying', metadata: { source: 'chat' } }, pending.publish,
    { query: pending.query, env: resolution.env ?? pending.env, signal: pending.signal ?? new AbortController().signal,
      sessionId: pending.session_id, history: [], maxTokens: resolveGenerationMaxTokens(resolution.channel ?? {}), persistAssistant: () => {} })
    return
  }
  pending.publish(makeUxEvent(pending, 'message_delta', { text: '这条意见会改变需求或业务规则，我先更新 PRD 与验收，再重新整理界面设计。' }))
  // The existing candidate list is only a clue; the organizer reads the user's latest feedback.
  const { runPrdPipeline } = await import('./stages/prd-pipeline')
  appendSessionMessage(pending.session_id, { role: 'user', content: [{ type: 'text', text: `在界面设计阶段修改需求：${feedback}` }], timestamp: Date.now(), metadata: { source: 'ux_scope_revision' } })
  await runPrdPipeline({ request_id: pending.request_id, project_id: pending.project_id, session_id: pending.session_id, mode: pending.mode,
    channel_id: pending.channel_id, requirements: pending.requirements, query: pending.query, env: pending.env, publish: pending.publish, signal: pending.signal })
}

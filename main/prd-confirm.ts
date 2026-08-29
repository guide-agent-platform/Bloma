import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput, ResearchIdea } from '../shared/types'
import { recordDecision } from './decision-log'
import { appendPrdRequirements, markPrdUserConfirmed } from './document-engine'
import { nextRequirementId, runSketchTask } from './programming-orchestrator'
import type { PrdBackplane } from './sketch-engine'
import { requirementAssertions, requirementPriority, requirementStory } from './sketch-engine'
import type { SDKQuery } from './orchestrator'

/**
 * PRD 用户确认门（2026-08-26，改造 3）：六维审查**通过**后、草图前，
 * 把背板以「四段式确认卡」摊给用户阅读确认——确认的不是用户说过的话
 * （需求弹窗已做），而是系统加工出的理解细节（story 化/行为断言/优先级/
 * 范围外/假设）。机器质量关（prd-review）与人语义关在此接力。
 *
 * - 卡内容是背板的确定性投影（零 LLM、零自由发挥），与 prd.json 同一真相源；
 * - 回传复用 card_option 元数据（send-message），零新 IPC 通道；
 * - confirm → user_confirmed_at 落盘 prd.json（迭代争议仲裁锚点）→ 开草图；
 * - adjust → 消费 pending，用户打字补充回向导模型路径（新确认流程会重建闭环）；
 * - 审查 needs_revision 的 override 分支同样发本卡（2026-08-27 用户拍板「不过目不开工」：
 *   忽略审查问题≠确认过 PRD，override 后仍须过目；卡片 title 如实标注已忽略问题数）。
 */

/** PRD 确认卡选项 id（回传经 send-message 的 card_option 元数据识别）。 */
export const PRD_CONFIRM_OPTION_CONFIRM = 'prd_confirm_confirm'
export const PRD_CONFIRM_OPTION_ADJUST = 'prd_confirm_adjust'
/** 暂不确认（2026-08-27）：弹窗第三出口——关闭弹窗回对话继续，不开工、pending 消费留痕。 */
export const PRD_CONFIRM_OPTION_DISMISS = 'prd_confirm_dismiss'

/** 确认未决状态：等用户读卡确认或提出调整。 */
interface PendingPrdConfirm {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: Array<{ id: string; description: string }>
  /** 市调提炼想法（2026-08-29 灵感参考）：确认时勾选采纳并入 PRD */
  ideas: ResearchIdea[]
  query: SDKQuery
  publish: (event: AgentEvent) => void
  /** 停止信号：确认后开草图同样可被停止（不传则不可取消） */
  signal?: AbortSignal
}

const pendingPrdConfirms = new Map<string, PendingPrdConfirm>()

export function takePendingPrdConfirm(projectId: string): PendingPrdConfirm | undefined {
  const pending = pendingPrdConfirms.get(projectId)
  pendingPrdConfirms.delete(projectId)
  return pending
}

export function hasPendingPrdConfirm(projectId: string): boolean {
  return pendingPrdConfirms.has(projectId)
}

/**
 * 发布四段式确认卡（kind='prd_confirm'，无 questions → 不触发内联决策卡，
 * 由专用弹窗 PrdConfirmDialog 渲染）。payload 为结构化背板投影：
 * P0 断言展开、完整视图 longterm 默认展开 / quick 折叠（渲染端控制）。
 */
export function publishPrdConfirmCard(opts: {
  input: { request_id: string; session_id: string; project_id: string; mode: AgentSendMessageInput['mode']; channel_id?: string }
  backplane: PrdBackplane
  requirements: Array<{ id: string; description: string }>
  query: SDKQuery
  publish: (event: AgentEvent) => void
  /** 市调提炼想法（2026-08-29 灵感参考）：卡面可勾选采纳 */
  ideas?: ResearchIdea[]
  /** 审查被用户 override 后转入确认门时携带：如实标注「已忽略 N 个审查问题」，
   *  卡片 title 同步变体（不再自称「已通过裁判审查」——诚实披露）。 */
  reviewNote?: string
  /** 停止信号：确认卡回传后开草图的可取消句柄（与发布方同一 controller） */
  signal?: AbortSignal
}): void {
  const { input, backplane, reviewNote } = opts
  const ideas = opts.ideas ?? []
  pendingPrdConfirms.set(input.project_id, {
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    requirements: opts.requirements,
    ideas,
    query: opts.query,
    publish: opts.publish,
    signal: opts.signal,
  })

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'prd_confirm',
      title: 'PRD 用户确认门（挂起）',
      why: reviewNote
        ? `用户已忽略审查问题（${reviewNote}），仍须过目 PRD 后才开草图（不过目不开工）`
        : '审查已通过，等待用户阅读确认 PRD 后开草图',
      detail: { requirement_count: backplane.requirements.length, review_note: reviewNote },
    },
  })

  opts.publish({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type: 'user_decision_required',
    payload: {
      kind: 'prd_confirm',
      title: reviewNote
        ? `请确认这份 PRD（${reviewNote}）`
        : '请确认这份 PRD（已通过裁判审查）',
      review_note: reviewNote,
      positioning: backplane.positioning,
      requirements: backplane.requirements.map((item) => ({
        id: item.id,
        priority: requirementPriority(item),
        story: requirementStory(item),
        assertions: requirementAssertions(item),
      })),
      out_of_scope: backplane.out_of_scope,
      assumptions: backplane.assumptions ?? [],
      constraints: backplane.constraints ?? [],
      expanded: input.mode === 'longterm',
      ideas,
    },
    created_at: new Date().toISOString(),
  } as AgentEvent)
}

/** 确认卡回传识别：card_option 且选项 id 专属、pending 仍存活时才拦截。 */
export function resolvePrdConfirmCardAnswer(
  input: AgentSendMessageInput,
): 'confirm' | 'adjust' | 'dismiss' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (
    optionId !== PRD_CONFIRM_OPTION_CONFIRM &&
    optionId !== PRD_CONFIRM_OPTION_ADJUST &&
    optionId !== PRD_CONFIRM_OPTION_DISMISS
  ) {
    return undefined
  }
  if (!hasPendingPrdConfirm(input.project_id)) return undefined
  if (optionId === PRD_CONFIRM_OPTION_CONFIRM) return 'confirm'
  if (optionId === PRD_CONFIRM_OPTION_DISMISS) return 'dismiss'
  return 'adjust'
}

/** 用户确认：勾选采纳的市调想法先并入 PRD（盘上+待决清单）→ user_confirmed_at 落盘
 * （失败不阻断）→ 决策留痕 → 开草图（2026-08-29 灵感参考：四段式卡同样可采纳想法）。 */
export async function resumePrdConfirmConfirmed(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingPrdConfirm(input.project_id)
  if (!pending) return false
  // 勾选采纳：只认 pending 里真实存在的 label（防篡改），去重后并入
  const adopted = (input.metadata?.adopted_ideas ?? [])
    .filter((label) => pending.ideas.some((idea) => idea.label === label))
  let sketchRequirements = pending.requirements
  if (adopted.length > 0) {
    const additions = adopted.map((label) => ({
      description: `参考市面做法：${label.replace(/\s+/g, ' ').trim()}`,
      origin: 'user' as const,
    }))
    const updatedBackplane = appendPrdRequirements(input.project_id, additions)
    if (updatedBackplane) {
      sketchRequirements = updatedBackplane.requirements.map((item) => ({
        id: item.id,
        description: item.description,
      }))
    } else {
      // 盘上缺失/损坏：仅并入内存清单（id 由 nextRequirementId 语义编号，防碰撞）
      const memoryMerged = [...pending.requirements]
      for (const addition of additions) {
        memoryMerged.push({ id: nextRequirementId(memoryMerged), ...addition })
      }
      sketchRequirements = memoryMerged
      console.error('[prd-confirm] 采纳想法写入 prd.json 失败（缺失/损坏），仅并入草图任务清单')
    }
  }
  const confirmed = markPrdUserConfirmed(input.project_id)
  if (!confirmed) console.error('[prd-confirm] user_confirmed_at 落盘失败（prd.json 缺失/损坏），继续开草图')
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_confirm',
      title: 'PRD 用户已确认',
      why: confirmed
        ? `用户在确认卡选择「确认无误」，user_confirmed_at=${confirmed.user_confirmed_at}`
        : '用户在确认卡选择「确认无误」（时间戳落盘失败，决策仍留痕）',
      detail: {
        ...(confirmed?.user_confirmed_at ? { user_confirmed_at: confirmed.user_confirmed_at } : {}),
        ...(adopted.length > 0 ? { adopted_ideas: adopted } : {}),
      },
    },
  })
  const ack =
    adopted.length > 0
      ? `已确认，按这份 PRD（含采纳的 ${adopted.length} 条市调想法）开始画草图。`
      : '已确认，按这份 PRD 开始画草图。'
  pending.publish(makeConfirmEvent(pending, 'message_delta', { text: ack }))
  pending.publish(makeConfirmEvent(pending, 'message_completed', { subtype: 'success' }))
  await runSketchTask({
    request_id: pending.request_id,
    session_id: pending.session_id,
    project_id: pending.project_id,
    mode: pending.mode,
    prompt: '按确认的需求清单生成草图',
    requirements: sketchRequirements,
    channel_id: pending.channel_id,
    query: pending.query,
    signal: pending.signal,
  })
  return true
}

/** 用户选择调整：取走 pending（带文本时直接进修订闭环），返回待决信息供调用方。 */
export function consumePrdConfirmAdjust(input: AgentSendMessageInput): PendingPrdConfirm | undefined {
  const pending = takePendingPrdConfirm(input.project_id)
  if (!pending) return undefined
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_confirm',
      title: '用户选择调整 PRD，回向导修订',
      why: '用户在确认卡选择「有要调整的」（或点击了具体条目的「这条不对」）',
      detail: { user_message: input.content.slice(0, 200) },
    },
  })
  return pending
}

/** 用户暂不确认（2026-08-27）：关闭弹窗回对话继续——不开工（不过目不开工保持），
 * pending 消费留痕；用户后续在对话里理顺需求后会重新收敛出新确认卡。 */
export function consumePrdConfirmDismiss(input: AgentSendMessageInput): PendingPrdConfirm | undefined {
  const pending = takePendingPrdConfirm(input.project_id)
  if (!pending) return undefined
  recordDecision({
    project_id: input.project_id,
    session_id: pending.session_id,
    entry: {
      type: 'prd_confirm',
      title: '用户暂不确认 PRD，回对话继续',
      why: '用户在确认卡选择「稍后再说」——不开工，需求继续在对话里打磨',
      detail: {},
    },
  })
  return pending
}

function makeConfirmEvent(
  pending: Pick<PendingPrdConfirm, 'session_id' | 'project_id'>,
  type: AgentEvent['type'],
  payload: Record<string, unknown>,
): AgentEvent {
  return {
    event_id: randomUUID(),
    session_id: pending.session_id,
    project_id: pending.project_id,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

import { randomUUID } from 'node:crypto'
import type { AgentEvent, AgentSendMessageInput } from '../shared/types'
import { recordDecision } from './decision-log'
import { markPrdUserConfirmed } from './document-engine'
import { runSketchTask } from './programming-orchestrator'
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
 * - 审查 needs_revision 的 override 分支不再发本卡（用户刚决策过，避免双重打断）。
 */

/** PRD 确认卡选项 id（回传经 send-message 的 card_option 元数据识别）。 */
export const PRD_CONFIRM_OPTION_CONFIRM = 'prd_confirm_confirm'
export const PRD_CONFIRM_OPTION_ADJUST = 'prd_confirm_adjust'

/** 确认未决状态：等用户读卡确认或提出调整。 */
interface PendingPrdConfirm {
  request_id: string
  session_id: string
  project_id: string
  mode: AgentSendMessageInput['mode']
  channel_id?: string
  requirements: Array<{ id: string; description: string }>
  query: SDKQuery
  publish: (event: AgentEvent) => void
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
}): void {
  const { input, backplane } = opts
  pendingPrdConfirms.set(input.project_id, {
    request_id: input.request_id,
    session_id: input.session_id,
    project_id: input.project_id,
    mode: input.mode,
    channel_id: input.channel_id,
    requirements: opts.requirements,
    query: opts.query,
    publish: opts.publish,
  })

  recordDecision({
    project_id: input.project_id,
    session_id: input.session_id,
    entry: {
      type: 'prd_confirm',
      title: 'PRD 用户确认门（挂起）',
      why: '审查已通过，等待用户阅读确认 PRD 后开草图',
      detail: { requirement_count: backplane.requirements.length },
    },
  })

  opts.publish({
    event_id: randomUUID(),
    session_id: input.session_id,
    project_id: input.project_id,
    type: 'user_decision_required',
    payload: {
      kind: 'prd_confirm',
      title: '请确认这份 PRD（已通过裁判审查）',
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
    },
    created_at: new Date().toISOString(),
  } as AgentEvent)
}

/** 确认卡回传识别：card_option 且选项 id 专属、pending 仍存活时才拦截。 */
export function resolvePrdConfirmCardAnswer(
  input: AgentSendMessageInput,
): 'confirm' | 'adjust' | undefined {
  if (input.metadata?.source !== 'card_option') return undefined
  const optionId = input.metadata.selected_option_id
  if (optionId !== PRD_CONFIRM_OPTION_CONFIRM && optionId !== PRD_CONFIRM_OPTION_ADJUST) {
    return undefined
  }
  if (!hasPendingPrdConfirm(input.project_id)) return undefined
  return optionId === PRD_CONFIRM_OPTION_CONFIRM ? 'confirm' : 'adjust'
}

/** 用户确认：user_confirmed_at 落盘（失败不阻断）→ 决策留痕 → 开草图。 */
export async function resumePrdConfirmConfirmed(input: AgentSendMessageInput): Promise<boolean> {
  const pending = takePendingPrdConfirm(input.project_id)
  if (!pending) return false
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
      detail: confirmed?.user_confirmed_at ? { user_confirmed_at: confirmed.user_confirmed_at } : {},
    },
  })
  const ack = '已确认，按这份 PRD 开始画草图。'
  pending.publish(makeConfirmEvent(pending, 'message_delta', { text: ack }))
  pending.publish(makeConfirmEvent(pending, 'message_completed', { subtype: 'success' }))
  await runSketchTask({
    request_id: pending.request_id,
    session_id: pending.session_id,
    project_id: pending.project_id,
    mode: pending.mode,
    prompt: '按确认的需求清单生成草图',
    requirements: pending.requirements,
    channel_id: pending.channel_id,
    query: pending.query,
  })
  return true
}

/** 用户选择调整：取走 pending（补充后新确认流程会重建），返回待决信息供调用方发提示。 */
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

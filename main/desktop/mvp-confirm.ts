/**
 * longterm MVP 确认门（2026-10-04 确认门新规，实施稿《Bloma-确认门与呈现层-20261004》）。
 *
 * 拍板矩阵：longterm＝PRD+UX+MVP 三道——verify 全绿后、delivered 前交用户过目
 * （截图/文件清单/DELIVERY 摘要；右栏 DeliveryPanel 同步可见）。确认 → 交付收口
 * （复用发卡时装配的通知数据，含 driverReport 等运行期证据）；调整（卡选项或挂起
 * 期间任意普通非停止消息）→ 由 desktop-route 回炉 implement（【交付前迭代】任务书，
 * 与 delivered 反馈回炉同机制）。quick 不设（快速直通道不变）。
 *
 * pending 为进程内存态（与 guide 线确认卡同口径）：应用重启丢卡 = 回到 verify，
 * 用户发任意消息重跑 verify 收口会再次触发本门，无死锁。
 */
import type { DesktopDispatchRunResult } from './dispatcher-loop'
import type { DesktopRouteDeps } from './desktop-route'
import type { DeliveredNoticeInput } from './notice-cards'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordDecision } from '../project/decision-log'
import { buildDeliveredNoticeCard } from './notice-cards'
import { updateProject, findProject } from '../project/project-service'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'

export const MVP_OPTION_CONFIRM = 'mvp_confirm_go'
export const MVP_OPTION_ADJUST = 'mvp_adjust'

const MVP_REVIEW_RELATIVE_PATH = '00_VERIFY/mvp-review.html'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 成品过目页（2026-10-05：MVP 门「像 UX 门一样右栏呈现」）：截图画廊 + 驱动验收结论
 *  + DELIVERY 摘要；落盘 00_VERIFY/ 供 bloma-file:// 直读（截图相对路径同目录引用）。 */
function buildMvpReviewHtml(notice: DeliveredNoticeInput): string {
  const shots = (notice.screenshotPaths ?? [])
    .map((rel) => rel.replace(/^00_VERIFY\//, ''))
    .map((rel) => `<figure><img src="${escapeHtml(rel)}" alt="程序截图"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`)
    .join('\n')
  const driverLine = notice.driverSummary
    ? `<li>驱动验收：${notice.driverSummary.passed}/${notice.driverSummary.total} 场景 PASS（平台真实执行回读）</li>`
    : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>成品过目 · ${escapeHtml(notice.projectName)}</title>
<style>
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 24px; background: #f7f8fa; color: #333; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #888; font-size: 13px; margin-bottom: 16px; }
  ul { font-size: 14px; line-height: 1.9; margin: 0 0 20px; padding-left: 20px; }
  figure { margin: 0 0 16px; }
  img { max-width: 100%; border: 1px solid #ddd; border-radius: 8px; background: #fff; }
  figcaption { font-size: 12px; color: #999; margin-top: 4px; }
  pre { background: #fff; border: 1px solid #e3e6ea; border-radius: 8px; padding: 12px 16px; font-size: 13px; white-space: pre-wrap; }
  .foot { text-align: center; color: #aaa; font-size: 12px; margin-top: 24px; }
</style>
</head>
<body>
<h1>成品过目：${escapeHtml(notice.projectName)}</h1>
<div class="sub">来源阶段：${escapeHtml(notice.fromPhaseTitle)} · 验收全绿，等你确认后正式交付</div>
<ul>${driverLine}<li>程序文件与运行方式：右侧交付面板 / 项目根 DELIVERY.md</li></ul>
${notice.deliveryDigest ? `<pre>${escapeHtml(notice.deliveryDigest)}</pre>` : ''}
${shots || '<p style="color:#999">（无截图——无窗口程序或截图未产出）</p>'}
<div class="foot">确认后在聊天中的「确认，交付」生效；有要改的直接回复</div>
</body>
</html>`
}

interface PendingMvpConfirm {
  session_id: string
  from_phase: string
  /** 发卡时装配好的交付通知数据（driverReport 等运行期证据此刻才有，确认时复用） */
  notice: DeliveredNoticeInput
}

const pendingMvpConfirms = new Map<string, PendingMvpConfirm>()

export function isMvpConfirmPending(projectId: string): boolean {
  return pendingMvpConfirms.has(projectId)
}

/** verify→delivered 收口点调用：挂起 MVP 确认卡（不发交付通知、不置 delivered）。 */
export function holdForMvpConfirm(options: {
  input: { sessionId: string; projectId: string; cardOptionId?: string }
  deps: DesktopRouteDeps
  fromPhase: string
  notice: DeliveredNoticeInput
}): void {
  const { input, deps } = options
  pendingMvpConfirms.set(input.projectId, {
    session_id: input.sessionId,
    from_phase: options.fromPhase,
    notice: options.notice,
  })
  const screenshotCount = options.notice.screenshotPaths?.length ?? 0
  recordDecision({
    project_id: input.projectId,
    session_id: input.sessionId,
    entry: {
      type: 'mvp_confirm',
      title: 'MVP 用户确认门（挂起）',
      why: 'longterm 工程链验收全绿，交付前交用户过目成品（确认门矩阵：quick 不设此门）',
      detail: {
        from_phase: options.fromPhase,
        screenshot_count: screenshotCount,
        has_delivery_doc: Boolean(options.notice.deliveryDigest),
      },
    },
  })
  // 成品过目页（像 UX 门一样右栏呈现，2026-10-05）：过目页失败不阻断门（卡照发）
  let reviewUrl: string | undefined
  try {
    const root = findProject(input.projectId)?.root_path
    if (root) {
      const reviewAbs = join(root, MVP_REVIEW_RELATIVE_PATH)
      mkdirSync(join(reviewAbs, '..'), { recursive: true })
      writeFileSync(reviewAbs, buildMvpReviewHtml(options.notice), 'utf8')
      reviewUrl = mintProjectPreviewUrl(input.projectId, MVP_REVIEW_RELATIVE_PATH)
    }
  } catch (error) {
    console.error('[mvp-confirm] 成品过目页生成失败（不阻断门）:', error)
  }
  if (reviewUrl) {
    deps.publish(input, 'mvp_review_ready', { preview_url: reviewUrl })
  }
  // 等待用户态可见（A-07 同款）：阶段条呈现「已暂停等待确认」而不是停在运行态
  deps.publish(input, 'stage_changed', { stage: options.fromPhase, paused: true })
  deps.publish(input, 'message_delta', {
    text: [
      '验收全部通过，成品已就绪：右侧已切换为「成品过目」视图（程序截图 + 验收结论 + 交付说明），',
      reviewUrl ? '' : '程序文件与交付说明在右侧交付面板，运行截图在通知与产物条里。',
      '请你过目确认——确认后正式交付；有要改的直接说，我改完重新验收再交。',
    ].filter(Boolean).join(''),
  })
  deps.publish(input, 'user_decision_required', {
    kind: 'mvp_confirm',
    title: '请确认成品（MVP）',
    questions: [
      { id: MVP_OPTION_CONFIRM, label: '确认，交付', description: '验收已全绿，正式交付' },
      { id: MVP_OPTION_ADJUST, label: '有要修改的', description: '直接说要改哪里，改完重新验收' },
    ],
  })
  deps.complete(input.sessionId, input.projectId)
}

/** 测试隔离：清 pending（生产无用）。 */
export function resetMvpConfirmForTests(): void {
  pendingMvpConfirms.clear()
}

/** MVP 卡回传识别（desktop-route 消息入口调用；返回 undefined 则不拦截）。 */
export function resolveMvpConfirmAnswer(input: { projectId: string; cardOptionId?: string }): 'confirm' | 'adjust' | undefined {
  if (!isMvpConfirmPending(input.projectId)) return undefined
  if (input.cardOptionId === MVP_OPTION_CONFIRM) return 'confirm'
  if (input.cardOptionId === MVP_OPTION_ADJUST) return 'adjust'
  return undefined
}

/** 挂起期间的普通消息＝修改意见（与 delivered 反馈同语义）；停止词除外（走原停止链）。 */
export function isMvpFeedbackMessage(input: { projectId: string; cardOptionId?: string }, isStopIntent: boolean): boolean {
  return isMvpConfirmPending(input.projectId) && !input.cardOptionId && !isStopIntent
}

/** 确认交付：清 pending → 复用发卡时装配的通知数据做交付收口（viaMvpConfirm 话术）。 */
export function confirmMvpDelivered(options: {
  input: { sessionId: string; projectId: string }
  deps: DesktopRouteDeps
}): void {
  const { input, deps } = options
  const pending = pendingMvpConfirms.get(input.projectId)
  pendingMvpConfirms.delete(input.projectId)
  recordDecision({
    project_id: input.projectId,
    session_id: input.sessionId,
    entry: {
      type: 'mvp_confirm',
      title: '用户确认成品，正式交付',
      why: '用户在 MVP 确认卡选择「确认，交付」',
    },
  })
  updateProject(input.projectId, { desktop_phase: 'delivered', status: 'completed', current_stage: 'completed' })
  deps.publish(input, 'mvp_review_closed', {})
  deps.publish(input, 'stage_changed', { stage: 'delivered' })
  deps.publish(input, 'message_delta', {
    text: buildDeliveredNoticeCard({ ...(pending?.notice ?? { projectName: input.projectId, fromPhaseTitle: pending?.from_phase ?? 'desktop-verify' }), viaMvpConfirm: true }),
  })
  deps.persistSystem(input.sessionId, `[decision] desktop-mvp-confirmed ${pending?.from_phase ?? 'desktop-verify'} → delivered（MVP 用户确认门通过）`)
  deps.complete(input.sessionId, input.projectId)
}

/** 调整回炉前消费 pending（决策留痕）；阶段切换与任务书由 desktop-route 回炉分支执行。 */
export function consumeMvpPendingForRework(input: { sessionId: string; projectId: string }): { from_phase: string } | undefined {
  const pending = pendingMvpConfirms.get(input.projectId)
  if (!pending) return undefined
  pendingMvpConfirms.delete(input.projectId)
  recordDecision({
    project_id: input.projectId,
    session_id: input.sessionId,
    entry: {
      type: 'mvp_confirm',
      title: '用户要求修改成品，回炉实现',
      why: `交付前过目未通过，按意见回炉 implement（来自「${pending.from_phase}」收口）`,
    },
  })
  return { from_phase: pending.from_phase }
}

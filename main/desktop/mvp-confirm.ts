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
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordDecision } from '../project/decision-log'
import { buildDeliveredNoticeCard } from './notice-cards'
import { updateProject, findProject } from '../project/project-service'
import { mintProjectPreviewUrl } from '../delivery/preview-scheme'
import { recordDeliveryOutcomeTelemetry } from './dispatcher-telemetry'
import { DRIVE_FINDINGS_REL, type DriveFinding } from './drive-app-tool'

export const MVP_OPTION_CONFIRM = 'mvp_confirm_go'
export const MVP_OPTION_ADJUST = 'mvp_adjust'

const MVP_REVIEW_RELATIVE_PATH = '00_VERIFY/mvp-review.html'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 成品过目页（2026-10-05：MVP 门「像 UX 门一样右栏呈现」）：截图画廊 + 驱动验收结论
 *  + DELIVERY 摘要；落盘 00_VERIFY/ 供 bloma-file:// 直读（截图相对路径同目录引用）。探索
 *  发现段（2026-10-05 探索驱动测试批）从 drive-findings.json 注入——参考证据不阻塞交付。 */
function buildMvpReviewHtml(notice: DeliveredNoticeInput, driveFindings?: DriveFinding[], driveSessions?: Array<{ session_id: string; outcome: string; ops?: number }>, faultKill?: { audit?: { findings?: Array<{ state?: string }>; error?: string }; faultKill?: { entries?: Array<{ fid: string; seed: string; result: string; detail?: string }>; killed: number; executed: number; survived: number; notApplicable: number; notRun: number } }): string {
  const shots = (notice.screenshotPaths ?? [])
    .map((rel) => rel.replace(/^00_VERIFY\//, ''))
    .map((rel) => `<figure><img src="${escapeHtml(rel)}" alt="程序截图"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`)
    .join('\n')
  const driverLine = notice.driverSummary
    ? `<li>驱动验收：${notice.driverSummary.passed}/${notice.driverSummary.total} 场景 PASS（平台真实执行回读）</li>`
    : ''
  const findingsSection =
    driveFindings && driveFindings.length > 0
      ? `<h2 style="font-size:15px;margin:20px 0 8px;">探索发现（${driveFindings.length} 项 · 参考证据，不阻塞交付）</h2>\n<ul>${driveFindings
          .map(
            (item) =>
              `<li><b>[${escapeHtml(item.severity)}] ${escapeHtml(item.title)}</b>${(item as unknown as { superseded_by?: string }).superseded_by ? `（已被 ${escapeHtml((item as unknown as { superseded_by: string }).superseded_by)} 修正）` : ''}<br/>应发生：${escapeHtml(item.expected)}<br/>实际：${escapeHtml(item.actual)}</li>`,
          )
          .join('')}</ul>`
      : ''
  // 探索状态真相段（2026-10-06 发现④/B4）：探索失败≠零发现——会话状态非正常时如实
  // 告知「本轮未含真实 GUI 探索证据」（呈现真相，不阻塞交付，两轨原则不变）。
  const badSessions = (driveSessions ?? []).filter((item) => item.outcome !== 'closed')
  const explorationStatusSection =
    driveSessions && driveSessions.length > 0 && badSessions.length === driveSessions.length
      ? `<h2 style="font-size:15px;margin:20px 0 8px;color:#b45309;">⚠ 探索会话未正常完成（${badSessions.map((item) => `${item.session_id.slice(-6)}:${escapeHtml(item.outcome)}`).join('、')}）</h2>\n<p style="font-size:13px;color:#92400e;">真实 GUI 探索未能完成，本轮验收未包含探索证据——以上驱动验收全绿不等于探索通过。可确认交付（风险自担），或回炉修复后重验。</p>`
      : ''
  // 故障种子击杀段（批6 2026-10-06）：测试有效性证据——survived 在收口已硬拒收，
  // 这里呈现的是通过面（killed/executed）与 not-applicable 如实面（不阻塞）。
  const faultKillSection =
    faultKill && faultKill.faultKill && faultKill.faultKill.executed + faultKill.faultKill.notApplicable + faultKill.faultKill.notRun > 0
      ? `<h2 style="font-size:15px;margin:20px 0 8px;">故障种子击杀（${faultKill.faultKill.killed}/${faultKill.faultKill.executed} 注入已知缺陷被测试判红${faultKill.faultKill.notApplicable + faultKill.faultKill.notRun > 0 ? `；未定位/未跑 ${faultKill.faultKill.notApplicable + faultKill.faultKill.notRun} 项如实呈现` : ''}）</h2>` +
        `<ul>${(faultKill.faultKill.entries ?? [])
          .map((entry: { fid: string; seed: string; result: string; detail?: string }) =>
            `<li>[${escapeHtml(entry.result)}] ${escapeHtml(entry.fid)} · ${escapeHtml(entry.seed)}${entry.detail ? `：${escapeHtml(entry.detail)}` : ''}</li>`)
          .join('')}</ul>`
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
${explorationStatusSection}
${findingsSection}
${faultKillSection}
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
      // 探索发现（2026-10-05 探索驱动测试批）：verify 编排器委派的探索者在 loop 内把
      // findings 写入 00_VERIFY/drive-findings.json（委派被等待，settle 时已就绪）；
      // 文件缺失/零发现=未探索或无发现，如实降级不渲染。
      let driveFindings: DriveFinding[] | undefined
      try {
        const parsed = JSON.parse(readFileSync(join(root, DRIVE_FINDINGS_REL), 'utf8')) as { findings?: DriveFinding[] }
        if (Array.isArray(parsed.findings) && parsed.findings.length > 0) driveFindings = parsed.findings
      } catch {
        // 无探索发现文件：如实降级
      }
      // 探索会话状态（B3/B4）：探索失败≠零发现——读 drive-sessions.json 呈现真相
      let driveSessions: Array<{ session_id: string; outcome: string; ops?: number }> | undefined
      try {
        const parsedSessions = JSON.parse(readFileSync(join(root, '00_VERIFY/drive-sessions.json'), 'utf8')) as Array<{ session_id?: string; outcome?: string; ops?: number }>
        if (Array.isArray(parsedSessions) && parsedSessions.length > 0) {
          driveSessions = parsedSessions
            .filter((item) => typeof item.session_id === 'string' && typeof item.outcome === 'string')
            .map((item) => ({ session_id: item.session_id as string, outcome: item.outcome as string, ops: item.ops }))
        }
      } catch {
        // 无会话状态文件：如实降级（未探索或旧版）
      }
      // 故障种子击杀报告（批6 2026-10-06）：测试有效性证据面——文件缺失=收口未跑
      //（quick 单/工具降级），如实降级不渲染。
      let faultKill: Parameters<typeof buildMvpReviewHtml>[3] | undefined
      try {
        faultKill = JSON.parse(readFileSync(join(root, '00_VERIFY/fault-kill-report.json'), 'utf8')) as Parameters<typeof buildMvpReviewHtml>[3]
      } catch {
        // 无击杀报告：如实降级
      }
      writeFileSync(reviewAbs, buildMvpReviewHtml(options.notice, driveFindings, driveSessions, faultKill), 'utf8')
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
  recordDeliveryOutcomeTelemetry(input.projectId, input.sessionId, 'mvp-confirm')
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

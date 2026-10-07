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
import { readPrdBackplane } from '../project/document-engine'
import { SHAPE_TEMPLATE_LABELS, listShapeDefaults } from './shape-templates'
import { readLlmQualification, type LlmQualificationOutcome } from './provider-qualification'

export const MVP_OPTION_CONFIRM = 'mvp_confirm_go'
export const MVP_OPTION_ADJUST = 'mvp_adjust'

const MVP_REVIEW_RELATIVE_PATH = '00_VERIFY/mvp-review.html'

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 形状段数据（批9 工件4：报告呈现）：模板/job_policy 采用面 + default 规则（未采用项+依据
 * 首期不做自动检测——如实呈现模板要求，交付声明在 DELIVERY.md）+ LLM 双轴呈现。 */
export interface ShapeReportSection {
  hostLabel: string
  primaryLoop: string
  jobPolicy: string
  defaultRules: string[]
  llmRole: string
  llmQualification?: LlmQualificationOutcome
}

/** close_policy 已知值人话映射（自由字符串，未知值原样呈现兑底；批10 去工程语）。 */
function closePolicyUserText(policy: string): string {
  if (policy === 'wait_or_confirm') return '没跑完就关窗口时，会等它跑完或先问你'
  if (policy === 'abort') return '没跑完就关窗口时，任务直接终止'
  if (policy === 'background') return '关掉窗口后，任务在后台继续跑'
  return `关闭窗口时的处理：${policy}`
}

/** llm_role 人话（报告段用；none 不渲染；批10 去工程语——枚举值不给用户看）。 */
const LLM_ROLE_USER_TEXT: Record<string, string> = {
  core: 'AI 是这个软件的核心（不配好 AI 就用不了主要功能）',
  optional: 'AI 是加分项（AI 不可用时其他功能照常能用）',
  preview: 'AI 效果仅预览示意，不代表最终效果',
  user_config: 'AI 功能要你自己配好密钥才能用',
}

function buildShapeReportSection(section: ShapeReportSection | undefined): string {
  if (!section) return ''
  const lines: string[] = []
  lines.push(`<h2 style="font-size:15px;margin:20px 0 8px;">这是一个${escapeHtml(section.hostLabel)}</h2>`)
  lines.push(`<ul>`)
  lines.push(`<li>主要用法：${escapeHtml(section.primaryLoop)}</li>`)
  lines.push(`<li>${escapeHtml(section.jobPolicy)}</li>`)
  if (section.llmRole !== 'none') {
    lines.push(`<li>AI 部分：${escapeHtml(LLM_ROLE_USER_TEXT[section.llmRole] ?? section.llmRole)}</li>`)
  }
  lines.push(`</ul>`)
  if (section.defaultRules.length > 0) {
    lines.push(`<p style="font-size:13px;color:#666;">同类的通用好做法（本次没采用的，会在交付说明里写明原因）：${section.defaultRules.map(escapeHtml).join('；')}</p>`)
  }
  return lines.join('\n')
}

/** 成品过目页（2026-10-05：MVP 门「像 UX 门一样右栏呈现」）：截图画廊 + 驱动验收结论
 *  + DELIVERY 摘要；落盘 00_VERIFY/ 供 bloma-file:// 直读（截图相对路径同目录引用）。探索
 *  发现段（2026-10-05 探索驱动测试批）从 drive-findings.json 注入——参考证据不阻塞交付。 */
function buildMvpReviewHtml(notice: DeliveredNoticeInput, driveFindings?: DriveFinding[], driveSessions?: Array<{ session_id: string; outcome: string; ops?: number }>, faultKill?: { audit?: { findings?: Array<{ state?: string }>; error?: string }; faultKill?: { entries?: Array<{ fid: string; seed: string; result: string; detail?: string }>; killed: number; executed: number; survived: number; notApplicable: number; notRun: number } }, shapeSection?: ShapeReportSection): string {
  const shots = (notice.screenshotPaths ?? [])
    .map((rel) => rel.replace(/^00_VERIFY\//, ''))
    .map((rel) => `<figure><img src="${escapeHtml(rel)}" alt="程序截图"/><figcaption>${escapeHtml(rel)}</figcaption></figure>`)
    .join('\n')
  // ===== 批10 信任报告三段（2026-10-07 外部 LLM 意见吸收）：本版本已确认能做（附验证
  // 方式）/ 目前限制 / 给你的建议——全部由平台结构化证据（驱动/截图/击杀/PQ/探索会话）
  // 确定性拼装，零 LLM 参与；工程明细（击杀条目/trace）留在 00_VERIFY 文件里。 =====
  const confirmedLines: string[] = []
  if (notice.driverSummary) {
    confirmedLines.push(
      `<li>核心功能真实运行检查：${notice.driverSummary.passed}/${notice.driverSummary.total} 场景 PASS——平台实际启动了程序，按验收清单逐条执行并核对结果</li>`,
    )
  }
  const shotCount = (notice.screenshotPaths ?? []).length
  if (shotCount > 0) {
    confirmedLines.push(`<li>程序能正常启动并显示界面——下方 ${shotCount} 张截图是平台真实运行时拍下的</li>`)
  }
  const fk = faultKill?.faultKill
  if (fk && fk.executed > 0) {
    confirmedLines.push(
      fk.killed === fk.executed
        ? `<li>测试有效性抽查：故意植入 ${fk.executed} 个已知缺陷，全部被测试抓住（说明测试真的在检查，不是走形式）</li>`
        : `<li>测试有效性抽查：植入的 ${fk.executed} 个已知缺陷中 ${fk.killed} 个被测试抓住</li>`,
    )
  }
  const qualification = shapeSection?.llmQualification
  if (qualification?.executed && qualification.qualified) {
    confirmedLines.push(
      `<li>真实 AI 服务验证通过（平台用自己的渠道实际调用了 ${qualification.calls} 次；密钥不经过这个软件）</li>`,
    )
  }
  if (confirmedLines.length === 0) {
    confirmedLines.push('<li>本页未取到结构化验证数据（如实呈现）——结论以验收清单与交付说明为准</li>')
  }
  const confirmedSection = `<h2 style="font-size:15px;margin:20px 0 8px;">本版本已确认能做（附验证方式）</h2>\n<ul>${confirmedLines.join('')}</ul>`
  const findingsSection =
    driveFindings && driveFindings.length > 0
      ? `<h2 style="font-size:15px;margin:20px 0 8px;">探索发现（${driveFindings.length} 项 · P0 是重要问题、P1 是次要建议；不拦着交付，但你该知道）</h2>\n<ul>${driveFindings
          .map(
            (item) =>
              `<li><b>[${escapeHtml(item.severity)}] ${escapeHtml(item.title)}</b>${(item as unknown as { superseded_by?: string }).superseded_by ? `（已被 ${escapeHtml((item as unknown as { superseded_by: string }).superseded_by)} 修正）` : ''}<br/>应发生：${escapeHtml(item.expected)}<br/>实际：${escapeHtml(item.actual)}</li>`,
          )
          .join('')}</ul>`
      : ''
  // 探索会话状态（2026-10-06 发现④/B4 → 批10 并入「目前限制」段）：探索失败≠零发现
  // ——全部会话非正常时如实告知（呈现真相，不阻塞交付，两轨原则不变）。
  const badSessions = (driveSessions ?? []).filter((item) => item.outcome !== 'closed')
  const limitLines: string[] = []
  if (qualification) {
    if (qualification.executed && !qualification.qualified) {
      limitLines.push(
        `<li>真实 AI 服务验证<b>未通过</b>（${qualification.calls} 次调用${qualification.findings.length > 0 ? `：${qualification.findings.map(escapeHtml).join('；')}` : ''}）——AI 相关功能没拿到真实验证${shapeSection?.llmRole === 'core' ? '，按约定这个版本不能算完整交付' : '，可以先用，但 AI 部分请自行留心'}</li>`,
      )
    } else if (!qualification.executed) {
      limitLines.push(
        `<li>没有做过真实 AI 服务验证（${escapeHtml(qualification.skipped_reason ?? '原因未记录')}）——AI 功能只在本地模拟环境测过，没有连过真实 AI 服务</li>`,
      )
    }
  }
  if (driveSessions && driveSessions.length > 0 && badSessions.length === driveSessions.length) {
    limitLines.push(
      `<li>探索会话未正常完成（${badSessions.map((item) => `${item.session_id.slice(-6)}:${escapeHtml(item.outcome)}`).join('、')}）——上面的检查都按既定清单执行过，但没有人用「随便点点」的自由方式试用过这个程序，可能有清单外的小问题没被发现</li>`,
    )
  }
  if (fk && fk.notApplicable + fk.notRun > 0) {
    limitLines.push(`<li>测试有效性抽查有 ${fk.notApplicable + fk.notRun} 项没能执行（不适用或未定位到注入点，如实告知）</li>`)
  }
  const limitsSection =
    `<h2 style="font-size:15px;margin:20px 0 8px;">目前限制</h2>\n` +
    (limitLines.length > 0
      ? `<ul>${limitLines.join('')}</ul>`
      : `<p style="font-size:13px;color:#666;">平台检查没有发现已知限制；实现方在交付说明里写明的限制，以下方交付说明原文为准。</p>`)
  const adviceLines: string[] = [
    '<li>先小规模试用：拿一两个真实数据试试核心功能，符合预期再放心日常使用</li>',
    '<li>怎么运行、数据存在哪里、怎么备份：看下方交付说明（或右侧交付面板里的 DELIVERY.md）</li>',
  ]
  if (shapeSection?.llmRole === 'user_config') {
    adviceLines.push('<li>用 AI 功能前，先在程序的设置里填你自己的 AI 密钥（步骤见交付说明）</li>')
  }
  adviceLines.push('<li>发现不对劲或想改，直接在聊天里说——我改完会重新检查再交给你</li>')
  const adviceSection = `<h2 style="font-size:15px;margin:20px 0 8px;">给你的建议</h2>\n<ul>${adviceLines.join('')}</ul>`
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
<div class="sub">自动检查已全部通过——请你过目，确认后正式交付</div>
${confirmedSection}
${limitsSection}
${adviceSection}
${buildShapeReportSection(shapeSection)}
${findingsSection}
${notice.deliveryDigest ? `<h2 style="font-size:15px;margin:20px 0 8px;">交付说明原文（怎么运行 · 你的数据存在哪 · 限制明细）</h2>\n<pre>${escapeHtml(notice.deliveryDigest)}</pre>` : ''}
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
      // 形状段（批9 工件4 2026-10-07）：背板 shape 存在时呈现模板/策略/缺省做法与 LLM 双轴；
      // llm-qualification.json 由 verify 收口的 Provider Qualification 写入（llm_role≠none）。
      let shapeSection: ShapeReportSection | undefined
      try {
        const backplane = readPrdBackplane(input.projectId)
        if (backplane.shape) {
          const shape = backplane.shape
          shapeSection = {
            hostLabel: SHAPE_TEMPLATE_LABELS[shape.host_template],
            primaryLoop: shape.primary_loop,
            jobPolicy: [
              shape.job_policy.cancellable ? '任务可以中途取消' : '任务不支持中途取消（按你的要求）',
              shape.job_policy.progress ? '执行中能看到进度' : '执行中没有单独的进度显示',
              closePolicyUserText(shape.job_policy.close_policy),
            ].join('；'),
            defaultRules: listShapeDefaults(shape.host_template).map((rule) => rule.requirement),
            llmRole: shape.llm_role,
            ...(shape.llm_role !== 'none' ? { llmQualification: readLlmQualification(root) } : {}),
          }
        }
      } catch {
        // 背板/形状读取失败：如实降级不渲染
      }
      writeFileSync(reviewAbs, buildMvpReviewHtml(options.notice, driveFindings, driveSessions, faultKill, shapeSection), 'utf8')
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

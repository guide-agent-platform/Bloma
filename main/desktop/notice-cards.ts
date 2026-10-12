/**
 * 桌面线人话卡构建器（刀1，2026-10-02 确认协议与呈现层战役）。
 *
 * 「人话卡」= 面向普通用户的结构化中文通知：出了什么事 / 你可以做什么 / 证据在哪。
 * 人工是异常处理器不是流水线工位（战役拍板）：
 * - delivered 通知≠确认——不阻塞、不等待；用户回复修改意见走 iterating；
 * - blocked 卡只在两种情况出现：用户停止词命中，或门禁修复轮（拒收闭环 ≤2 次）耗尽。
 *
 * 纯函数零 I/O：文件读取/统计字段由调用方注入（测试零桩）；文案单点维护。
 */

/** delivered 交付通知卡输入。 */
export interface DeliveredNoticeInput {
  projectName: string
  /** 来源阶段标题（当前为「驱动验收」；开放 string 供阶段表插节点）。 */
  fromPhaseTitle: string
  /** 契约入口文件（运行方式行；缺省省略该段）。 */
  entryFile?: string
  /** DELIVERY.md 摘要（调用方截取；缺省只提示位置）。 */
  deliveryDigest?: string
  /** 驱动场景统计（verify 推进腿 result.driverReport 可得）。 */
  driverSummary?: { passed: number; total: number }
  /** 程序截图路径清单（刀3 呈现层产物；缺省不出该行）。 */
  screenshotPaths?: string[]
  /** MVP 确认门通过后的交付（2026-10-04 确认门新规）：首行话术改为「已按你的确认交付」，
   *  不再自称「无需人工确认」（longterm 交付前过目是拍板的确认门）。 */
  viaMvpConfirm?: boolean
  coreScope?: string[]
}

/** delivered 交付通知卡：验收结论 + 运行方式 + 修改出口（不阻塞不等待）。 */
export function buildDeliveredNoticeCard(input: DeliveredNoticeInput): string {
  const lines: string[] = []
  lines.push(
    input.viaMvpConfirm
      ? `【交付完成】「${input.projectName}」已按你的确认正式交付（来源阶段：${input.fromPhaseTitle}）。`
      : `【交付完成】「${input.projectName}」已通过本次核心功能检查。验证范围和限制见交付记录。`,
  )
  if (input.driverSummary) {
    lines.push(`业务驱动：${input.driverSummary.passed}/${input.driverSummary.total} PASS（平台执行回读，范围以对应场景为准）。`)
  }
  if (input.coreScope?.length) lines.push(`本次宿主验证范围：${input.coreScope.join('；')}。`)
  const runParts: string[] = []
  if (input.entryFile) runParts.push(`程序入口：${input.entryFile}`)
  runParts.push('运行方式与依赖：项目根 DELIVERY.md')
  lines.push(`怎么运行：${runParts.join('；')}。`)
  if (input.deliveryDigest) {
    lines.push(`实现者交付说明（能力以宿主验证记录为准）：\n${input.deliveryDigest}`)
  }
  if (input.screenshotPaths && input.screenshotPaths.length > 0) {
    lines.push(`程序截图（${input.screenshotPaths.length} 张，见产物预览区）：${input.screenshotPaths.join('、')}`)
  }
  lines.push('不满意？直接回复要改的地方（例如「把倒计时改成进度条」），我会按你的意见迭代，不用从头再来。')
  return lines.join('\n')
}

/** blocked 人工介入卡输入。 */
export interface BlockedNoticeInput {
  /** 阶段标题（人话展示用）。 */
  phaseTitle: string
  /** 出了什么事（一句话人话总结；证据详情由调用方拼）。 */
  whatHappened: string
  /** 证据（最新 stderr 摘要/拒收教育关键行；可空）。 */
  evidence?: string
}

/** blocked 人工介入卡：发生了什么 + 两个选项（继续重试 / 直接给修改意见）。 */
export function buildBlockedNoticeCard(input: BlockedNoticeInput): string {
  const lines: string[] = []
  lines.push(`【已暂停，需要你拿主意】${input.whatHappened}`)
  if (input.evidence) {
    lines.push(`最新证据：${input.evidence}`)
  }
  lines.push('你可以：')
  lines.push('1. 回复「继续」——让它按上述原因再试一轮；')
  lines.push('2. 直接回复修改意见或处理方式（说明一句话即可，不需要点任何按钮）。')
  return lines.join('\n')
}

/** DELIVERY.md → 摘要文本（首 6 个非空行，每行截 120 字；调用方传文件全文）。 */
export function digestDeliveryDoc(content: string, maxLines = 6): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .slice(0, maxLines)
    .map((line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line))
  return lines.join('\n')
}

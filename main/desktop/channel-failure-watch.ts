/**
 * 渠道故障侦测与人话卡（刀5，2026-10-02 确认协议与呈现层战役——最小版）。
 *
 * 事故背书（2026-10-02 狗粮夜）：委派子会话因渠道 429/401 连续失败，用户无感知
 * 盲试 5 次——错误细节在事件流/遥测里，用户视角只有「没反应」。
 *
 * 机制（P1 最小版，完整让步链/autofix 挂账排后）：
 * - 侦测点：desktop-route 的事件转发处过滤 delegation_failed（payload 附 error 摘要
 *   与覆盖渠道名，agent-collaboration 刀5 扩展）；
 * - 归因：错误文本 → 故障签名（限流/鉴权/其他），同签名连续 2 次（10 分钟窗口）
 *   → 人话卡；不同签名重置计数（新故障另算）；
 * - 出路：人话卡引导「设置 → 模型渠道」检查（渠道列表三态点同刀5 落地），修复后
 *   回复「继续」放行——与刀1 的 blocked/继续词协议闭环。
 */

/** 故障签名（人话归类）。 */
export type ChannelFailureKind = 'rate-limited' | 'auth-failed' | 'other'

/** 归一化错误文本 → 签名（大小写不敏感；按限流/鉴权优先序匹配）。 */
export function classifyChannelFailure(errorText: string): ChannelFailureKind {
  const text = errorText.toLowerCase()
  if (/(^|\D)429|rate.?limit|too many requests|quota/.test(text)) return 'rate-limited'
  if (/(^|\D)40[13]|unauthorized|forbidden|invalid.*api.?key|api.?key.*invalid|authentication/.test(text)) return 'auth-failed'
  return 'other'
}

/** 项目级侦测状态（desktop-route 持有；进程内生命周期与拒收账本一致）。 */
export interface ChannelFailureTracker {
  /** 最近一次失败的签名（换签名即重置计数）。 */
  lastKind: ChannelFailureKind | undefined
  /** 同签名连续失败计数。 */
  consecutive: number
  /** 最近一次计数推进时间（窗口判断）。 */
  lastAt: number
  /** 同签名已出卡（防重复刷屏；窗口过后或换签名重置）。 */
  notified: boolean
}

export function createChannelFailureTracker(): ChannelFailureTracker {
  return { lastKind: undefined, consecutive: 0, lastAt: 0, notified: false }
}

/** Host admission failures never establish a provider outage or a bad API key. */
export function localExecutionStopNotice(error: string): string | undefined {
  if (/\bHARNESS_NO_PROGRESS\b/.test(error)) return '执行者持续读取但没有完成修改或验证，已停止本轮空转。已有文件和失败记录保留，可按具体缺口继续。'
  if (/\bHARNESS_DEADLINE_EXCEEDED\b/.test(error)) return '本阶段运行时限已到，已停止继续执行。已有文件和验证记录保留，可核对具体缺口后继续。'
  if (/\b(?:REQUEST_BUDGET_EXHAUSTED|MONETARY_BUDGET_EXHAUSTED|MONETARY_OPERATION_EXHAUSTED|HARNESS_REQUEST_BUDGET_EXHAUSTED|HARNESS_OUTPUT_BUDGET_EXHAUSTED)\b/.test(error)) {
    return '本轮模型调用次数、输出或金额预算已用完，当前阶段和产物已保留。请核对本地执行预算后再继续。'
  }
  if (/\b(?:MONETARY_[A-Z_]+|HARNESS_[A-Z_]+|REQUEST_OUTPUT_LIMIT)\b/.test(error)) {
    return '本地模型调用策略未通过校验，本次调用未放行。请核对执行策略；当前进度已保留。'
  }
  if (/\bEXPERIMENT_[A-Z_]*(?:BUDGET|DEADLINE|ATTEMPT)[A-Z_]*\b/.test(error)) {
    return '本轮实验执行额度或时限已到，当前进度已保留。请核对实验执行策略后再继续。'
  }
}

/** 连续失败出卡阈值（2 次：一次可能是偶发，两次即系统性）。 */
export const CHANNEL_FAILURE_NOTIFY_THRESHOLD = 2

/** 同签名计数窗口：超窗重置（间歇性故障不累积误报）。 */
const FAILURE_WINDOW_MS = 10 * 60 * 1000

export interface ChannelFailureObservation {
  /** true = 应出人话卡（card 为文案）。 */
  notify: boolean
  card?: string
}

const KIND_LABEL: Record<ChannelFailureKind, string> = {
  'rate-limited': '请求被限流（429/配额）',
  'auth-failed': '鉴权失败（401/API Key 无效）',
  other: '连接/服务异常',
}

/**
 * 观察一次委派失败（纯函数式状态推进；调用方在 delegation_failed 事件处调用）。
 * 窗口外或换签名 → 重置计数；同签名连续达阈值且未出卡 → 出卡一次。
 */
export function observeChannelFailure(
  tracker: ChannelFailureTracker,
  input: { error?: string; channel?: string; at?: number },
): ChannelFailureObservation {
  if (localExecutionStopNotice(input.error ?? '')) {
    Object.assign(tracker, createChannelFailureTracker())
    return { notify: false }
  }
  const kind = classifyChannelFailure(input.error ?? '')
  const now = input.at ?? Date.now()
  if (tracker.lastKind !== kind || now - tracker.lastAt > FAILURE_WINDOW_MS) {
    tracker.lastKind = kind
    tracker.consecutive = 0
    tracker.notified = false
  }
  tracker.consecutive += 1
  tracker.lastAt = now
  if (tracker.consecutive < CHANNEL_FAILURE_NOTIFY_THRESHOLD || tracker.notified) {
    return { notify: false }
  }
  tracker.notified = true
  return { notify: true, card: buildChannelFailureCard({ kind, channel: input.channel, count: tracker.consecutive, error: input.error }) }
}

/** 渠道故障人话卡（notice-cards 同风格：出了什么事/建议怎么做/如何恢复）。 */
export function buildChannelFailureCard(input: { kind: ChannelFailureKind; channel?: string; count: number; error?: string }): string {
  const channelNote = input.channel ? `「${input.channel}」渠道` : '当前模型渠道'
  const lines: string[] = [
    `【渠道疑似故障】委派已连续 ${input.count} 次失败（${channelNote}${KIND_LABEL[input.kind]}）——继续重试大概率还是失败，先别硬试。`,
  ]
  if (input.error) {
    lines.push(`错误摘要：${input.error.slice(0, 160)}`)
  }
  lines.push('建议：打开「设置 → 模型渠道」，找到对应渠道点「测试」确认状态；鉴权失败就更新 API Key，限流就等一会儿或切换备用渠道。')
  lines.push('处理完成后回复「继续」，我会从当前阶段接着跑（进度不会丢）。')
  return lines.join('\n')
}

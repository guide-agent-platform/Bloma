/**
 * SteerQueue（P0-1 运行中转向，2026-09-08 pi 差距方案 §1）——run 中用户输入通道。
 *
 * 背景：runAgentLoop 内 messages 只从 task + tool_result + 退行反馈 + 压缩重置增长，
 * 无运行中用户输入通道；SessionMessageQueue 是 run 间排队（生成期间消息只能干等）。
 * 本模块补「长任务进行中可转向」：主 loop（delegationDepth 0）在工具批间 drain，
 * 注入内容以 `【用户中途补充】` 包裹进 messages + JSONL（同 DEGENERATE_RETRY_FEEDBACK
 * 的 user 轮注入先例，JSONL 审计与 continue 重放天然一致）。
 *
 * 开放面只覆盖「活跃主 loop」的会话：
 * - `markLoopActive`/`markLoopInactive` 由 runAgentLoop 收尾调用（wrapper try/finally）；
 * - guide 对话 run（runAgent 单发、无 loop）与委派子会话（depth ≥ 1）**不注册**——
 *   它们的 steer 请求由 IPC 层判 isSteerableSession=false 后回退 runAgent
 *   （忙则入 SessionMessageQueue，run 间排队语义不变，不重复造 followUp）。
 *
 * 语义（对齐 message-queue P2-④「停止后不留 limbo」）：
 * - abort/停止 → cancelAgent 调 clearSteerQueue，队列清空（I3 on 时未注入条目标 rejected）；
 * - loop 自然收尾时未及注入的残余（终轮模型调用期间入队）由 runAgentLoop finally
 *   drain 落 JSONL 保真（内容不丢，并入对话历史），abort 后的残余丢弃。
 *
 * I3 转向生效确认链（Phase 7 P7-7，2026-09-11，实施稿 §3；BLOMA_STEER_CONFIRM 缺省 off
 * =字节级现状）：SteerEntry 增状态机 received → pending_impact → merged_this_run |
 * deferred_next_run | rejected。影响三档确定性关键词分级（宁低勿高）：低=简短确认即注入；
 * 中=影响卡三选[本轮就改/本轮完成后再改/不改了]；高档 v0 建议「停止本轮」承接（§8 拍板），
 * 用户仍可选降档注入。**merged_this_run 只由 agent-loop 批间注入完成事件推进**（markSteerMerged
 * 唯一入口）——「已纳入本轮」不以对话层宣布为准。deferred 形成可见待办（渲染端状态条常驻，
 * 交付后再确认）。状态变化经 statusListener 回调上报（ipc 层接线→steer_status 事件）。
 *
 * 纯内存 Map + Set（单测友好：enqueue/drain/clear/mark/resolve 全部同步，无 IO）。
 */

import type { SteerImpact, SteerStatus } from '../shared/types'

/** 注入内容的包裹前缀：模型据此识别「用户中途补充」的优先级语义（测试与 JSONL 识别用）。 */
export const STEER_WRAP_PREFIX = '【用户中途补充】'

/** 内容包裹：`【用户中途补充】` + 原文。 */
export function wrapSteerContent(content: string): string {
  return `${STEER_WRAP_PREFIX}${content}`
}

/** I3 开关（缺省 off=字节级现状：无分级、无账本、无状态事件，enqueue 即注入与 P0-1 完全一致）。 */
export function steerConfirmEnabled(): boolean {
  return process.env.BLOMA_STEER_CONFIRM === '1' || process.env.BLOMA_STEER_CONFIRM === 'true'
}

/** 一条待注入的 steer。 */
export interface SteerEntry {
  /** request_id 复用为队列消息 id（与 SessionMessageQueue.queueMessageId 同角色，去重/审计用） */
  queueMessageId: string
  content: string
  enqueuedAt: number
  /** I3：账本关联 id（on 时由 registerSteer 生成=queueMessageId；off 时缺省，行为零变化） */
  steerId?: string
}

/** I3 状态账本条目（会话级；merged/rejected 保留至查询，deferred 常驻可见待办）。 */
export interface SteerLedgerEntry {
  steerId: string
  sessionId: string
  projectId?: string
  content: string
  impact: SteerImpact
  status: SteerStatus
  receivedAt: number
  /** 状态最后推进时间 */
  updatedAt: number
}

/** 会话 → 待注入 steer 队列（保序 FIFO）。 */
const steerQueues = new Map<string, SteerEntry[]>()

/** I3：会话 → steer 状态账本（含已注入/待办/未采用；注入完成不删除）。 */
const steerLedger = new Map<string, SteerLedgerEntry[]>()

/**
 * 有活跃主 loop（delegationDepth 0 的 runAgentLoop）的会话集合。
 * runAgentLoop wrapper 在进入时 mark、finally 时 unmark（见 agent-loop.ts）。
 */
const loopActiveSessions = new Set<string>()

/** runAgentLoop wrapper 进入时调用（仅 delegationDepth 0；子会话不开放 steer）。 */
export function markLoopActive(sessionId: string): void {
  loopActiveSessions.add(sessionId)
}

/** runAgentLoop wrapper finally 调用（与 drain 同处同步执行，无中间态竞态）。 */
export function markLoopInactive(sessionId: string): void {
  loopActiveSessions.delete(sessionId)
}

/** 会话是否有活跃主 loop（steer 开放面判定；IPC 层据此决定入队或回退 runAgent）。 */
export function isSteerableSession(sessionId: string): boolean {
  return loopActiveSessions.has(sessionId)
}

/**
 * 入队一条 steer。返回 false = 会话无活跃主 loop（调用方应回退正常 send-message 语义）。
 * 判定与入队在同步块内完成（单线程事件循环无中间态）；request_id 去重防双击。
 */
export function enqueueSteer(sessionId: string, entry: SteerEntry): boolean {
  if (!loopActiveSessions.has(sessionId)) return false
  const queue = steerQueues.get(sessionId) ?? []
  if (queue.some((item) => item.queueMessageId === entry.queueMessageId)) return true
  queue.push(entry)
  steerQueues.set(sessionId, queue)
  return true
}

/**
 * 取走该会话全部待注入 steer（保序）。批间注入单点 drain 无并发：
 * 同一次取走在同步块内完成，返回后调用方顺序落 JSONL + push messages。
 */
export function drainSteerQueue(sessionId: string): SteerEntry[] {
  const queue = steerQueues.get(sessionId)
  if (!queue || queue.length === 0) return []
  steerQueues.delete(sessionId)
  return queue
}

/** 清空会话待注入队列（abort/停止时调用；与 message-queue P2-④「停止后不留 limbo」对齐）。 */
export function clearSteerQueue(sessionId: string): void {
  steerQueues.delete(sessionId)
}

/** 待注入条数（IPC 结果 pending 字段 / 测试断言用）。 */
export function pendingSteerCount(sessionId: string): number {
  return steerQueues.get(sessionId)?.length ?? 0
}

/** 测试 seam：清空全部状态，保证用例间不串扰。 */
export function resetSteerQueuesForTests(): void {
  steerQueues.clear()
  loopActiveSessions.clear()
  steerLedger.clear()
  statusListener = undefined
}

// ==================== I3 转向生效确认链（Phase 7 P7-7） ====================

/** 状态变化上报回调（生产接线：ipc 层→steer_status 事件；单测可注入 spy）。 */
export type SteerStatusListener = (change: SteerLedgerEntry) => void

let statusListener: SteerStatusListener | undefined

/** 接线状态监听（ipc 模块加载时一次）。传 undefined 解除。 */
export function setSteerStatusListener(listener: SteerStatusListener | undefined): void {
  statusListener = listener
}

/** 账本写入并上报（模块内唯一状态推进出口；直接改 entry 字段后调用）。 */
function advance(entry: SteerLedgerEntry, status: SteerStatus): SteerLedgerEntry {
  entry.status = status
  entry.updatedAt = Date.now()
  const list = steerLedger.get(entry.sessionId) ?? []
  if (!list.some((item) => item.steerId === entry.steerId)) list.push(entry)
  steerLedger.set(entry.sessionId, list)
  if (statusListener) {
    try {
      statusListener(entry)
    } catch {
      // 上报故障不阻断状态机（降级链铁律，对齐 agent-event-bus）
    }
  }
  return entry
}

/** 高档信号（核心目标/数据模型转向）：窄表从严——误判高会拦住用户，宁可漏判。 */
const STEER_IMPACT_HIGH_PATTERNS: RegExp[] = [
  /不要这[个款种种项]/,
  /别做这[个款种种项]/,
  /不做这[个款种种项]/,
  /换[个一][方向思路方案目标]/,
  /重新设计/,
  /推翻/,
  /[全部整体从头][重来重做过]/,
  /换个应用/,
  /换一个应用/,
  /改成另[外一]?[个种款]应用/,
  /不是这[个款种]应用/,
  /数据[结构模型]/,
  /存储[方案结构设计]/,
  /[换改]成?另外?(一)?套?(架构|数据库)/,
]

/** 中档信号（新功能/改流程结构）：新功能、新页面/模块、流程/步骤重排。 */
const STEER_IMPACT_MEDIUM_PATTERNS: RegExp[] = [
  /[加增][一]?[个条项种块页]/,
  /新增/,
  /还要|也要|再加|再多|顺便[加做弄]/,
  /新功能/,
  /加[功能页面模块]/,
  /流程[改换调变重排]/,
  /步骤[改换调变重排]/,
  /[改换]成?另?[外一]?[种套个]?(流程|方式|交互|结构|顺序)/,
  /先做另?外?一?[个件]|先做其他/, // 流程重排：优先级变更信号
]

/** 低档信号（文案颜色类微调）：仅用于文档语义说明——低档是兑底档，未命中高中即低。 */
export function classifySteerImpact(content: string): SteerImpact {
  if (STEER_IMPACT_HIGH_PATTERNS.some((re) => re.test(content))) return 'high'
  if (STEER_IMPACT_MEDIUM_PATTERNS.some((re) => re.test(content))) return 'medium'
  return 'low'
}

/** IPC 入口（on 时）：登记 steer 并按档位分流。低档→received（直接入注入队列，简短确认
 *  即注入）；中/高档→pending_impact（不入队，等影响卡三选回执）。返回登记结果；
 *  会话无活跃主 loop 时返回 undefined（调用方回退 runAgent，不登记）。 */
export function registerSteer(
  sessionId: string,
  entry: SteerEntry,
  projectId?: string,
): SteerLedgerEntry | undefined {
  if (!loopActiveSessions.has(sessionId)) return undefined
  const steerId = entry.steerId ?? entry.queueMessageId
  const ledgerEntry: SteerLedgerEntry = {
    steerId,
    sessionId,
    projectId,
    content: entry.content,
    impact: classifySteerImpact(entry.content),
    status: 'received',
    receivedAt: Date.now(),
    updatedAt: Date.now(),
  }
  const existing = (steerLedger.get(sessionId) ?? []).find((item) => item.steerId === steerId)
  if (existing) return existing // 双击去重（与 enqueueSteer 同口径）
  if (ledgerEntry.impact === 'low') {
    // 低档：简短确认即注入——入队后状态 received（注入完成时推进 merged）
    enqueueSteer(sessionId, { ...entry, steerId })
    return advance(ledgerEntry, 'received')
  }
  // 中/高档：待确认——不入注入队列，等 resolveSteer 三选
  return advance(ledgerEntry, 'pending_impact')
}

/** 影响卡三选回执：inject_now=本轮就改（入队，received）；defer=本轮完成后再改
 *  （deferred_next_run，可见待办）；reject=不改了（rejected）。只对 pending_impact
 *  状态有效（重复/非法回执返回 undefined）。 */
export function resolveSteer(
  sessionId: string,
  steerId: string,
  action: 'inject_now' | 'defer' | 'reject',
): SteerLedgerEntry | undefined {
  const entry = (steerLedger.get(sessionId) ?? []).find((item) => item.steerId === steerId)
  if (!entry || entry.status !== 'pending_impact') return undefined
  if (action === 'inject_now') {
    // 用户确认本轮就改（高档「仍要本轮注入」同通道）→入队。loop 已自然收尾时
    // 不再入队（入了也无人消费）：如实转「留待下一轮」，不静默失效。
    if (loopActiveSessions.has(sessionId)) {
      enqueueSteer(sessionId, {
        queueMessageId: entry.steerId,
        content: entry.content,
        enqueuedAt: Date.now(),
        steerId: entry.steerId,
      })
      return advance(entry, 'received')
    }
    return advance(entry, 'deferred_next_run')
  }
  if (action === 'defer') return advance(entry, 'deferred_next_run')
  return advance(entry, 'rejected')
}

/** 注入完成推进（agent-loop 批间注入点调用）——**merged_this_run 的唯一入口**：
 *  「已纳入本轮」以注入完成事件为准，不由对话层单方面宣布（off 时 steerId 缺省不调）。 */
export function markSteerMerged(sessionId: string, steerId: string): void {
  const entry = (steerLedger.get(sessionId) ?? []).find((item) => item.steerId === steerId)
  if (!entry) return
  // 只允许「已入队待注入」推进到已纳入——deferred/rejected 等终态不可被覆盖
  //（「已纳入本轮」只来自注入完成事实，不由其他路径宣布；幂等含 merged 二次推进）
  if (entry.status !== 'received') return
  advance(entry, 'merged_this_run')
}

/** runAgentLoop finally 残余收口（on 时）：loop 自然收尾时未及批间注入的残余——内容
 *  已落 JSONL 并入历史（下一 run 可见），如实标「留待下一轮」；abort 残余（丢弃路径）
 *  标 rejected。只对未终结状态（received/pending_impact）生效。 */
export function settleSteerEntry(
  sessionId: string,
  steerId: string,
  terminal: 'deferred_next_run' | 'rejected',
): void {
  const entry = (steerLedger.get(sessionId) ?? []).find((item) => item.steerId === steerId)
  if (!entry) return
  if (entry.status !== 'received' && entry.status !== 'pending_impact') return
  advance(entry, terminal)
}

/** 停止/取消路径（cancelAgent→clearSteerQueue 前调用，on 时）：把账本中未注入条目
 *  （received/pending_impact）标 rejected——渲染端状态条如实翻转「未采用·本轮已停止」，
 *  不再静默消失。返回被拒条目（deferred/merged 不动）。 */
export function rejectPendingSteer(sessionId: string): SteerLedgerEntry[] {
  const list = steerLedger.get(sessionId) ?? []
  const rejected: SteerLedgerEntry[] = []
  for (const entry of list) {
    if (entry.status === 'received' || entry.status === 'pending_impact') {
      advance(entry, 'rejected')
      rejected.push(entry)
    }
  }
  return rejected
}

/** 会话 steer 状态查询（渲染端刷新恢复 + 「这轮会做吗」的权威答案源）：
 *  merged_this_run=会；received=会（已入队待注入）；pending_impact=待你确认；
 *  deferred_next_run=下一轮；rejected=不会。v0 条目随会话常驻不跨轮清扫
 *  （同会话 steer 量级个位数；「本轮」以最近一次注入为准，观察项登记开关矩阵）。 */
export function getSteerStatuses(sessionId: string): SteerLedgerEntry[] {
  return (steerLedger.get(sessionId) ?? []).map((item) => ({ ...item }))
}

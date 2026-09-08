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
 * - abort/停止 → cancelAgent 调 clearSteerQueue，队列清空；
 * - loop 自然收尾时未及注入的残余（终轮模型调用期间入队）由 runAgentLoop finally
 *   drain 落 JSONL 保真（内容不丢，并入对话历史），abort 后的残余丢弃。
 *
 * 纯内存 Map + Set（单测友好：enqueue/drain/clear/mark 全部同步，无 IO）。
 */

/** 注入内容的包裹前缀：模型据此识别「用户中途补充」的优先级语义（测试与 JSONL 识别用）。 */
export const STEER_WRAP_PREFIX = '【用户中途补充】'

/** 内容包裹：`【用户中途补充】` + 原文。 */
export function wrapSteerContent(content: string): string {
  return `${STEER_WRAP_PREFIX}${content}`
}

/** 一条待注入的 steer。 */
export interface SteerEntry {
  /** request_id 复用为队列消息 id（与 SessionMessageQueue.queueMessageId 同角色，去重/审计用） */
  queueMessageId: string
  content: string
  enqueuedAt: number
}

/** 会话 → 待注入 steer 队列（保序 FIFO）。 */
const steerQueues = new Map<string, SteerEntry[]>()

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
}

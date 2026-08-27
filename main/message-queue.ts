// ============================================================
// 会话消息队列（从 Proma v0.18.2 AgentQueueCoordinator 精简移植）
// 来源：Proma apps/electron/src/main/lib/agent-queue-coordinator.ts（119 行）
//      + agent-send-message-policy.ts（17 行，shouldPersistInitialUserMessage）
// 蓝本提交：92a635fa（2026-08-26）；移植日期：2026-08-27
// 增强方案：.context/enhancements/message-queue-port.md（P1）
//
// 解决的问题：runAgent 对活跃会话硬拒 AGENT_SESSION_BUSY、消息直接丢弃（用户
// 在 AI 生成十几秒里打的字要重打）。本队列让生成期间的消息排队，run 完成后
// 自动派发——对齐 ChatGPT/Claude 的自然交互。
//
// 精简决策：不需要 move/reorder（Proma 有）；保留 enqueue 去重 / tryDispatch
// 双门（active+dispatching）/ stoppedByUser 不自动派发 / 抛错 finally 兜底。
// 队列是内存态（对齐 Proma）：应用重启丢队列，v1 可接受。
// ============================================================

export interface QueueEntry {
  queueMessageId: string
  userMessage: string
  startedAt?: number
  /** 派发时重建 run 的完整输入（message-queue 2026-08-27：由接入方注入，避免类型断言走私） */
  input?: unknown
}

export interface QueueCoordinatorOptions {
  /** 会话是否有活跃 run（对应 orchestrator.activeSessions.has） */
  isActive: (sessionId: string) => boolean
  /** 派发即启动 run（对应 runAgent 成功路径） */
  startRun: (sessionId: string, entry: QueueEntry) => Promise<void>
  /** 通知渲染端某条排队消息已开始（经既有 AGENT_STREAM_EVENT 广播 queued_started） */
  onDispatched?: (sessionId: string, entry: QueueEntry) => void
}

export class SessionMessageQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, string>()
  private readonly options: QueueCoordinatorOptions

  constructor(options: QueueCoordinatorOptions) {
    this.options = options
  }

  /** 入队（queueMessageId 去重，对齐 Proma enqueue；防双击决策卡） */
  enqueue(sessionId: string, entry: QueueEntry): void {
    const queue = this.queues.get(sessionId) ?? []
    if (queue.some((e) => e.queueMessageId === entry.queueMessageId)) return
    queue.push(entry)
    this.queues.set(sessionId, queue)
    this.tryDispatch(sessionId)
  }

  /** 取消一条排队消息（用户撤回：排队中仅 UI 投影，撤回后历史干净） */
  cancel(sessionId: string, messageId: string): boolean {
    const queue = this.queues.get(sessionId)
    if (!queue) return false
    const index = queue.findIndex((e) => e.queueMessageId === messageId)
    if (index < 0) return false
    queue.splice(index, 1)
    if (queue.length === 0) this.queues.delete(sessionId)
    return true
  }

  /** 清空会话全部排队消息（审查 P2-④：用户停止时调用，避免排队消息永久 limbo） */
  clear(sessionId: string): void {
    this.queues.delete(sessionId)
  }

  /**
   * run 结束回调（对齐 Proma onRunComplete）：
   * 用户主动停止 → 不自动派发（防止停止后被排队的消息立刻又跑起来，违背「停止」意图）；
   * 后台任务未完 → 等待 onBackgroundTaskComplete（Bloma 无此概念，裁剪）。
   */
  onRunComplete(sessionId: string, queueMessageId: string | undefined, stoppedByUser: boolean): void {
    if (queueMessageId && this.dispatching.get(sessionId) === queueMessageId) {
      this.dispatching.delete(sessionId)
    }
    if (stoppedByUser) return
    this.tryDispatch(sessionId)
  }

  hasPending(sessionId: string): boolean {
    return this.dispatching.has(sessionId) || (this.queues.get(sessionId)?.length ?? 0) > 0
  }

  pendingCount(sessionId: string): number {
    return (this.queues.get(sessionId)?.length ?? 0) + (this.dispatching.has(sessionId) ? 1 : 0)
  }

  private tryDispatch(sessionId: string): void {
    if (this.dispatching.has(sessionId) || this.options.isActive(sessionId)) return
    const queue = this.queues.get(sessionId)
    const entry = queue?.shift()
    if (!entry) return
    if (queue && queue.length === 0) this.queues.delete(sessionId)
    this.dispatching.set(sessionId, entry.queueMessageId)
    this.options.onDispatched?.(sessionId, entry)
    // 移植改进（对齐 Bloma 现状）：防御性吞掉意外 rejection，避免队列逻辑把 main 带崩
    // （Proma 原版 void startRun().finally() 在 startRun 拒绝时产生未处理 rejection）。
    void this.options
      .startRun(sessionId, entry)
      .catch(() => {})
      .finally(() => {
        if (this.dispatching.get(sessionId) === entry.queueMessageId) {
          this.dispatching.delete(sessionId)
        }
      })
  }
}

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
  /** 派发失败安全网放弃钩子（queue-dispatch-requeue r68）：超重入上限/非可重入错误时回调，
   *  接渲染端排队气泡变「发送失败可重试」（比静默好）；未传则静默（v1 语义） */
  onDropped?: (sessionId: string, entry: QueueEntry, reason: 'max-requeue' | 'non-requeueable') => void
}

/** 重入上限（queue-dispatch-requeue r68）：防 BUSY 永错毒消息无限循环 */
const MAX_REQUEUES = 2

/**
 * 派发可重入错误分类（Proma isStaleActiveQueueError 的 Bloma 化，r68）：
 * 忙/陈旧类错误（AGENT_SESSION_BUSY 码或文案、会话未运行）→ 可回队首重试；
 * 其他错误（TypeError 等 bug 信号）→ 不重试（防毒消息循环，维持 v1 吞掉语义）。
 */
export function isRequeueableDispatchError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  const code = (error as { code?: string } | null)?.code
  return (
    code === 'AGENT_SESSION_BUSY' ||
    code === 'agent.query.not_active' ||
    msg.includes('AGENT_SESSION_BUSY') ||
    msg.includes('会话未运行，无法追加消息')
  )
}

export class SessionMessageQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly dispatching = new Map<string, string>()
  /** 重入计数（按 queueMessageId）：成功派发后清零（审计②） */
  private readonly requeues = new Map<string, number>()
  /**
   * 停止抑制集（queue-dispatch-requeue r68 审查收敛，deepseek P1）：
   * 用户停止（stoppedByUser）后，在途 startRun 的 reject 才落地会把消息塞回队列并重入派发——
   * 违背停止意图。抑制集挡住 tryDispatch；用户显式 enqueue（新消息）解除。
   */
  private readonly stopped = new Set<string>()
  private readonly options: QueueCoordinatorOptions

  constructor(options: QueueCoordinatorOptions) {
    this.options = options
  }

  /** 入队（queueMessageId 去重，对齐 Proma enqueue；防双击决策卡） */
  enqueue(sessionId: string, entry: QueueEntry): void {
    this.stopped.delete(sessionId) // 用户显式发新消息 = 意图恢复，解除停止抑制（019）
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
    if (stoppedByUser) {
      // 停止抑制（r68 deepseek P1）：在途 reject 落地后不得自动重派发——018 锁定
      this.stopped.add(sessionId)
      return
    }
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
    if (this.stopped.has(sessionId)) return // 停止抑制：自动派发一律不执行（018）
    const queue = this.queues.get(sessionId)
    const entry = queue?.shift()
    if (!entry) return
    if (queue && queue.length === 0) this.queues.delete(sessionId)
    this.dispatching.set(sessionId, entry.queueMessageId)
    this.options.onDispatched?.(sessionId, entry)
    // 派发失败安全网（queue-dispatch-requeue r68，蓝本 Proma isStaleActiveQueueError）：
    // 竞态（派发瞬间会话转活跃→BUSY）时 entry 已出队，静默吞=消息凭空消失——
    // 忙/陈旧错误回队首（保序）重试，上限 MAX_REQUEUES 防毒消息循环；其余维持吞掉（v1 语义）。
    // 关键语义：仅「派发失败（reject）」才在 finally 重入试派；run 正常完成（resolve）的重试
    // 交给 onRunComplete——否则安全网会抢在 stoppedByUser 判定之前把排队消息发出去（违背停止意图）。
    let rejected = false
    void this.options
      .startRun(sessionId, entry)
      .then(() => {
        this.requeues.delete(entry.queueMessageId) // 成功后清零（审计②：计数不跨周期残留）
      })
      .catch((err: unknown) => {
        rejected = true
        // 停止抑制：用户已停止（clear 语义已表达放弃），reject 落地不得把消息塞回队列（018）
        if (this.stopped.has(sessionId)) {
          this.requeues.delete(entry.queueMessageId)
          return
        }
        if (isRequeueableDispatchError(err) && (this.requeues.get(entry.queueMessageId) ?? 0) < MAX_REQUEUES) {
          this.requeues.set(entry.queueMessageId, (this.requeues.get(entry.queueMessageId) ?? 0) + 1)
          // 插回队首（保序）：重入后 A 仍先于后入队的 B
          this.queues.set(sessionId, [entry, ...(this.queues.get(sessionId) ?? [])])
        } else {
          this.requeues.delete(entry.queueMessageId)
          this.options.onDropped?.(sessionId, entry, isRequeueableDispatchError(err) ? 'max-requeue' : 'non-requeueable')
        }
      })
      .finally(() => {
        if (this.dispatching.get(sessionId) === entry.queueMessageId) {
          this.dispatching.delete(sessionId)
        }
        if (rejected) this.tryDispatch(sessionId) // 仅派发失败重入；成功路径的重试归 onRunComplete
      })
  }
}

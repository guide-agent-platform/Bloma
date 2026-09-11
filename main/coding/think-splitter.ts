/**
 * 流式 <think> 标签拆块（2026-09-11 交付话术改造）。
 *
 * 背景：部分思考型渠道（DeepSeek/GLM 系）在 thinking 档位下把推理包在
 * <think>...</think> 里混进 text_delta 正文通道——此前这些推理直接流进旁白正文，
 * 用户在聊天里看到大段"思考腔"独白（2026-08-28 flash 模型 28k 英文独白线上案例同源）。
 *
 * 语义对齐 Proma packages/session-core/src/thinking-tags.ts 的
 * parseThinkTagsFromText：未闭合的 <think> 按思考块处理，闭合标签到达后自然拆出
 * 后续正文；大小写不敏感。差异：这里是流式状态机——标签可能被增量切断
 * （"</th" + "ink>"），需要跨增量缓冲 pending 尾部，end() 冲收。
 *
 * 纯模块、无 IO：主进程 agent-loop 流处理消费，单测直接覆盖。
 */

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'

export interface ThinkSplitResult {
  /** 本增量里的旁白正文片段（按序） */
  narration: string[]
  /** 本增量里的思考片段（按序） */
  thinking: string[]
}

/**
 * 创建流式 <think> 拆块器。push() 逐增量喂入 text_delta 文本，返回本增量拆出的
 * 旁白与思考片段；end() 冲收缓冲（流结束时调用一次，此后 push 无效）。
 */
export function createThinkStreamSplitter(): {
  push: (delta: string) => ThinkSplitResult
  end: () => ThinkSplitResult
} {
  let inThink = false
  let pending = ''

  const scan = (flush: boolean): ThinkSplitResult => {
    const narration: string[] = []
    const thinking: string[] = []
    let cursor = 0
    const lower = pending.toLowerCase()

    while (cursor < pending.length) {
      if (inThink) {
        const close = lower.indexOf(THINK_CLOSE, cursor)
        if (close === -1) {
          // 没有完整闭合标签：只从最后一个 '</' 起扣住（可能是被切断的闭合标签前缀），
          // 其余照常放行——避免无条件扣尾造成正文延迟
          const closeStart = pending.lastIndexOf('</')
          const safeEnd = !flush && closeStart >= cursor ? closeStart : pending.length
          if (safeEnd > cursor) thinking.push(pending.slice(cursor, safeEnd))
          cursor = safeEnd
          break
        }
        if (close > cursor) thinking.push(pending.slice(cursor, close))
        cursor = close + THINK_CLOSE.length
        inThink = false
      } else {
        const open = lower.indexOf(THINK_OPEN, cursor)
        if (open === -1) {
          // 没有完整开标签：只从最后一个 '<' 起扣住（可能是被切断的 '<think>' 前缀）
          const lt = pending.lastIndexOf('<')
          const safeEnd = !flush && lt >= cursor ? lt : pending.length
          if (safeEnd > cursor) narration.push(pending.slice(cursor, safeEnd))
          cursor = safeEnd
          break
        }
        if (open > cursor) narration.push(pending.slice(cursor, open))
        cursor = open + THINK_OPEN.length
        inThink = true
      }
    }
    pending = pending.slice(cursor)
    return { narration, thinking }
  }

  return {
    push: (delta: string): ThinkSplitResult => {
      if (!delta) return { narration: [], thinking: [] }
      pending += delta
      return scan(false)
    },
    end: (): ThinkSplitResult => {
      if (!pending) return { narration: [], thinking: [] }
      return scan(true)
    },
  }
}

/**
 * R1-loop（2026-09-19 狗粮 7601e5ae）：DSML 工具协议残片的呈现层过滤器。
 *
 * 病灶：ds/deepseek-flash 在轮次预算耗尽（无 tools 收口调用）或长循环信道退化时，
 * 把工具调用意图以内部协议原文（`<｜｜DSML｜｜ calls>…`）写进正文——8 次全部经
 * message_delta 流式直通上屏（agent-loop 注释自认「旁白已上屏，恢复只影响模型侧
 * 历史」），用户看到成片英文协议残片混全角竖线。
 *
 * 口径：**只过滤呈现**（publish 出口），不改 assistantBlocks/textParts——JSONL 原文
 * 留档（D2 恢复与审计依赖原文）、模型侧历史不变。流式安全：标记可能跨增量分裂，
 * 用 holdback 状态机——可能是标记前缀的尾部增量先扣住，下一增量到达后再裁决；
 * 一旦完整开标记出现，其后整段视为协议残片抑制到底（狗粮 8 例实证：散文在前、
 * 残片收尾，标记之后不会再回正文），并只发一次占位说明。
 */

/** 开标记（全角竖线是 DeepSeek 内部协议的分隔符）。 */
const DSML_OPEN = '<｜｜DSML｜｜'
/** 占位说明（每轮至多一次）。 */
const DSML_PLACEHOLDER = '（检测到工具调用协议残片，已过滤；模型仍想调用工具——原文已留档，意图交由平台处置）'

export interface DsmlDisplayFilter {
  /** 推入一段原始增量，返回可安全上屏的增量（可能为空数组——被扣住或被抑制）。 */
  push(chunk: string): string[]
  /** 流结束：冲出被扣住的可疑前缀（若最终不是标记）。抑制态无残留。 */
  end(): string[]
}

export function createDsmlDisplayFilter(): DsmlDisplayFilter {
  let suppressed = false
  let placeholderEmitted = false
  let hold = ''

  /** 发占位（至多一次）。 */
  const placeholder = (): string[] => (placeholderEmitted ? [] : ((placeholderEmitted = true), [DSML_PLACEHOLDER]))

  const push = (chunk: string): string[] => {
    if (suppressed) return [] // 开标记之后的整段都是协议残片
    const buffer = hold + chunk
    hold = ''
    const hit = buffer.indexOf(DSML_OPEN)
    if (hit >= 0) {
      suppressed = true
      const before = buffer.slice(0, hit)
      return [...(before ? [before] : []), ...placeholder()]
    }
    // 无完整标记：扣住「仍可能是标记前缀」的最长尾部，其余放行
    const maxHold = Math.min(buffer.length, DSML_OPEN.length)
    let holdLen = 0
    for (let len = maxHold; len >= 1; len -= 1) {
      if (DSML_OPEN.startsWith(buffer.slice(buffer.length - len))) {
        holdLen = len
        break
      }
    }
    hold = buffer.slice(buffer.length - holdLen)
    const safe = buffer.slice(0, buffer.length - holdLen)
    return safe ? [safe] : []
  }

  const end = (): string[] => {
    const rest = hold
    hold = ''
    if (suppressed) return []
    return rest ? [rest] : []
  }

  return { push, end }
}

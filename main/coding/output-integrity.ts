/**
 * 输出完整性守卫（P0，2026-09-06「地牢清怪录」d066eb92 案）。
 *
 * Agent Loop 终轮以「零 tool_use」判定模型声明收工，该判定可被两种传输事故骗过：
 * ①渠道工具调用协议原文漏进正文（ds 渠道 `<｜｜DSML｜｜tool_calls>` 整段出现在
 * assistant 文本里，工具调用从未送达——模型想查的没查成，收工照判）；②采样退行
 * 重复（glm-5.3「查。×385」墙案）。两种情况下模型都没有真正交卷，却会被判
 * completed 走完终验（断言恰好不含坏面）→ 发成功话术，用户下一轮才发现画面是坏的。
 *
 * 本模块只做纯检测，不改变终验权威性（终验收口仍不信模型自述）：终轮分类
 * （agent-loop）、宽限交卷轮、learnings 落库过滤（programming-orchestrator）与
 * ready 直答校验（orchestrator）共用。
 *
 * 阈值与 renderer/stream-collapse.ts（显示层折叠）对齐：连续重复 ≥8、单元 ≤8
 * 字符。两侧用途不同（折叠上屏 vs 判定输出无效），改动阈值须双侧同步。
 */

/** 渠道工具调用协议原文的特征片段（正文出现任意一个 = 工具调用未送达的传输事故）。 */
const TOOL_MARKUP_PATTERNS: RegExp[] = [
  /<｜｜DSML｜｜/, // deepseek 系工具调用原文（d066eb92 实测整段泄漏）
  /<\/?tool_calls?[^a-z]/, // 通用工具调用原文，开/闭标签（P2-13 learnings 脏数据同源）
  /<\/?invoke\b/i, // XML 风格 invoke 标签
  /<\/?parameter\b/i, // XML 风格 parameter 标签
]

/** 连续重复判定阈值：与 renderer/stream-collapse.ts 的 MIN_REPEAT / MAX_UNIT 对齐。 */
const MIN_REPEAT = 8
const MAX_UNIT = 8
/** 退行运行需覆盖的正文最低占比（正常文本里的修辞性省略号/分隔符不误伤）。 */
const MIN_RUN_RATIO = 0.25
/** 短于该长度不做重复扫描（工具标记检测不受此限）。 */
const MIN_REPEAT_SCAN_LENGTH = 32

/**
 * 判定一段助手文本是否为传输事故产物：
 * - 正文混入工具调用协议原文（任意位置命中即判，协议原文不该以文本形态存在）；
 * - 退行性重复：存在 1-8 字符单元连续重复 ≥8 次的运行，且该运行覆盖 ≥25% 正文
 *   （比例门槛防正常总结里的长省略号误伤——8 次 × 2 字符 = 16 字符，在 500 字
 *   总结里仅 3%，不会触发；「查。×385」这类墙则占比 90%+ 必命中）。
 */
export function isDegenerateText(text: string): boolean {
  if (!text) return false
  if (TOOL_MARKUP_PATTERNS.some((pattern) => pattern.test(text))) return true
  const n = text.length
  if (n < MIN_REPEAT_SCAN_LENGTH) return false
  for (let start = 0; start < n; start += 1) {
    for (let unitLen = 1; unitLen <= MAX_UNIT; unitLen += 1) {
      if (start + unitLen * MIN_REPEAT > n) break
      const unit = text.slice(start, start + unitLen)
      let count = 1
      while (start + (count + 1) * unitLen <= n && text.startsWith(unit, start + count * unitLen)) count += 1
      if (count >= MIN_REPEAT && count * unitLen >= n * MIN_RUN_RATIO) return true
    }
  }
  return false
}

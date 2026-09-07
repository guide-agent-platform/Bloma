/**
 * 退行性重复折叠（显示层专用，2026-09-04「查。」墙案）。
 *
 * 背景：模型流式输出在长上下文 + 反复失败压力下可能发生采样退行——旁白以微短语
 * 开头后坍缩为单 token 无限重复（实测两例：glm-5.3 的「。。。。」与「查。查。查。」，
 * 均在 ~24 轮 GWT 三连败后出现）。落盘保留原始文本（磁盘证据）；本函数只做显示层
 * 折叠：连续重复 ≥8 次的短单元（≤8 字符）保留一次 + 计数标注，防气泡刷屏。
 *
 * 算法：确定性扫描而非正则——每位置尝试 1-8 字符单元，统计连续重复次数，取
 * 「自然对齐优先（单元不以标点开头，避免把前句句号吞进单元）+ 覆盖最长」的运行
 * 折叠。纯函数、无依赖：ChatPanel 的 MessageBubble 咽喉点消费（流式气泡与历史
 * 回放共用）。
 */

/** 单元首字符为标点/符号（自然对齐偏好用）。 */
const PUNCT_START = /^[。，、！？；：…—～·「」『』（）《》〈〉【】"'`.,;:!?~—]/u

/** 触发折叠的最小连续重复次数。 */
const MIN_REPEAT = 8
/** 单元最大字符数。 */
const MAX_UNIT = 8
/** 前视窗口：从当前位置向右最多探测多少字符找运行起点。 */
const LOOKAHEAD = 16
/** 短于该长度不处理（快速路径）。 */
const MIN_INTERESTING_LENGTH = 16

/**
 * 折叠退行性重复：`查。查。查。…（×190）` → `查。〔…重复 190 次已折叠〕`。
 * 多段独立重复各自折叠；重复不足 8 次的正常文本零改动。
 */
export function collapseRepetitiveText(text: string): string {
  if (text.length < MIN_INTERESTING_LENGTH) return text
  const out: string[] = []
  let i = 0
  const n = text.length
  while (i < n) {
    let chosen: { start: number; unit: string; count: number } | null = null
    let bestScore = -1
    const windowEnd = Math.min(n, i + LOOKAHEAD)
    for (let s = i; s < windowEnd; s += 1) {
      for (let p = 1; p <= MAX_UNIT && s + p * MIN_REPEAT <= n; p += 1) {
        const unit = text.slice(s, s + p)
        let count = 1
        while (s + (count + 1) * p <= n && text.startsWith(unit, s + count * p)) count += 1
        if (count < MIN_REPEAT) continue
        const natural = !PUNCT_START.test(unit)
        // 优先自然对齐，其次覆盖最长（单元更短/次数更多/起点更左同分时取先扫到的）
        const score = (natural ? 1e9 : 0) + p * count * 10 - p
        if (score > bestScore) {
          bestScore = score
          chosen = { start: s, unit, count }
        }
      }
      // s 处已有高分自然匹配即停（最左优先，窗口内最佳即可）
      if (bestScore >= 1e9) break
    }
    if (!chosen) {
      out.push(text[i])
      i += 1
      continue
    }
    out.push(text.slice(i, chosen.start), `${chosen.unit}〔…重复 ${chosen.count} 次已折叠〕`)
    i = chosen.start + chosen.unit.length * chosen.count
  }
  return out.join('')
}

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

/* =========================================================================
   工具调用协议残片折叠（2026-09-11 真机案例：DSML 原文漏进正文+历史回放）
   =========================================================================
   背景：DeepSeek 系渠道在传输事故时把工具调用协议原文（DSML 标记）以文本形态
   漏进 assistant 正文（d066eb92 同源）；JSONL 落盘保留原始证据，但显示层此前
   只做退行重复折叠——DSML 标记经 React-Markdown 被当作原生 HTML 剥除，正文
   渲染成空（真机表现「气泡只剩一条虚线、展开无内容」）。
   本函数为显示层清洗：协议标签/参数对一律移除，孤立的属性尾巴（被切断的
   `<｜｜DSML｜｜ invoke name="read_file">` 残段）在确认 DSML 场景下移除；
   保留的前置旁白照常显示，被移除部分以折叠标注代替。落盘/回放数据不动。
 */

/** DSML 开/闭标记（含被切断的残段形态） */
const DSML_TAG = /<｜｜DSML｜｜[^>]*>?|<\/｜｜DSML｜｜[^>]*>?/g
/** DSML 参数对（标签+值整体移除，防值残留在正文） */
const DSML_PARAMETER = /<｜｜DSML｜｜\s*parameter[^>]*>[^<]*<\/｜｜DSML｜｜\s*parameter>/g
/** 通用 XML 风格工具协议标签（invoke/parameter/tool_calls 等） */
const XML_TOOL_TAG = /<\/?(?:invoke|parameter|tool_calls?|function_calls?|function_results?)\b[^>]*>/gi
/** XML 参数对（标签+值整体移除） */
const XML_PARAMETER = /<parameter\b[^>]*>[^<]*<\/parameter>/gi
/** 被切断的 invoke 开头残段（如 `name="read_file">`——仅在确认 DSML 场景下移除） */
const ATTR_TAIL = /\s*[a-z_]+="[^"]{0,200}">/g
/** 是否含工具协议特征（与 main/coding/output-integrity.ts TOOL_MARKUP_PATTERNS 同源口径） */
const HAS_TOOL_MARKUP = /<｜｜DSML｜｜|<\/?tool_calls?[^a-z]|<\/?invoke\b|<\/?parameter\b/i

/** 折叠标注（正文里被移除的协议原文以一句话代替） */
export const TOOL_MARKUP_FOLDED_NOTE = '〔工具调用协议原文已折叠〕'

/**
 * 显示层清洗：移除混进正文的工具调用协议原文。
 * - 无协议特征 → 原样返回（零改动快速路径）；
 * - 命中 → 移除协议标记/参数对/属性尾巴，保留前置旁白，追加折叠标注；
 * - 清洗后无有效正文 → 仅返回折叠标注（气泡不再渲染成空）。
 */
export function stripToolMarkupText(text: string): string {
  if (!text || !HAS_TOOL_MARKUP.test(text)) return text
  const removed = text.length
  let out = text
    .replace(DSML_PARAMETER, ' ')
    .replace(XML_PARAMETER, ' ')
    .replace(DSML_TAG, ' ')
    .replace(XML_TOOL_TAG, ' ')
  if (/<｜｜DSML｜｜/.test(text)) out = out.replace(ATTR_TAIL, ' ')
  out = out.replace(/\s{3,}/g, '\n\n').trim()
  const kept = out.length
  if (removed - kept > 40) {
    return out ? `${out}\n\n${TOOL_MARKUP_FOLDED_NOTE}` : TOOL_MARKUP_FOLDED_NOTE
  }
  // 移除量很小（偶发单标记）：仍移除协议原文，但不加标注
  return out
}

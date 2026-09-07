import { partitionWindow } from './agent-loop'
import type { ConversationTurn } from './orchestrator'

/**
 * CompactingWindow（compacting-window-port.md，2026-08-28 移植）：滑出窗口的轮次做
 * 确定性提取式摘要（标记句），作为 digest 消息保留在窗口头——子 Agent 长任务不再
 * 因硬截断忘记已失败方案/已核验根因（context rot 对策）。
 *
 * 缓存友好三原则（r32-33 对抗证据）：① digest 追加式不重写（全量重算下滑出集单调
 * 增长，旧行保持前缀稳定）② 低频驱逐（每满一轮才滑出一次）③ 确定性提取非 LLM 重写
 * （零额外 token/延迟，不破坏 provider 前缀缓存，也不会幻觉污染记忆）。
 *
 * 模型可见消息 = [system(调用点拼接)] + [head(task)] + [digest?] + [活跃窗口]。
 * head 恒保留使任务目标/约束天然不丢；digest 只需覆盖被驱逐轮次的关键信息。
 */

/** digest 消息的前缀（测试与消费方识别用） */
export const DIGEST_HEADER_PREFIX = '[早期轮次简报'

/** digest 字符预算（超限丢最老行——第二层压缩，原型⑪） */
export const DIGEST_MAX_CHARS = 1200

/** 提取式标记句：以六类标记开头的行视为关键信息（子 Agent task/result 天然结构化，纯字符串匹配即可） */
const KEY_LINE_PATTERN = /^(?:目标|约束|方案|失败|结论|已核验)\s*[:：]/

/** 单轮最多提取的关键行数（防单轮超长文本挤爆 digest） */
const PER_TURN_KEY_LINES = 4

/** 识别标记句（导出供测试与未来子 Agent 输出规范复用） */
export function isKeyLine(line: string): boolean {
  return KEY_LINE_PATTERN.test(line.trim())
}

/** 从多行文本提取标记句，上限 maxLines（时间有序） */
export function extractKeyLines(text: string, maxLines: number): string[] {
  const out: string[] = []
  for (const line of text.split(/\n/)) {
    const t = line.trim()
    if (t && isKeyLine(t) && out.length < maxLines) out.push(t)
  }
  return out
}

/** 从 ConversationTurn 提取可扫描纯文本：string 直取；块数组取 text/tool_result 文本与 tool_use 名 */
function turnPlainLines(turn: ConversationTurn): string {
  if (typeof turn.content === 'string') return turn.content
  return turn.content
    .map((block) => {
      if (block.type === 'text') return block.text ?? ''
      // Bloma 的 tool_result 文本在 content 字段（agent-loop 构造时 content: outcome.output）
      if (block.type === 'tool_result') return block.content ?? block.text ?? ''
      if (block.type === 'tool_use') return block.name ? `工具调用 ${block.name}` : ''
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 带 digest 的窗口化：与 windowMessages 同一保留算法；被驱逐轮次提取标记句生成 digest，
 * **并入 head（首轮 task）的 content 末尾**。多厂商审查 fail 点修复（2026-08-28 deepseek）：
 * 独立 digest 消息（user 角色）插在 user task 后会造成连续两条 user 消息，透传 Anthropic
 * API 有角色交替风险；合并后消息数与结构零变化，仅 head 文本追加。
 * 无关键信息则与 windowMessages 完全一致（零浪费，原型⑫）。
 */
export function windowMessagesWithDigest(
  messages: ConversationTurn[],
  textWindowTurns: number,
  toolRounds: number,
  pinnedTurn?: number,
): ConversationTurn[] {
  const { head, kept, evicted } = partitionWindow(messages, textWindowTurns, toolRounds, pinnedTurn)
  if (!head) return []
  const lines: string[] = []
  for (const turn of evicted) {
    for (const line of extractKeyLines(turnPlainLines(turn), PER_TURN_KEY_LINES)) {
      lines.push(line)
    }
  }
  if (lines.length === 0) return [head, ...kept]
  // 第二层压缩：超预算丢最老行（保持 ≥1 行，最坏情况也保留最新关键信息）
  let total = lines.reduce((n, l) => n + l.length, 0)
  while (total > DIGEST_MAX_CHARS && lines.length > 1) {
    total -= lines[0].length
    lines.shift()
  }
  const digest = `${DIGEST_HEADER_PREFIX} · 滑出窗口的关键信息自动提取，只读参考]\n${lines.join('\n')}`
  // 合并进 head：string content 直接追加；块数组 content 追加 text 块（防御性，head 实际为 string task）
  const headWithDigest: ConversationTurn =
    typeof head.content === 'string'
      ? { ...head, content: `${head.content}\n\n${digest}` }
      : { ...head, content: [...head.content, { type: 'text' as const, text: digest }] }
  return [headWithDigest, ...kept]
}

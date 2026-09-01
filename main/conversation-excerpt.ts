/**
 * 会话原文读取（conversation-excerpt）——内审闭环的 F 维对照源，2026-09-01。
 *
 * 背景（2026-08-30 组会决议 1/4 + 泳道图缺口 3）：PRD 六维审查的输入此前只有
 * 背板 JSON + 冻结清单，审查者看不到用户对话原文——F 保真维（权重 30%）缺
 * 对照源，只能查内部一致性。本模块把「本会话 JSONL」以两种形态供给内审：
 *
 * ① 摘录（buildConversationExcerpt）：用户原话关键轮拼接进 Attacker task
 *    （零工具调用成本，每轮内审必带）；
 * ② 工具（buildReadConversationHistoryTool）：research 只读面的
 *    read_conversation_history——Attacker/Defender 需要查全文时自助取用
 *    （经委派 childExtraTools 注入，只读本会话，绝不跨会话）。
 *
 * 沉淀纪律（设计稿 §3.3）：子会话 JSONL 可回放，工具调用留审计轨迹。
 */

import { existsSync, readFileSync } from 'node:fs'
import type { AgentMessage } from '../shared/types'
import type { AgentLoopTool } from './agent-loop'
import { getAgentSessionPath } from '../storage/config-paths'

/** 摘录进 task 的用户原话轮上限（控 token：F 维对照源 ≈2k 预算）。 */
const EXCERPT_MAX_TURNS = 12
/** 单轮原话截断上限（用户长贴文只取前段）。 */
const EXCERPT_TURN_CHAR_LIMIT = 400
/** 工具单次返回的总字符上限（防全量倾倒撑爆子 agent 上下文）。 */
const TOOL_TOTAL_CHAR_LIMIT = 12_000

function readSessionMessages(sessionId: string): AgentMessage[] {
  const path = getAgentSessionPath(sessionId)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line): AgentMessage | undefined => {
      try {
        return JSON.parse(line) as AgentMessage
      } catch {
        return undefined
      }
    })
    .filter((message): message is AgentMessage => message !== undefined)
}

function messageText(message: AgentMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n')
}

/** 排除内部行（与 session-service.loadMessages 同口径）：终端态 / 决策卡 / 决策行。 */
function isConversationLine(message: AgentMessage): boolean {
  if (message.role === 'system') return false
  const text = messageText(message).trim()
  if (!text) return false
  return (
    !text.startsWith('[terminal]') &&
    !text.startsWith('[decision-card]') &&
    !text.startsWith('[decision]') &&
    !text.startsWith('[reconcile]') &&
    !text.startsWith('[channel-switch]')
  )
}

/**
 * 用户原话关键轮摘录（F 维对照源）。只取 user 轮——用户说过什么就是保真基准；
 * 助手轮不进摘录（审查者要对照的是用户意图，不是向导的转述）。
 */
export function buildConversationExcerpt(sessionId: string): string {
  const userTurns = readSessionMessages(sessionId)
    .filter((message) => message.role === 'user' && isConversationLine(message))
    .map((message) => messageText(message).replace(/\s+/g, ' ').trim())
    .filter((text) => text.length > 0)
  if (userTurns.length === 0) return ''
  const recent = userTurns.slice(-EXCERPT_MAX_TURNS)
  const lines = recent.map(
    (text, index) => `${index + 1}. ${text.length > EXCERPT_TURN_CHAR_LIMIT ? `${text.slice(0, EXCERPT_TURN_CHAR_LIMIT)}…（截断）` : text}`,
  )
  return [`【用户对话原文（最近 ${recent.length} 轮用户原话，F 保真维度的第一对照源——PRD 不得偏离这些原话承载的意图）】`, ...lines].join('\n')
}

/**
 * research 只读面注入工具：read_conversation_history。
 * 只读本会话 JSONL（闭包锁 sessionId）；user/assistant 对话行、可选尾部 limit。
 * 不在 buildAgentTools 通用面注册——经 review-delegation 的 childExtraTools 定向
 * 注入内审子 agent（最小攻击面：MVP loop 的 research 子代理不获得会话读取权）。
 */
export function buildReadConversationHistoryTool(sessionId: string): AgentLoopTool {
  return {
    name: 'read_conversation_history',
    description:
      '读取本项目与用户对话的历史消息（只读）。参数：limit（返回最近 N 条，缺省 60，上限 200）。' +
      '用于核对 PRD 是否忠实于用户原话（F 保真维度）：查用户说过/没说过什么时使用。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回最近 N 条消息（缺省 60，上限 200）' },
      },
    },
    execute: async (toolInput) => {
      const limit = Math.min(Math.max(Math.trunc(Number(toolInput.limit ?? 60)) || 60, 1), 200)
      const messages = readSessionMessages(sessionId).filter(isConversationLine)
      const slice = messages.slice(-limit)
      if (slice.length === 0) {
        return { output: '（本会话暂无可读的对话历史）' }
      }
      const lines: string[] = []
      let total = 0
      for (const message of slice) {
        const text = messageText(message).trim()
        if (!text) continue
        const line = `[${message.role}] ${text.length > 2000 ? `${text.slice(0, 2000)}…（截断）` : text}`
        if (total + line.length > TOOL_TOTAL_CHAR_LIMIT) {
          lines.push('（已达返回上限，更早消息省略——可用更小 limit 分段读取）')
          break
        }
        lines.push(line)
        total += line.length
      }
      return {
        output: `（最近 ${slice.length} 条对话，从早到晚）\n${lines.join('\n')}`,
        detail: { session_id: sessionId, requested_limit: limit, returned: slice.length },
      }
    },
  }
}

/**
 * ChatPanel — Sprint 2 变更
 *
 * 相较于 Sprint 1 版本，仅新增「user_decision_required 事件处理」：
 *
 * === 唯一变更点 ===
 *
 * user_decision_required 事件 payload 中的 questions 字段：
 *   - 1~3 条 → 弹卡片渲染（现有 CardOptions 行为，不动）
 *   - 0 条   → 不弹卡片，流式文本中已包含追问，用户直接在输入框回复
 *
 * === 不变的部分 ===
 *   - message_delta 流式文本 ✅
 *   - 消息列表渲染 ✅
 *   - 输入框行为 ✅
 *   - WaitingFeedback 超时态 ✅
 *   - 空状态、错误态 ✅
 *
 * === 集成方式 ===
 *
 * 方案 A（推荐）：将 handleUserDecisionRequired 函数合并到主 ChatPanel.tsx 中。
 *   在主 ChatPanel 中新增一个 useEffect，监听 agentStreamStateFamily 的 events，
 *   当检测到 user_decision_required 事件时，调用 handleUserDecisionRequired
 *   将 questions 转为 CardOption[] 传给现有 <CardOptions> 渲染。
 *
 * 方案 B：如果主 ChatPanel 已支持 cardOptions prop，只需在 App.tsx 中
 *   将事件解析逻辑放在 handleStreamEvent 回调里即可。
 *
 * 下面给出的是新增的事件消费 hook 及示例使用方式。
 */

import { useMemo } from 'react'
import { atom, useAtomValue } from 'jotai'
import type { CardOption } from './CardOptions'
import type { AgentStreamState } from '../agent-atoms'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
} from '../agent-atoms'
import type { AgentEvent } from '../../shared/types'

// =========================================================================
// 模块级常量：当 activeAgentSessionIdAtom 为 null 时的稳定 fallback atom。
// 避免在 atomFamily 中创建不可回收的 '__unused__' key。
// 与 MvpStatusBanner.tsx 中的 nullSessionFallback 模式一致。
// =========================================================================

const nullStreamFallback = atom<AgentStreamState>({
  running: false,
  events: [],
  content: '',
})

// =========================================================================
// user_decision_required payload 类型
// =========================================================================

interface ClarificationQuestion {
  id: string
  label: string
  description: string
}

interface UserDecisionPayload {
  kind?: string
  title?: string
  questions?: ClarificationQuestion[]
}

// =========================================================================
// 从流式事件中提取当前有效的卡片选项
// =========================================================================

/**
 * 扫描 session 的流式事件，返回最近一次 user_decision_required
 * 事件中的 questions 转换成的 CardOption[]。
 *
 * - 1~3 条 → 转为 CardOption[]（B-对接契约 §2 方案 A：保留卡片）
 * - 0 条   → 返回空数组（不弹卡片，用户自由文本回复）
 * - 无事件 → 返回 null（无决策需求）
 */
function extractCardOptions(events: AgentEvent[]): CardOption[] | null {
  // 从后往前找最近一次 user_decision_required
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'user_decision_required') continue

    const payload = event.payload as UserDecisionPayload
    const questions = payload.questions ?? []

    // questions 0 条：模型在流式文本中追问，不弹卡片
    if (questions.length === 0) return []

    // 1~3 条：转 CardOption
    return questions.map((q) => ({
      id: q.id,
      label: q.label,
      description: q.description,
    }))
  }

  return null // 无 user_decision_required 事件
}

// =========================================================================
// Hook：供 ChatPanel 或 App.tsx 使用
// =========================================================================

/**
 * 从当前活跃会话的流式事件中提取 user_decision_required 的卡片选项。
 *
 * 返回值语义：
 *   - null        → 没有 user_decision_required 事件（不干预 CardOptions）
 *   - CardOption[] → 有效选项（空数组 = 模型文本追问，不弹卡片）
 *
 * 用法：
 * ```tsx
 * const decisionCards = useUserDecisionCards()
 * const cardOptions = decisionCards ?? externalCardOptions
 * ```
 */
export function useUserDecisionCards(): CardOption[] | null {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const streamState = useAtomValue(
    sessionId ? agentStreamStateFamily(sessionId) : nullStreamFallback,
  )

  return useMemo(() => {
    if (!sessionId || !streamState) return null
    return extractCardOptions(streamState.events)
  }, [sessionId, streamState])
}

// =========================================================================
// 辅助：生成回传 selected_option_id 的 metadata
// =========================================================================

export interface CardSelectionMeta {
  source: 'card_option'
  selected_option_id: string
}

export function toCardSelectionMeta(optionId: string): CardSelectionMeta {
  return {
    source: 'card_option',
    selected_option_id: optionId,
  }
}

// =========================================================================
// 向后兼容的导出（与主 ChatPanel 的 CardOption 类型一致）
// =========================================================================

export type { CardOption, UserDecisionPayload, ClarificationQuestion }

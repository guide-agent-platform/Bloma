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
  decisionConsumedFamily,
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

// sessionId 为空时的 consumed 兜底：必须模块级常量。
// 内联 atom(false) 会在每次渲染创建新 atom → useAtomValue 重新订阅 → 无限重渲染
// （jsdom/测试环境直接挂死；真机模式选择页空转烧 CPU）。与 nullStreamFallback 同模式。
const notConsumedFallback = atom(false)

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
  /** 审查卡（kind=prd_review）携带的问题详情（2026-08-29：暴露给用户看具体的） */
  issues?: Array<{ dimension?: unknown; severity?: unknown; claim?: unknown }>
  summary?: unknown
  /** 内审（2026-09-01）：Defender 自动修订摘要（已改了什么） */
  defender_summary?: unknown
  /** 内审（2026-09-01）：厂商隔离事实——false = 本次内审未隔离（如实标注不冒充） */
  vendor_isolated?: unknown
  /** 交付状态三层正文（Phase 7 U1 H3，2026-09-10）：ready 引导卡携带；缺席不渲染 */
  delivery_body?: unknown
}

// =========================================================================
// 从流式事件中提取当前有效的卡片选项
// =========================================================================

/**
 * 决策卡内容：title 为卡片标题（引导澄清「先确认方向」/ 迭代确认「确认修改方向」/
 * 让渡具体偏差「缺了按月统计功能」等），options 为选项列表。
 */
export interface DecisionCards {
  title?: string
  /** 决策卡正文（2026-08-29：审查卡的具体问题清单，让用户知情后再选忽略/补充） */
  body?: string
  options: CardOption[]
}

/**
 * 扫描 session 的流式事件，返回最近一次 user_decision_required
 * 事件中的 title + questions 转换成的 DecisionCards。
 *
 * - 1~3 条 → 转为 DecisionCards（B-对接契约 §2 方案 A：保留卡片）
 * - 0 条   → 返回 { options: [] }（不弹卡片，用户自由文本回复）
 * - 无事件 → 返回 null（无决策需求）
 */
function extractDecisionCards(events: AgentEvent[]): DecisionCards | null {
  // 从后往前扫描：
  // - 先遇到 sketch_ready / mvp_ready → 该决策已被后端处理（卡片已消费），返回 null 隐藏卡片
  // - 先遇到 user_decision_required → 返回其 title + questions（0 条 = 模型在文本里追问，不弹卡片）
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'sketch_ready' || event.type === 'mvp_ready') return null
    if (event.type === 'stage_changed' && ['desktop-implement', 'desktop-verify', 'delivered'].includes(String(event.payload.stage))) return null
    if (event.type !== 'user_decision_required') continue

    const payload = event.payload as UserDecisionPayload
    const questions = payload.questions ?? []

    // questions 0 条：模型在流式文本中追问，不弹卡片
    if (questions.length === 0) return { options: [] }

    // 1~3 条：转 CardOption
    // B5 防御：question 缺 id 时兜底（A1 已补 id，此处双保险，避免 key=undefined 崩坏）
    return {
      title: payload.title,
      // H3：交付状态三层正文优先（ready 引导卡）；无 delivery_body 走原正文链
      body: extractDeliveryBody(payload) ?? extractDecisionBody(payload),
      options: questions.map((q, i) => ({
        id: q.id ?? q.label ?? String(i),
        label: q.label,
        description: q.description,
      })),
    }
  }

  return null // 无 user_decision_required 事件
}

/** 决策卡正文（2026-08-29）：审查卡的问题清单（severity 徽标+问题描述），
 * 其它卡回退 summary 字段；都没有则 undefined 不渲染。
 * 内审（2026-09-01）：清单前缀 Defender 自动修订摘要，后缀厂商隔离事实标注。
 * 交付状态（2026-09-10 H3）：delivery_body 优先于 summary（ready 引导卡三层正文）。 */
function extractDecisionBody(payload: UserDecisionPayload): string | undefined {
  const issues = Array.isArray(payload.issues) ? payload.issues : []
  if (issues.length > 0) {
    const sections: string[] = []
    if (typeof payload.defender_summary === 'string' && payload.defender_summary) {
      sections.push(`内审已自动修订：${payload.defender_summary.slice(0, 160)}`)
    }
    sections.push(
      issues
        .map((issue) => {
          const severity =
            issue.severity === 'blocking' ? '【严重】' : issue.severity === 'major' ? '【重要】' : ''
          const claim = typeof issue.claim === 'string' ? issue.claim.replace(/\s+/g, ' ').trim() : ''
          return `${severity}${claim}`.slice(0, 120)
        })
        .join('\n'),
    )
    if (payload.vendor_isolated === false) {
      sections.push('（本次内审与生成模型同厂商，未做厂商隔离）')
    }
    return sections.join('\n')
  }
  return typeof payload.summary === 'string' && payload.summary ? payload.summary : undefined
}

/** 交付状态正文提取（H3）：delivery_body 为非空字符串时优先于 summary（多行文本
 * 由 ChatPanel decisionBody 的 pre-wrap 渲染承载）。 */
function extractDeliveryBody(payload: UserDecisionPayload): string | undefined {
  return typeof payload.delivery_body === 'string' && payload.delivery_body.trim() ? payload.delivery_body : undefined
}

// =========================================================================
// Hook：供 ChatPanel 或 App.tsx 使用
// =========================================================================

/**
 * 从当前活跃会话的流式事件中提取 user_decision_required 的决策卡（title + 选项）。
 *
 * 返回值语义：
 *   - null          → 没有 user_decision_required 事件（不干预 CardOptions）
 *   - DecisionCards → 有效决策卡（options 空数组 = 模型文本追问，不弹卡片）
 *
 * 用法：
 * ```tsx
 * const decisionCards = useUserDecisionCards()
 * const cardOptions = decisionCards?.options ?? externalCardOptions
 * ```
 */
export function useUserDecisionCards(): DecisionCards | null {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const streamState = useAtomValue(
    sessionId ? agentStreamStateFamily(sessionId) : nullStreamFallback,
  )
  const consumed = useAtomValue(
    sessionId ? decisionConsumedFamily(sessionId) : notConsumedFallback,
  )

  return useMemo(() => {
    if (!sessionId || !streamState) return null
    // 用户已点选（consumed=true）→ 立即隐藏卡片，不等 sketch_ready（草图走 LLM 有空窗）
    if (consumed) return null
    return extractDecisionCards(streamState.events)
  }, [sessionId, streamState, consumed])
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

// 向导决策流 helper（2026-10-01 开关面收敛批）：旧「单次 JSON 流」测试改造为 guide_decide 工具流。
// 旧路径删除后，向导澄清腿恒走 agent loop——mock 的 query 需产出 tool_use 决策块。
import type { SDKMessage } from '../../shared/types'

export interface GuideDecisionPayload {
  action: string
  reply: string
  questions?: Array<{ id: string; label: string; description?: string }>
  requirements?: Array<{ id: string; description: string; origin?: string }>
}

/**
 * 产出一条 guide_decide 决策流（旁白 + 工具调用 + result）。
 * narration=false 时不带旁白 text 块。
 */
export function guideDecideQuery(decision: GuideDecisionPayload, opts?: { narration?: boolean }): () => AsyncGenerator<SDKMessage> {
  const withNarration = opts?.narration !== false && typeof decision.reply === 'string' && decision.reply.length > 0
  return async function* (): AsyncGenerator<SDKMessage> {
    yield {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          ...(withNarration ? [{ type: 'text' as const, text: decision.reply }] : []),
          { type: 'tool_use' as const, id: 't-guide-decide-1', name: 'guide_decide', input: decision },
        ],
      },
    } as SDKMessage
    yield { type: 'result', subtype: 'success' } as SDKMessage
  }
}

/** 纯自由对话流（无决策）：free_chat 路径 */
export function guideFreeChatQuery(text: string): () => AsyncGenerator<SDKMessage> {
  return async function* (): AsyncGenerator<SDKMessage> {
    yield {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    } as SDKMessage
    yield { type: 'result', subtype: 'success' } as SDKMessage
  }
}

/**
 * 兼容旧测试的 text→content 块转换：字符串是决策 JSON（含 action）时转旁白+guide_decide tool_use，
 * 否则原样返回 text 块。改造点：makeModel 里 content: [{ type: 'text', text: json }] → content: decideBlocks(json)。
 */
export function decideBlocks(text: string): import('../../shared/types').MessageContentBlock[] {
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object' && typeof obj.action === 'string') {
      // 不产旁白 text 块：决策 reply 由下游路由块统一上屏（避免 loop 旁白双气泡）
      return [
        { type: 'tool_use' as const, id: 't-guide-1', name: 'guide_decide', input: obj },
      ] as import('../../shared/types').MessageContentBlock[]
    }
  } catch { /* 非决策 JSON 原样透传 */ }
  return [{ type: 'text', text }] as import('../../shared/types').MessageContentBlock[]
}

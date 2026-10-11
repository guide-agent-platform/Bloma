/**
 * Anthropic 流式适配器（照抄 Proma 上游 packages/core/src/providers/anthropic-adapter.ts
 * @ bf3e98c 的流式子集：parseSSELine + 认证头构建）。
 *
 * 上游此文件明文适配：Anthropic 原生 / DeepSeek / Kimi / MiniMax 等 Anthropic 协议
 * 家族。Bloma 搬运的差异（两处，均在注释中标出）：
 * 1. 裁剪聊天侧（toAnthropicMessages / continuation / title）——Bloma loop 全量
 *    agent 形态消息由 loop-provider-query 自行构建请求体；
 * 2. parseSSELine 增补 usage 提取（message_start / message_delta）——上游聊天层
 *    不消费流内 usage，Bloma 用量核算（压缩触发/埋点）依赖。
 * 3. 认证头裁剪 zhipu-coding-team 的团队凭据拆包（Bloma 渠道无该凭据形态，直发 Bearer）。
 */

import type { ProviderType } from '../../../../shared/types'
import type { StreamAdapter, StreamEvent } from './types'
import { resolveAnthropicMessagesUrl } from './url-utils'
import { getPromaUserAgent } from './user-agent'

/** Anthropic SSE 事件（上游原样） */
interface AnthropicSSEEvent {
  type: string
  /** content_block_start 的 content_block */
  content_block?: {
    type: string
    id?: string
    name?: string
  }
  delta?: {
    type?: string
    /** 普通文本增量 (text_delta) */
    text?: string
    /** 思考内容增量 (thinking_delta) */
    thinking?: string
    /** 思考签名增量 (signature_delta) */
    signature?: string
    /** 工具参数 JSON 增量 (input_json_delta) */
    partial_json?: string
    /** message_delta 的 stop_reason */
    stop_reason?: string
  }
  /** Bloma 扩展：message_start 的 message.usage / message_delta 顶层 usage */
  message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } }
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
}

/**
 * 构造请求头（上游 buildHeaders 原样，差异见文件头注释③）。
 *
 * Kimi Coding Plan 要求：只使用 Bearer（服务端校验 User-Agent 白名单）。
 */
export function buildAnthropicHeaders(apiKey: string, providerType: ProviderType): Record<string, string> {
  const base: Record<string, string> = {
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  }
  if (providerType === 'kimi-coding' || providerType === 'zhipu-coding' || providerType === 'zhipu-coding-team') {
    base['Authorization'] = `Bearer ${apiKey}`
    base['User-Agent'] = getPromaUserAgent()
    return base
  }
  if (providerType === 'xiaomi-token-plan' || providerType === 'qwen-token-plan') {
    base['Authorization'] = `Bearer ${apiKey}`
    base['User-Agent'] = getPromaUserAgent()
    return base
  }
  if (providerType === 'minimax' || providerType === 'qwen-anthropic') {
    base['Authorization'] = `Bearer ${apiKey}`
    return base
  }
  if (providerType === 'xiaomi') {
    base['api-key'] = apiKey
    return base
  }
  // 其它渠道：保持双认证头（Anthropic 原生 + Bearer 兼容）
  base['x-api-key'] = apiKey
  base['Authorization'] = `Bearer ${apiKey}`
  return base
}

/** 根据 provider 类型解析 Messages 请求地址（上游同款薄壳） */
export function resolveMessagesUrl(baseUrl: string, providerType: ProviderType): string {
  return resolveAnthropicMessagesUrl(baseUrl, providerType)
}

export const ANTHROPIC_SSE_ADAPTER: StreamAdapter = {
  parseSSELine(jsonLine: string): StreamEvent[] {
    try {
      const event = JSON.parse(jsonLine) as AnthropicSSEEvent
      const events: StreamEvent[] = []

      // 内容块开始
      if (event.type === 'content_block_start') {
        if (event.content_block?.type === 'tool_use') {
          events.push({
            type: 'tool_call_start',
            toolCallId: event.content_block.id || '',
            toolName: event.content_block.name || '',
          })
        } else if (event.content_block?.type === 'thinking') {
          events.push({ type: 'reasoning_block_start' })
        }
      }

      if (event.type === 'content_block_stop') {
        // 无法从 stop 事件判断具体块类型，但 sse-reader 会忽略不相关的停止
        events.push({ type: 'reasoning_block_stop' })
      }

      if (event.type === 'content_block_delta') {
        // 推理文本增量
        if (event.delta?.type === 'thinking_delta' && event.delta?.thinking) {
          events.push({ type: 'reasoning', delta: event.delta.thinking })
        } else if (event.delta?.type === 'signature_delta' && event.delta?.signature) {
          // 推理签名增量（Anthropic 协议：thinking 块必须附带 signature 才能在续接里回传）
          events.push({ type: 'reasoning_signature', signature: event.delta.signature })
        } else if (event.delta?.type === 'input_json_delta' && event.delta?.partial_json) {
          // 工具参数 JSON 增量
          events.push({
            type: 'tool_call_delta',
            toolCallId: '', // SSE reader 通过 currentToolCallId 关联
            argumentsDelta: event.delta.partial_json,
          })
        } else if (event.delta?.text) {
          // 普通文本内容（text_delta）
          events.push({ type: 'chunk', delta: event.delta.text })
        }
      }

      // message_start 携带 input usage（Bloma 扩展，上游不提取）
      if (event.type === 'message_start' && event.message?.usage) {
        const inputTokens = event.message.usage.input_tokens
        const outputTokens = event.message.usage.output_tokens
        if (typeof inputTokens === 'number' || typeof outputTokens === 'number') {
          events.push({
            type: 'usage',
            ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
            ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
            ...(typeof event.message.usage.cache_read_input_tokens === 'number' ? { cacheReadInputTokens: event.message.usage.cache_read_input_tokens } : {}),
            ...(typeof event.message.usage.cache_creation_input_tokens === 'number' ? { cacheCreationInputTokens: event.message.usage.cache_creation_input_tokens } : {}),
          })
        }
      }

      // message_delta 携带 stop_reason（与 output usage，Bloma 扩展）
      if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) {
          events.push({ type: 'done', stopReason: event.delta.stop_reason })
        }
        const outTokens = event.usage?.output_tokens
        const inTokens = event.usage?.input_tokens
        if (typeof outTokens === 'number' || typeof inTokens === 'number') {
          events.push({
            type: 'usage',
            ...(typeof inTokens === 'number' ? { inputTokens: inTokens } : {}),
            ...(typeof outTokens === 'number' ? { outputTokens: outTokens } : {}),
            ...(typeof event.usage?.cache_read_input_tokens === 'number' ? { cacheReadInputTokens: event.usage.cache_read_input_tokens } : {}),
            ...(typeof event.usage?.cache_creation_input_tokens === 'number' ? { cacheCreationInputTokens: event.usage.cache_creation_input_tokens } : {}),
          })
        }
      }

      if (event.type === 'message_stop') events.push({ type: 'done', terminal: true })
      return events
    } catch {
      return []
    }
  },
}

/**
 * R1-providers（2026-09-19「照抄 Proma」稳健性对齐）：loop 查询的 providers 传输路径。
 *
 * 外壳契约与旧 anthropicMessagesQuery 完全一致（AsyncGenerator<SDKMessage>：逐段
 * assistant 增量 → 末尾 result），调用方零改动。内部差异（全部来自上游 sse-reader
 * 的稳健性，Bloma 手写版缺失）：
 * - 首字节超时 30s（旧路径无超时，渠道挂起=loop 挂死）；
 * - 首事件前自动重试（指数退避+jitter，5 次/30s 预算；旧路径零重试）；
 * - 多工具调用并行装配（旧路径单 activeToolUse，ds 并行 tool_use 会丢调用）；
 * - thinking/签名块容错（provider 不发 content_block_start 等场景自建块）；
 * - 双认证头 + provider 差异化 URL 解析（上游 url-utils 口径）。
 *
 * 请求体构建从旧路径镜像（system 提取/图片水合/thinking fragment/温度/tools——
 * Bloma loop 的全量 agent 形态消息是正确形态，上游聊天形态不适配，不搬）；旧路径
 * 文件零改动，经 BLOMA_PROVIDER_ADAPTER=0 字节级回退。
 */

import { hydrateMessagesImageBlocks } from '../pasted-images'
import { isThinkingLogEnabled, logThinking } from '../thinking-log'
import { extractErrorMessage } from '../channel-test-error'
import { buildThinkingFragment } from '../../shared/reasoning-profile'
import type { ConversationTurn, SDKQueryOptions } from '../orchestrator'
import type { MessageContentBlock, ProviderType, SDKMessage } from '../../shared/types'
import { ANTHROPIC_SSE_ADAPTER, buildAnthropicHeaders, resolveMessagesUrl } from './anthropic-sse-adapter'
import { normalizeAnthropicBaseUrl, resolveAnthropicMessagesUrl } from './url-utils'
import { streamSSE, HTTPError } from './sse-reader'

/** 逃生口：BLOMA_PROVIDER_ADAPTER 缺省 on（providers 传输路径）；=0/false/off 回旧路径字节级。 */
export function providerAdapterEnabled(): boolean {
  const raw = (process.env.BLOMA_PROVIDER_ADAPTER ?? '').trim().toLowerCase()
  return raw !== '0' && raw !== 'false' && raw !== 'off'
}

/**
 * Bloma 语义的 Messages URL：env 的 base 是协议根（SDK 根语义，channel-manager 已
 * 规范化）。上游 resolveAnthropicMessagesUrl 对 anthropic-compatible「原样使用」是
 * 聊天侧「用户填完整端点」语义——对 SDK 根语义的 base 会丢 /v1/messages。此处对
 * 兼容类回退 normalizeAnthropicBaseUrl + '/messages'，与旧路径拼接语义一致；其余
 * provider 走上游差异化解析（deepseek/kimi/zhipu 等版本化协议根 → /v1/messages）。
 */
function resolveLoopMessagesUrl(baseUrl: string, providerType: ProviderType): string {
  if (providerType === 'anthropic-compatible' || providerType === 'custom') {
    return `${normalizeAnthropicBaseUrl(baseUrl)}/messages`
  }
  return resolveAnthropicMessagesUrl(baseUrl, providerType)
}

/** 旧路径 extractText 的镜像（orchestrator 私有函数，此处内联避免循环依赖）。 */
function extractText(blocks: MessageContentBlock[]): string {
  const texts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('')
}

export async function* anthropicMessagesQueryViaProviders(prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  if (!options.env.PATH && !options.env.Path) throw new Error('SDK env missing PATH')
  if (options.signal.aborted) throw new Error('AGENT_CANCELLED')
  const apiKey = options.env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey || apiKey === 'test-key-main-only') {
    throw new Error('CHANNEL_NOT_FOUND: configure a model channel before using the SDK')
  }
  const baseUrl = (options.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')
  // SDKQueryOptions.providerType 是 string（历史形态）；渠道值实际是 ProviderType 联合成员
  const providerType = (options.providerType as ProviderType | undefined) ?? 'anthropic'

  // ---- 请求体构建（旧路径镜像：system 提取 / 图片水合 / thinking fragment） ----
  const history = options.messages ?? options.history ?? []
  const systemText = history
    .filter((turn) => turn.role === 'system')
    .map((turn) => (typeof turn.content === 'string' ? turn.content : extractText(turn.content)))
    .filter(Boolean)
    .join('\n')
  const nonSystemTurns = history.filter((turn) => turn.role !== 'system')
  const pastedRefs = (options.images ?? []).filter(
    (r) => r && typeof r.imageId === 'string' && /^[A-Za-z0-9_-]+\/[A-Za-z0-9-]+\.(png|jpeg|jpg|gif|webp)$/.test(r.imageId),
  )
  const promptTurn: ConversationTurn = pastedRefs.length
    ? {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: prompt },
          ...pastedRefs.map((r) => ({ type: 'image' as const, imageId: r.imageId, media_type: r.media_type })),
        ],
      }
    : { role: 'user' as const, content: prompt }
  const messages = hydrateMessagesImageBlocks(
    options.messages ? nonSystemTurns : [...nonSystemTurns, promptTurn],
  )

  const showThinking = isThinkingLogEnabled()
  const model = options.env.ANTHROPIC_MODEL
  if (!model) {
    throw new Error('SDK_MODEL_NOT_CONFIGURED: SDK env 缺少 ANTHROPIC_MODEL（模型路由未解析到模型）')
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: options.maxTokens ?? 640000,
    stream: true,
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (systemText) body.system = systemText
  if (options.tools?.length) body.tools = options.tools
  if (showThinking) {
    const devFragment = buildThinkingFragment(model, providerType, 'off')
    if (devFragment.omit) {
      console.warn('[providers-query] omit 渠道忽略 BLOMA_SHOW_THINKING（thinking 字段会 400）')
    } else {
      const maxTokens = options.maxTokens ?? 640000
      const budget = Math.min(1024, Math.floor(maxTokens / 2))
      body.thinking = { type: 'enabled', budget_tokens: Math.max(256, budget) }
    }
  } else {
    const fragment = buildThinkingFragment(model, providerType, options.thinkingLevel ?? 'off')
    if (!fragment.omit) {
      if (fragment.thinking) body.thinking = fragment.thinking
      if (fragment.output_config) body.output_config = fragment.output_config
    }
  }

  const url = resolveLoopMessagesUrl(baseUrl, providerType)
  const makeRequest = (): { url: string; headers: Record<string, string>; body: string } => ({
    url,
    headers: buildAnthropicHeaders(apiKey, providerType),
    body: JSON.stringify(body),
  })

  // ---- 事件桥：streamSSE 回调 → AsyncGenerator 实时增量（UI 流式依赖逐段 yield） ----
  const queue: SDKMessage[] = []
  let notify: (() => void) | undefined
  let finished = false
  let failure: unknown
  const wake = (): void => {
    const n = notify
    notify = undefined
    n?.()
  }

  let textDeltaCount = 0
  let thinkingDeltaCount = 0
  let toolUseCount = 0
  let usageInfo: { input_tokens?: number; output_tokens?: number } | undefined

  const streamTask = (async (): Promise<void> => {
    const runOnce = () =>
      streamSSE({
        request: makeRequest(),
        adapter: ANTHROPIC_SSE_ADAPTER,
        signal: options.signal,
        onEvent: (event) => {
          if (event.type === 'chunk') {
            textDeltaCount += 1
            queue.push({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: event.delta }] } })
          } else if (event.type === 'reasoning') {
            thinkingDeltaCount += 1
            if (showThinking) logThinking(options.sessionId, event.delta)
          } else if (event.type === 'usage') {
            usageInfo = { ...usageInfo, ...(event.inputTokens !== undefined ? { input_tokens: event.inputTokens } : {}), ...(event.outputTokens !== undefined ? { output_tokens: event.outputTokens } : {}) }
          }
          // 其余事件（reasoning_signature/block、tool_call_start/delta、done）由
          // sse-reader 装配，流末统一产出；正文先于 tool_use（协议块序），顺序一致
        },
      })

    let result
    try {
      result = await runOnce()
    } catch (error) {
      // 旧路径兼容性降级镜像：thinking 参数被拒（400 提及 thinking/reasoning/effort/
      // output_config）→ 移除后重试一次；vision 400 → 用户可读引导。此时必零事件
      // （HTTP 层失败先于流），重试无双发风险。
      if (error instanceof HTTPError && error.status === 400) {
        const detail = extractErrorMessage(error.message)
        const thinkingRejected = (body.thinking as { type?: string } | undefined) !== undefined
          && /thinking|reasoning|effort|output_config/i.test(detail)
        const imageRejected = JSON.stringify(body.messages ?? []).includes('"type":"image"')
          && /image|multimodal|vision|多模态/i.test(detail)
        if (thinkingRejected) {
          console.warn(`[providers-query] 渠道拒绝 thinking 参数（${detail}），移除该参数后重试一次`)
          delete body.thinking
          delete body.output_config
          result = await runOnce()
        } else if (imageRejected) {
          throw Object.assign(
            new Error('当前模型不支持图片输入——请用文字描述内容，或在设置中更换支持视觉的模型后重试。'),
            { statusCode: 400 },
          )
        } else {
          console.error(`[providers-query] model request failed: HTTP 400${detail ? ` — ${detail}` : ''}`)
          throw Object.assign(new Error('SDK request failed with 400'), { statusCode: 400 })
        }
      } else {
        throw error
      }
    }

    // 流末统一产出装配完成的工具调用（thinking→text→tool_use 协议块序）
    for (const call of result.toolCalls) {
      toolUseCount += 1
      queue.push({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.arguments }] },
      })
    }
    queue.push({
      type: 'result',
      subtype: 'success',
      ...(result.stopReason !== undefined ? { stop_reason: result.stopReason } : {}),
      ...(usageInfo !== undefined ? { usage: usageInfo } : {}),
    })
  })()
  streamTask.then(
    () => {
      finished = true
      wake()
    },
    (error: unknown) => {
      failure = error
      finished = true
      wake()
    },
  )

  try {
    for (;;) {
      while (queue.length > 0) yield queue.shift()!
      if (finished) {
        if (failure !== undefined) throw failure
        return
      }
      await new Promise<void>((resolve) => {
        notify = resolve
      })
    }
  } finally {
    // 零正文可观测性（旧路径口径镜像）：tool-only 轮是正常形态不算零正文
    if (textDeltaCount === 0 && toolUseCount === 0 && thinkingDeltaCount > 0) {
      console.error(
        `[providers-query] 零正文输出：model=${model} max_tokens=${String(body.max_tokens)} `
          + `text_delta=${textDeltaCount} thinking_delta=${thinkingDeltaCount}`
          + '——思考型模型疑似把 max_tokens 预算耗在思考上，正文为零',
      )
    }
  }
}

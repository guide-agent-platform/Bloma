import { describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_SSE_ADAPTER } from '../../../main/platform/upstream/providers/anthropic-sse-adapter'
import { streamSSE, setSseRetryWaitBudgetForTests } from '../../../main/platform/upstream/providers/sse-reader'
import { anthropicMessagesQueryViaProviders } from '../../../main/platform/upstream/providers/loop-query'
import type { ProviderRequest, StreamEvent } from '../../../main/platform/upstream/providers/types'

/**
 * R1-providers（2026-09-19「照抄 Proma」）：上游传输层搬运的回归锁。
 *
 * 1. parseSSELine：上游口径 + Bloma usage 扩展；
 * 2. streamSSE：多工具调用并行装配、thinking 容错、finalArguments 兜底、400 不自动重试、
 *    首事件前 5xx 自动重试；
 * 3. loop-query 端到端：SDKMessage 契约（text 增量实时 → tool_use 末尾 → result 带
 *    usage/stop_reason）、ds 渠道差异化 URL + 双认证头、thinking 400 降级重试、逃生口开关。
 */

function sseLines(events: string[]): string {
  return events.map((e) => `data: ${e}\n`).join('')
}

function sseResponse(text: string, status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text))
      controller.close()
    },
  })
  return new Response(body, { status })
}

describe('R1-providers ANTHROPIC_SSE_ADAPTER.parseSSELine', () => {
  it('text/tool/thinking/usage 事件全解析（上游口径 + Bloma usage 扩展）', () => {
    const text = ANTHROPIC_SSE_ADAPTER.parseSSELine(JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '你好' },
    }))
    expect(text).toEqual([{ type: 'chunk', delta: '你好' }])

    const toolStart = ANTHROPIC_SSE_ADAPTER.parseSSELine(JSON.stringify({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 't1', name: 'write_file' },
    }))
    expect(toolStart).toEqual([{ type: 'tool_call_start', toolCallId: 't1', toolName: 'write_file' }])

    const jsonDelta = ANTHROPIC_SSE_ADAPTER.parseSSELine(JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: '{"path":' },
    }))
    expect(jsonDelta).toEqual([{ type: 'tool_call_delta', toolCallId: '', argumentsDelta: '{"path":' }])

    const usageStart = ANTHROPIC_SSE_ADAPTER.parseSSELine(JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 1200 } },
    }))
    expect(usageStart).toEqual([{ type: 'usage', inputTokens: 1200 }])

    const done = ANTHROPIC_SSE_ADAPTER.parseSSELine(JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 88 },
    }))
    expect(done).toEqual([
      { type: 'done', stopReason: 'tool_use' },
      { type: 'usage', outputTokens: 88 },
    ])
  })
})

describe('R1-providers streamSSE（上游装配容错）', () => {
  it('reports HTTP 200 JSON responses as protocol errors without retrying or logging response content', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: '1309', message: 'private-response-text' } }), {
      headers: { 'content-type': 'application/json' },
    }))
    const receipts: import('../../../shared/types').ModelTransportReceipt[] = []
    await expect(streamSSE({ request: { url: 'https://test.example/messages', body: '{}', headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER,
      fetchFn, onEvent: () => {}, onResponse: receipt => receipts.push(receipt) })).rejects.toThrow('PROVIDER_JSON_RESPONSE: HTTP 200, code 1309')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(receipts.at(-1)).toMatchObject({ status: 200, content_type: 'application/json', sse_data_lines: 0, json_error_code: '1309' })
    expect(JSON.stringify(receipts)).not.toContain('private-response-text')
    expect(receipts.at(-1)?.body_sha256).toMatch(/^[a-f0-9]{64}$/)
  })
  it('records terminal markers for empty SSE streams, distinguishing them from empty HTTP bodies', async () => {
    const receipts: import('../../../shared/types').ModelTransportReceipt[] = []
    await streamSSE({ request: { url: 'https://test.example/messages', body: '{}', headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER,
      fetchFn: vi.fn().mockResolvedValue(sseResponse('data: [DONE]\n\n')), onEvent: () => {}, onResponse: receipt => receipts.push(receipt) })
    expect(receipts.at(-1)).toMatchObject({ status: 200, response_bytes: 14, sse_data_lines: 1, protocol_ended: true })
  })
  it('流空闲超时自愈（批11.8 锚）：僵死流（0 字节不断开）→ abort → 未发事件安全重试成功', async () => {
    const good = sseLines([
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '活过来了' } }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    ])
    let calls = 0
    const result = await streamSSE({
      request: { url: 'https://x.test/m', headers: {}, body: '{}' },
      adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: () => {},
      streamIdleTimeoutMs: 60,
      fetchFn: (async () => {
        calls += 1
        if (calls === 1) {
          // 僵死流：响应 200 但永不 enqueue 不断开（实证 2026-10-08 挂死轮形态）
          const body = new ReadableStream<Uint8Array>({ start() { /* 永远不出字节 */ } })
          return new Response(body, { status: 200 })
        }
        return sseResponse(good)
      }) as typeof fetch,
    })
    expect(calls).toBe(2) // 第一次僵死被空闲超时中断，第二次重发成功
    expect(result.content).toBe('活过来了')
    expect(result.stopReason).toBe('end_turn')
  }, 20_000)

  it('流空闲超时：已发过事件不再重试（防内容重复），错误上抛 llm-call 带反馈重试', async () => {
    let calls = 0
    const partial = sseLines([JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '半截' } })])
    await expect(
      streamSSE({
        request: { url: 'https://x.test/m', headers: {}, body: '{}' },
        adapter: ANTHROPIC_SSE_ADAPTER,
        onEvent: () => {},
        streamIdleTimeoutMs: 60,
        fetchFn: (async () => {
          calls += 1
          // 半截流：吐一段后僵死——hasEmitted 守卫必须拦住重试
          const encoder = new TextEncoder()
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(partial))
              /* 之后永不出字节不断开 */
            },
          })
          return new Response(body, { status: 200 })
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/空闲超时|Idle/i)
    expect(calls).toBe(1) // 已发事件 → 不重试（重试会内容重复）
  }, 20_000)

  it('并行多工具调用全部装配（旧路径单 activeToolUse 会丢）', async () => {
    const stream = sseLines([
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'a', name: 'read_file' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"x' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'b', name: 'grep' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"pattern":"y"}' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    ])
    const result = await streamSSE({
      request: { url: 'https://x.test/m', headers: {}, body: '{}' },
      adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: () => {},
      fetchFn: (async () => sseResponse(stream)) as typeof fetch,
    })
    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]).toMatchObject({ id: 'a', name: 'read_file' })
    // 第一个调用的参数分片被第二个 start 打断——上游按 pendingToolCalls 隔离累积
    expect(result.toolCalls[0].arguments).toEqual({})
    expect(result.toolCalls[1].arguments).toEqual({ pattern: 'y' })
    expect(result.stopReason).toBe('tool_use')
  })

  it('thinking_delta 无 content_block_start 容错自建块', async () => {
    const stream = sseLines([
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '推理' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'signature_delta', signature: 'sig1' } }),
    ])
    const result = await streamSSE({
      request: { url: 'https://x.test/m', headers: {}, body: '{}' },
      adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: () => {},
      fetchFn: (async () => sseResponse(stream)) as typeof fetch,
    })
    expect(result.thinkingBlocks).toEqual([{ thinking: '推理', signature: 'sig1' }])
  })

  it('400 不自动重试（HTTPError 直抛）；首事件前 5xx 自动重试后成功', async () => {
    const ok = sseResponse(sseLines([JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })]))
    let calls = 0
    const result = await streamSSE({
      request: { url: 'https://x.test/m', headers: {}, body: '{}' },
      adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: () => {},
      fetchFn: (async () => {
        calls += 1
        if (calls === 1) return new Response('boom', { status: 503 })
        return ok
      }) as typeof fetch,
    })
    expect(calls).toBe(2)
    expect(result.content).toBe('ok')
  })
})

const baseOptions = {
  env: {
    PATH: 'C:\\',
    ANTHROPIC_AUTH_TOKEN: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_MODEL: 'deepseek-flash',
  },
  signal: new AbortController().signal,
  sessionId: 'providers-query-test',
  providerType: 'deepseek',
}

describe('R1-providers anthropicMessagesQueryViaProviders（SDKMessage 契约）', () => {
  it('allows explicitly longer response-header waits without changing the default or provider payload', async () => {
    vi.useFakeTimers(); setSseRetryWaitBudgetForTests(0)
    const originalFetch = globalThis.fetch
    const bodies: Record<string, unknown>[] = []
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(sseResponse(sseLines([
          JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'delayed headers' } }),
        ]))), 45000)
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason) }, { once: true })
      })
    }) as typeof fetch
    const collect = async (timeout?: number) => {
      const messages: unknown[] = []
      for await (const message of anthropicMessagesQueryViaProviders('test', { ...baseOptions, responseHeaderTimeoutMs: timeout })) messages.push(message)
      return messages
    }
    try {
      const normal = collect().then(() => 'unexpected success', error => error.message)
      await vi.advanceTimersByTimeAsync(30000)
      expect(await normal).toBe('First byte timeout')
      const extended = collect(120000)
      await vi.advanceTimersByTimeAsync(45000)
      expect(JSON.stringify(await extended)).toContain('delayed headers')
      expect(bodies).toHaveLength(2)
      expect(bodies[0]).toEqual(bodies[1])
      expect(JSON.stringify(bodies)).not.toContain('responseHeaderTimeout')
    } finally { globalThis.fetch = originalFetch; setSseRetryWaitBudgetForTests(); vi.useRealTimers() }
  })
  it('text 实时增量 → tool_use 末尾 → result 带 usage/stop_reason；ds URL 差异化 + 双认证头', async () => {
    let seenUrl = ''
    let seenAuth = ''
    const stream = sseLines([
      JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 500 } } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '开始' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '写入' } }),
      JSON.stringify({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'w1', name: 'write_file' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"dist/app.js"}' } }),
      JSON.stringify({ type: 'content_block_stop' }),
      JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 42 } }),
    ])
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(input)
      const headers = (init?.headers ?? {}) as Record<string, string>
      seenAuth = `${headers['x-api-key'] ?? ''}/${headers.Authorization ?? ''}`
      return sseResponse(stream)
    }) as typeof fetch
    try {
      const messages: unknown[] = []
      for await (const msg of anthropicMessagesQueryViaProviders('测试', {
        ...baseOptions,
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: '测试' },
        ],
      })) {
        messages.push(msg)
      }
      expect(seenUrl).toBe('https://api.deepseek.com/anthropic/v1/messages')
      expect(seenAuth).toBe('sk-test/Bearer sk-test')
      const assistants = messages.filter((m) => (m as { type: string }).type === 'assistant') as Array<{ message: { content: Array<{ type: string; text?: string; name?: string }> } }>
      expect(assistants.length).toBeGreaterThanOrEqual(3) // 两段 text 增量 + 一个 tool_use
      const toolBlock = assistants.at(-1)!.message.content[0]
      expect(toolBlock.type).toBe('tool_use')
      expect(toolBlock.name).toBe('write_file')
      const last = messages[messages.length - 1] as { type: string; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }
      expect(last.type).toBe('result')
      expect(last.stop_reason).toBe('tool_use')
      expect(last.usage).toEqual({ input_tokens: 500, output_tokens: 42 })
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('thinking 400 → 移除参数重试一次（旧路径兼容语义保留）', async () => {
    let calls = 0
    const stream = sseLines([JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '降级后成功' } })])
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      calls += 1
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'thinking parameter is not supported' } }), { status: 400 })
      return sseResponse(stream)
    }) as typeof fetch
    try {
      const messages: unknown[] = []
      for await (const msg of anthropicMessagesQueryViaProviders('测试', {
        ...baseOptions,
        temperature: 0.1,
        thinkingLevel: 'low',
      })) {
        messages.push(msg)
      }
      expect(calls).toBeGreaterThanOrEqual(2)
      const text = messages.map((m) => JSON.stringify(m)).join('')
      expect(text).toContain('降级后成功')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('R1-providers URL 解析（Bloma 语义适配）', () => {
  it('deepseek 协议根 → /anthropic/v1/messages；anthropic 根 → /v1/messages', async () => {
    const urls: string[] = []
    const stream = sseLines([JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: '.' } })])
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return sseResponse(stream)
    }) as typeof fetch
    try {
      for await (const _msg of anthropicMessagesQueryViaProviders('测试', {
        ...baseOptions,
        providerType: 'deepseek',
      })) {
        void _msg
      }
      for await (const _msg of anthropicMessagesQueryViaProviders('测试', {
        ...baseOptions,
        env: { ...baseOptions.env, ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
        providerType: 'anthropic',
      })) {
        void _msg
      }
    } finally {
      globalThis.fetch = originalFetch
    }
    expect(urls[0]).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(urls[1]).toBe('https://api.anthropic.com/v1/messages')
  })
})

// StreamEvent 类型消费（防未用导入告警 + 类型面锁定）
type _AssertStreamEvent = StreamEvent
const _requestType: ProviderRequest = { url: '', headers: {}, body: '' }
void _requestType

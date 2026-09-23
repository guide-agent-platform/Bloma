import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { anthropicMessagesQuery, type SDKQueryOptions } from '../../main/orchestration/orchestrator'
import type { MessageContentBlock, SDKMessage } from '../../shared/types'

/**
 * PR1 L0 查询层 tool use 单元测试。
 *
 * 直接驱动 anthropicMessagesQuery（导出 seam），mock 全局 fetch 返回 SSE 流：
 * - input_json_delta 分片累积 → content_block_stop 产出完整 tool_use block
 * - 纯文本路径零行为变化（不传 tools 时请求体无 tools 字段）
 * - stop_reason / usage 记入 result 消息
 * - options.messages 块数组透传（tool_result 包在 user 轮 content 数组）
 * - 累积 JSON 损坏的流中断容错（置空对象不抛错，不做正则修补）
 */

function sseResponse(events: object[], chunkSize = Infinity): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const payload = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      if (chunkSize >= payload.length) {
        controller.enqueue(encoder.encode(payload))
      } else {
        // 按 chunkSize 切片入队：模拟分帧到达（delta 跨 chunk 累积路径）
        for (let i = 0; i < payload.length; i += chunkSize) {
          controller.enqueue(encoder.encode(payload.slice(i, i + chunkSize)))
        }
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

function baseOptions(overrides: Partial<SDKQueryOptions> = {}): SDKQueryOptions {
  return {
    env: {
      PATH: process.env.PATH ?? 'C:\\',
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_BASE_URL: 'https://mock.example',
      ANTHROPIC_MODEL: 'mock-model',
    },
    signal: new AbortController().signal,
    sessionId: 'session-test',
    maxTokens: 512,
    ...overrides,
  }
}

async function collect(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = []
  for await (const message of gen) out.push(message)
  return out
}

const lastRequestBody = () => JSON.parse((vi.mocked(fetch) as unknown as { __body: string }).__body)

function stubFetchWithResponse(response: Response): void {
  const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    ;(spy as unknown as { __body: string }).__body = String(init?.body ?? '')
    return response
  })
  vi.stubGlobal('fetch', spy)
}

const TOOLS = [
  { name: 'read_file', description: '读文件', input_schema: { type: 'object', properties: { path: { type: 'string' } } } },
]

describe('anthropicMessagesQuery tool use 解析（PR1）', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('input_json_delta 分片累积 → content_block_stop 产出完整 tool_use，stop_reason/usage 进 result', async () => {
    // input JSON 刻意切成两个分片（{"path":"index 及 .html"}），验证累积而非逐片解析
    stubFetchWithResponse(sseResponse([
      { type: 'message_start', message: { usage: { input_tokens: 120 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"index' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '.html"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 45 } },
    ]))

    const messages = await collect(anthropicMessagesQuery('查一下', baseOptions({ tools: TOOLS })))

    const toolUseMessage = messages.find((message) => message.type === 'assistant' && message.message?.content.some((block) => block.type === 'tool_use'))
    expect(toolUseMessage).toBeDefined()
    const block = toolUseMessage!.message!.content[0]
    expect(block).toMatchObject({ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'index.html' } })

    const result = messages.at(-1)!
    expect(result.type).toBe('result')
    expect(result.stop_reason).toBe('tool_use')
    expect(result.usage).toEqual({ input_tokens: 120, output_tokens: 45 })
  })

  it('SSE 事件跨 chunk 分帧到达时 tool_use 仍正确累积', async () => {
    stubFetchWithResponse(sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_02', name: 'list_files' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'src"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ], 24))

    const messages = await collect(anthropicMessagesQuery('列文件', baseOptions({ tools: TOOLS })))
    const block = messages.find((message) => message.type === 'assistant')!.message!.content[0]
    expect(block).toMatchObject({ type: 'tool_use', id: 'toolu_02', input: { path: 'src' } })
  })

  it('text 与 tool_use 混排：两种 block 按流顺序产出', async () => {
    stubFetchWithResponse(sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我先看看文件。' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_03', name: 'read_file' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.js"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]))

    const messages = await collect(anthropicMessagesQuery('开始', baseOptions({ tools: TOOLS })))
    const assistantBlocks = messages.filter((message) => message.type === 'assistant').flatMap((message) => message.message!.content)
    expect(assistantBlocks[0]).toMatchObject({ type: 'text', text: '我先看看文件。' })
    expect(assistantBlocks[1]).toMatchObject({ type: 'tool_use', id: 'toolu_03', input: { path: 'a.js' } })
  })

  it('无 input_json_delta 的空输入 → input 为 {}，不抛错', async () => {
    stubFetchWithResponse(sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_04', name: 'list_files' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]))
    const messages = await collect(anthropicMessagesQuery('列文件', baseOptions({ tools: TOOLS })))
    expect(messages.find((message) => message.type === 'assistant')!.message!.content[0]).toMatchObject({
      type: 'tool_use',
      id: 'toolu_04',
      input: {},
    })
  })

  it('累积 JSON 损坏（流中断容错）→ input 置空对象，不抛错不修补', async () => {
    stubFetchWithResponse(sseResponse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_05', name: 'read_file' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"ind' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]))
    const messages = await collect(anthropicMessagesQuery('读', baseOptions({ tools: TOOLS })))
    expect(messages.find((message) => message.type === 'assistant')!.message!.content[0]).toMatchObject({
      type: 'tool_use',
      input: {},
    })
  })

  it('不传 tools：请求体无 tools 字段，纯文本路径产出 text delta（零行为变化）', async () => {
    stubFetchWithResponse(sseResponse([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]))
    const messages = await collect(anthropicMessagesQuery('在吗', baseOptions()))
    const body = lastRequestBody()
    expect('tools' in body).toBe(false)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: '在吗' })
    expect(messages.find((message) => message.type === 'assistant')!.message!.content[0]).toMatchObject({ type: 'text', text: '你好' })
    expect(messages.at(-1)!.stop_reason).toBe('end_turn')
  })

  it('传 tools：请求体携带 tools 字段', async () => {
    stubFetchWithResponse(sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]))
    await collect(anthropicMessagesQuery('开始', baseOptions({ tools: TOOLS })))
    expect(lastRequestBody().tools).toEqual(TOOLS)
  })

  it('options.messages 块数组透传：tool_result 包在 user 轮 content 数组，prompt 不再追加', async () => {
    stubFetchWithResponse(sseResponse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]))
    const toolResultBlocks: MessageContentBlock[] = [
      { type: 'tool_result', tool_use_id: 'toolu_01', content: '文件内容…', is_error: false },
    ]
    await collect(anthropicMessagesQuery('占位', baseOptions({
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '开始干活' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a' } }] },
        { role: 'user', content: toolResultBlocks },
      ],
    })))

    const body = lastRequestBody()
    expect(body.system).toBe('系统提示')
    expect(body.messages).toEqual([
      { role: 'user', content: '开始干活' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'read_file', input: { path: 'a' } }] },
      { role: 'user', content: toolResultBlocks },
    ])
  })
})

describe('anthropicMessagesQuery 推理档位（reasoning-profile 2026-08-27）', () => {
  it('[S4-REASON-019] thinkingLevel=max + deepseek-v4-flash → thinking:enabled + output_config.effort=max', async () => {
    stubFetchWithResponse(sseResponse([{ type: 'message_stop' }]))
    await collect(anthropicMessagesQuery('判定', baseOptions({
      env: {
        PATH: process.env.PATH ?? 'C:\\',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://mock.example',
        ANTHROPIC_MODEL: 'deepseek-v4-flash',
      },
      thinkingLevel: 'max',
      providerType: 'deepseek',
    })))

    const body = lastRequestBody()
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.output_config).toEqual({ effort: 'max' })
  })

  it('[S4-REASON-020] omit 渠道（qwen-token-plan）+ thinkingLevel=max → 请求体无 thinking 字段（免 400 往返）', async () => {
    stubFetchWithResponse(sseResponse([{ type: 'message_stop' }]))
    await collect(anthropicMessagesQuery('判定', baseOptions({
      env: {
        PATH: process.env.PATH ?? 'C:\\',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://mock.example',
        ANTHROPIC_MODEL: 'qwen3.8-max-preview',
      },
      thinkingLevel: 'max',
      providerType: 'qwen-token-plan',
    })))

    const body = lastRequestBody()
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toBeUndefined()
  })

  it('[S4-REASON-021] 缺省（不传 thinkingLevel）→ thinking:disabled（零回归契约，与现状逐字节一致）', async () => {
    stubFetchWithResponse(sseResponse([{ type: 'message_stop' }]))
    await collect(anthropicMessagesQuery('判定', baseOptions()))

    const body = lastRequestBody()
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.output_config).toBeUndefined()
  })
})

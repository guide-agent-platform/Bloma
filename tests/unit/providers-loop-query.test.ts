import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * providers 传输路径请求体拼装直测（2026-10-01 补齐——web 线刀1 退役 orchestrator
 * 流式组后，anthropicMessagesQueryViaProviders 的「options → 请求体」拼装语义与
 * SSE 事件桥映射一度无直测；sse-reader 自身稳健性由上游构件口径保证）。
 * mock 边界：streamSSE（SSE 层）；请求体拼装/事件桥/结果装配全部走真实现。
 */

const h = vi.hoisted(() => ({ streamSSE: vi.fn() }))

vi.mock('../../main/platform/upstream/providers/sse-reader', () => ({
  streamSSE: h.streamSSE,
  HTTPError: class HTTPError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message)
    }
  },
}))

import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import type { SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: string
}

function opts(overrides: Partial<SDKQueryOptions> = {}): SDKQueryOptions {
  return {
    env: {
      PATH: process.env.PATH ?? 'C:\\',
      ANTHROPIC_AUTH_TOKEN: 'test-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_MODEL: 'test-model',
    },
    signal: new AbortController().signal,
    sessionId: 'session-pq-1',
    ...overrides,
  }
}

let captured: CapturedRequest | undefined

/** 默认 mock：推两段正文 + usage，无工具调用，end_turn 收尾。 */
function mockStreamOk() {
  h.streamSSE.mockImplementation(async (options: { request: CapturedRequest; onEvent: (event: unknown) => void }) => {
    captured = options.request
    options.onEvent({ type: 'chunk', delta: '你好' })
    options.onEvent({ type: 'chunk', delta: '，世界' })
    options.onEvent({ type: 'usage', inputTokens: 10, outputTokens: 5 })
    return { toolCalls: [], stopReason: 'end_turn' }
  })
}

function parsedBody(): Record<string, unknown> {
  return JSON.parse(captured!.body)
}

beforeEach(() => {
  h.streamSSE.mockReset()
  captured = undefined
})

describe('请求体拼装：历史窗口与 system 提取', () => {
  it('history 路径：system 提取到顶层；history+prompt 追加为末轮 user；maxTokens 缺省 640000；temperature/tools 透传', async () => {
    mockStreamOk()
    const tool = { name: 'read_file', description: '读文件', input_schema: { type: 'object' as const, properties: {} } }
    const out: string[] = []
    for await (const msg of anthropicMessagesQueryViaProviders('新问题', opts({
      history: [
        { role: 'system', content: '你是系统' },
        { role: 'user', content: '第一问' },
        { role: 'assistant', content: '旧答' },
      ],
      temperature: 0.3,
      tools: [tool] as SDKQueryOptions['tools'],
    }))) {
      out.push(msg.type)
    }
    const body = parsedBody()
    expect(body.system).toBe('你是系统')
    expect(body.messages).toEqual([
      { role: 'user', content: '第一问' },
      { role: 'assistant', content: '旧答' },
      { role: 'user', content: '新问题' },
    ])
    expect(body.max_tokens).toBe(640000)
    expect(body.stream).toBe(true)
    expect(body.model).toBe('test-model')
    expect(body.temperature).toBe(0.3)
    expect(body.tools).toEqual([tool])
    // 双认证头（上游 providers 口径）
    expect(captured!.headers['x-api-key']).toBe('test-key')
    expect(captured!.url).toContain('api.anthropic.com')
  })

  it('messages 原样路径：完整数组去 system 后原样作为请求 messages，prompt 被忽略', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('这个 prompt 应被忽略', opts({
      messages: [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: [{ type: 'text', text: '块轮' }] },
      ],
    }))) {
      void _
    }
    const body = parsedBody()
    expect(body.system).toBe('系统指令')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: '块轮' }] }])
  })

  it('thinking 缺省 off：未识别模型显式携带 thinking:disabled（思考型渠道零正文防线，陷阱 10）', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts())) void _
    expect(parsedBody().thinking).toEqual({ type: 'disabled' })
  })

  it.each(['messages', 'history'] as const)('%s 续接思考耗尽记录：不发送空 assistant，保留原始历史和工具配对', async (field) => {
    mockStreamOk()
    const turns: NonNullable<SDKQueryOptions['messages']> = [
      { role: 'user', content: '实现任务' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'app.py' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read-1', content: '' }] },
      // G11 实锤：只有计费思考输出的响应被存为 content:[]，续接曾触发 messages.31 HTTP 400。
      { role: 'assistant', content: [] },
      { role: 'assistant', content: '' },
      { role: 'user', content: '继续收尾' },
    ]
    const original = JSON.stringify(turns)
    for await (const _ of anthropicMessagesQueryViaProviders('续接提示', opts({ [field]: turns }))) void _
    const expected = [turns[0], turns[1], turns[2], turns[5]]
    if (field === 'history') expected.push({ role: 'user', content: '续接提示' })
    expect(parsedBody().messages).toEqual(expected)
    expect(JSON.stringify(turns)).toBe(original)
  })
})

describe('SSE 事件桥：事件 → SDKMessage 流序与结果装配', () => {
  it('chunk 逐段实时 yield；toolCalls 流末装配 tool_use 块；usage 聚合与 stop_reason 进 result', async () => {
    h.streamSSE.mockImplementation(async (options: { request: CapturedRequest; onEvent: (event: unknown) => void }) => {
      captured = options.request
      options.onEvent({ type: 'chunk', delta: '先说明' })
      options.onEvent({ type: 'usage', inputTokens: 7 })
      options.onEvent({ type: 'chunk', delta: '再调用工具' })
      options.onEvent({ type: 'usage', outputTokens: 9 })
      return {
        toolCalls: [{ id: 'toolu_1', name: 'read_file', arguments: { path: 'a.ts' } }],
        stopReason: 'tool_use',
      }
    })
    const msgs = []
    for await (const msg of anthropicMessagesQueryViaProviders('修一下', opts())) msgs.push(msg)

    expect(msgs.map((m) => m.type)).toEqual(['assistant', 'assistant', 'assistant', 'result'])
    // 正文增量逐段（UI 流式依赖）
    expect(msgs[0].message?.content).toEqual([{ type: 'text', text: '先说明' }])
    expect(msgs[1].message?.content).toEqual([{ type: 'text', text: '再调用工具' }])
    // 工具调用在正文之后（协议块序：thinking→text→tool_use）
    expect(msgs[2].message?.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } }])
    // result 收尾：usage 聚合 + stop_reason 透传（Agent Loop 续轮判定依据）
    expect(msgs[3]).toMatchObject({ type: 'result', subtype: 'success', stop_reason: 'tool_use', usage: { input_tokens: 7, output_tokens: 9 } })
  })

  it('env 前置校验：缺 PATH / 缺 AUTH_TOKEN / 缺 ANTHROPIC_MODEL 各自 fail-fast', async () => {
    const noPath = opts()
    delete noPath.env.PATH
    await expect(async () => { for await (const _ of anthropicMessagesQueryViaProviders('x', noPath)) void _ })
      .rejects.toThrow('SDK env missing PATH')

    const noKey = opts()
    delete noKey.env.ANTHROPIC_AUTH_TOKEN
    await expect(async () => { for await (const _ of anthropicMessagesQueryViaProviders('x', noKey)) void _ })
      .rejects.toThrow('CHANNEL_NOT_FOUND')

    const noModel = opts()
    delete noModel.env.ANTHROPIC_MODEL
    await expect(async () => { for await (const _ of anthropicMessagesQueryViaProviders('x', noModel)) void _ })
      .rejects.toThrow('SDK_MODEL_NOT_CONFIGURED')
  })
})

describe('max_tokens 服务端上限夹紧（2026-10-03 zhipu 事故）', () => {
  it('zhipu-coding：maxTokens 640000 → 请求体夹紧 131072（超限即 400 code 1210）', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({ providerType: 'zhipu-coding', maxTokens: 640000 }))) void _
    expect(parsedBody().max_tokens).toBe(131072)
  })

  it('zhipu-coding-team：同样夹紧；低于上限的值原样透传', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({ providerType: 'zhipu-coding-team', maxTokens: 8192 }))) void _
    expect(parsedBody().max_tokens).toBe(8192)
  })

  it('未登记上限的 provider（anthropic 缺省）：640000 统一值语义不变', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({ maxTokens: 640000 }))) void _
    expect(parsedBody().max_tokens).toBe(640000)
  })
})

describe('max_tokens 夹紧的 provider 信号兜底（2026-10-04 二次事故）', () => {
  it('options.providerType 缺省（主路现状）但 env 携带 ANTHROPIC_PROVIDER_TYPE=zhipu-coding → 仍夹紧 131072', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({
      env: {
        PATH: process.env.PATH ?? 'C:/',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_MODEL: 'glm-5.3',
        ANTHROPIC_PROVIDER_TYPE: 'zhipu-coding',
      },
      maxTokens: 640000,
    }))) void _
    expect(parsedBody().max_tokens).toBe(131072)
  })

  it('options.providerType 与 env 均无 provider 信号 → 不夹紧（未登记渠道语义不变）', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({ maxTokens: 640000 }))) void _
    expect(parsedBody().max_tokens).toBe(640000)
  })

  it('显式 options.providerType 优先于 env 兜底', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({
      env: {
        PATH: process.env.PATH ?? 'C:/',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_MODEL: 'glm-5.3',
        ANTHROPIC_PROVIDER_TYPE: 'zhipu-coding',
      },
      providerType: 'deepseek',
      maxTokens: 640000,
    }))) void _
    expect(parsedBody().max_tokens).toBe(640000)
  })
})

describe('provider 信号驱动的 URL/头部派生（2026-10-04 双事故修正）', () => {
  it('env 携带 zhipu-coding（options 缺省）：URL 补 /v1/messages（防 200 包 404 空流）+ Bearer 头 + 夹紧', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({
      env: {
        PATH: process.env.PATH ?? 'C:/',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_MODEL: 'glm-5.3',
        ANTHROPIC_PROVIDER_TYPE: 'zhipu-coding',
      },
      maxTokens: 640000,
    }))) void _
    expect(captured!.url).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
    expect(captured!.headers['Authorization']).toBe('Bearer test-key')
    expect(captured!.headers['x-api-key']).toBeUndefined()
    expect(parsedBody().max_tokens).toBe(131072)
  })

  it('env 携带 deepseek：URL 补 /v1/messages；双认证头维持', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts({
      env: {
        PATH: process.env.PATH ?? 'C:/',
        ANTHROPIC_AUTH_TOKEN: 'test-key',
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
        ANTHROPIC_MODEL: 'deepseek-flash',
        ANTHROPIC_PROVIDER_TYPE: 'deepseek',
      },
      maxTokens: 640000,
    }))) void _
    expect(captured!.url).toBe('https://api.deepseek.com/anthropic/v1/messages')
    expect(captured!.headers['x-api-key']).toBe('test-key')
    expect(parsedBody().max_tokens).toBe(640000)
  })

  it('无任何 provider 信号：缺省 anthropic 语义不变（根域 base 补 /v1）', async () => {
    mockStreamOk()
    for await (const _ of anthropicMessagesQueryViaProviders('问', opts())) void _
    expect(captured!.url).toBe('https://api.anthropic.com/v1/messages')
    expect(captured!.headers['x-api-key']).toBe('test-key')
  })
})

describe('流式增量即时投递（2026-10-04 假流式修复）', () => {
  it('chunk 入队即唤醒：消费者在流结束前收到增量（旧实现会死锁到超时）', async () => {
    let releaseSecond!: () => void
    const secondArrived = new Promise<void>((resolve) => { releaseSecond = resolve })
    h.streamSSE.mockImplementation(async (options: { onEvent: (event: unknown) => void }) => {
      options.onEvent({ type: 'chunk', delta: '第一段' })
      await secondArrived // 等测试方确认已提前收到第一段，才放行第二段与流结束
      options.onEvent({ type: 'chunk', delta: '第二段' })
      return { toolCalls: [], stopReason: 'end_turn' }
    })
    const gen = anthropicMessagesQueryViaProviders('问', opts())
    // 若为假流式：next() 要等 streamSSE 结束，而它等 secondArrived——死锁到测试超时红
    const first = await gen.next()
    expect(first.done).toBe(false)
    expect(JSON.stringify(first.value)).toContain('第一段')
    releaseSecond()
    let sawSecond = false
    for await (const msg of gen) {
      if (msg.type === 'assistant' && JSON.stringify(msg).includes('第二段')) sawSecond = true
    }
    expect(sawSecond).toBe(true)
  })
})

describe('思考增量透出（2026-10-04）', () => {
  it('reasoning 事件 → thinking SDKMessage 逐段产出（入队即 wake）', async () => {
    h.streamSSE.mockImplementation(async (options: { onEvent: (event: unknown) => void }) => {
      options.onEvent({ type: 'reasoning', delta: '先想第一步' })
      options.onEvent({ type: 'reasoning', delta: '，再想第二步' })
      options.onEvent({ type: 'chunk', delta: '正文' })
      return { toolCalls: [], stopReason: 'end_turn' }
    })
    const thinkingTexts: string[] = []
    let sawText = false
    for await (const msg of anthropicMessagesQueryViaProviders('问', opts())) {
      if (msg.type === 'thinking') thinkingTexts.push(msg.thinking ?? '')
      if (msg.type === 'assistant' && JSON.stringify(msg).includes('正文')) sawText = true
    }
    expect(thinkingTexts).toEqual(['先想第一步', '，再想第二步'])
    expect(sawText).toBe(true)
  })
})

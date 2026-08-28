import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAgentLoop, estimateBlocksText, type AgentLoopInput } from '../../main/agent-loop'
import { anthropicMessagesQuery } from '../../main/orchestrator'
import type { MessageContentBlock, SDKMessage } from '../../shared/types'
import type { ConversationTurn, SDKQuery, SDKQueryOptions } from '../../main/orchestrator'
import { getAgentSessionPath } from '../../storage/config-paths'
import { savePastedImage } from '../../main/pasted-images'

/**
 * 剪贴板图片粘贴 P1（clipboard-image-paste，2026-08-29 r67）：loop 侧贯通 + JSONL 契约 + API 边界水合。
 *
 * 契约锁定（核心不变量）：image 以 imageId 短引用走全链（内存/JSONL/模型历史），base64 只在
 * anthropicMessagesQuery 请求体出现（水合产物）——原型 8d：800KB 截图直落 base64 每次 +1064KB。
 */

const PNG_1PX_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function scriptedQueryWithCapture(responses: SDKMessage[][]): { query: SDKQuery; received: ConversationTurn[][] } {
  let call = 0
  const received: ConversationTurn[][] = []
  const query: SDKQuery = async function* (_prompt: string, options: SDKQueryOptions) {
    received.push((options.messages ?? []).map((turn) => ({ ...turn })))
    const script = responses[Math.min(call, responses.length - 1)] ?? []
    call += 1
    for (const message of script) yield message
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
  return { query, received }
}

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    system: '测试系统提示',
    task: '看看这张图',
    tools: [],
    query: async function* () {
      yield { type: 'result', subtype: 'success' }
    },
    env: {},
    sessionId: 'session-paste',
    projectId: 'project-paste',
    requestId: 'req-paste',
    maxTokens: 256,
    maxTurns: 6,
    permissionMode: 'allow-all',
    signal: new AbortController().signal,
    publish: () => undefined,
    ...overrides,
  }
}

function readSessionJsonl(sessionId: string): Array<{ role: string; content: MessageContentBlock[] }> {
  return readFileSync(getAgentSessionPath(sessionId), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

describe('runAgentLoop 图片贯通（clipboard-paste）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-paste-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    vi.restoreAllMocks()
  })

  it('[S4-AGENT-090] input.images → 首条 user 轮 content=[text,...image 短引用] 进模型 messages', async () => {
    const saved = savePastedImage('session-paste', PNG_1PX_BASE64, 'png')
    const { query, received } = scriptedQueryWithCapture([[textMessage('收到图')]])
    const result = await runAgentLoop(
      baseInput({ query, images: [{ imageId: saved.imageId, media_type: saved.media_type }] }),
    )
    expect(result.status).toBe('completed')
    const firstUser = received[0].find((t) => t.role === 'user')
    const blocks = firstUser?.content as MessageContentBlock[]
    expect(Array.isArray(blocks)).toBe(true)
    expect(blocks[0]).toEqual({ type: 'text', text: '看看这张图' })
    expect(blocks[1]).toMatchObject({ type: 'image', imageId: saved.imageId, media_type: 'image/png' })
    // 模型 messages 里也不该有 base64（水合只发生在 anthropicMessagesQuery 边界）
    expect(JSON.stringify(received)).not.toContain(PNG_1PX_BASE64)
  })

  it('[S4-AGENT-091] JSONL 落盘契约：user 轮含 imageId 短引用、全文无 base64（防膨胀核心不变量）', async () => {
    const saved = savePastedImage('session-paste', PNG_1PX_BASE64, 'png')
    const { query } = scriptedQueryWithCapture([[textMessage('收到图')]])
    await runAgentLoop(baseInput({ query, images: [{ imageId: saved.imageId, media_type: saved.media_type }] }))
    const jsonl = readSessionJsonl('session-paste')
    const userTurn = jsonl.find((m) => m.role === 'user')
    expect(userTurn?.content.some((b) => b.type === 'image' && b.imageId === saved.imageId)).toBe(true)
    // 全文无 base64 载荷（PNG_1PX_BASE64 即 96 字符真实载荷）
    expect(readFileSync(getAgentSessionPath('session-paste'), 'utf8')).not.toContain(PNG_1PX_BASE64)
  })

  it('[S4-AGENT-092] 无 images 时行为与现状完全一致（task string 轮，回归保护）', async () => {
    const { query, received } = scriptedQueryWithCapture([[textMessage('好的')]])
    await runAgentLoop(baseInput({ query }))
    const firstUser = received[0].find((t) => t.role === 'user')
    expect(firstUser?.content).toContain('看看这张图')
  })

  it('[S4-AGENT-093] fuzz：images 含畸形项（缺 imageId/非法类型/非对象）被安全忽略不崩 loop', async () => {
    const { query, received } = scriptedQueryWithCapture([[textMessage('好的')]])
    const result = await runAgentLoop(
      baseInput({
        query,
        images: [
          { media_type: 'image/png' } as unknown as { imageId: string; media_type: string },
          { imageId: '../../etc/passwd', media_type: 'image/png' },
          null as unknown as { imageId: string; media_type: string },
          'str' as unknown as { imageId: string; media_type: string },
        ],
      }),
    )
    expect(result.status).toBe('completed')
    // 畸形项全部被滤除：合法 image 块为 0 → task 退化为纯 string 轮（与无图现状一致）
    const firstUser = received[0].find((t) => t.role === 'user')
    expect(typeof firstUser?.content).toBe('string')
  })
})

describe('estimateBlocksText 图片口径（usage-guard 正确性加固）', () => {
  it('[S4-AGENT-094] image 块贡献 [图片] 占位而非空串/丢帧；既有三类口径不变', () => {
    const blocks: MessageContentBlock[] = [
      { type: 'text', text: '正文' },
      { type: 'image', imageId: 's/x.png', media_type: 'image/png' },
      { type: 'tool_use', id: 't1', name: 'edit_file', input: { a: 1 } },
      { type: 'tool_result', tool_use_id: 't1', content: '结果' },
    ]
    const text = estimateBlocksText(blocks)
    expect(text).toContain('正文')
    expect(text).toContain('[图片]')
    expect(text).toContain('结果')
    // 纯 image 块数组也不空
    expect(estimateBlocksText([{ type: 'image', imageId: 's/x.png', media_type: 'image/png' }])).toBe('[图片]')
  })
})

describe('anthropicMessagesQuery 入口水合（API 边界统一）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-paste-api-'))
  })
  afterEach(() => {
    restorePromaHome(originalPromaHome)
    vi.unstubAllGlobals()
  })

  function sseResponse(events: unknown[]): Response {
    const body = events
      .map((e) => `event: ${String((e as { type: string }).type)}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('')
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }

  it('[S4-AGENT-095] 请求体 messages 的 image 块被水合为 base64 source；调用方输入对象不被突变', async () => {
    const saved = savePastedImage('session-api', PNG_1PX_BASE64, 'png')
    let requestBody: { messages?: Array<{ content: unknown }> } | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body))
        return sseResponse([{ type: 'message_stop' }])
      }),
    )
    const turns: ConversationTurn[] = [
      { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image', imageId: saved.imageId, media_type: 'image/png' }] },
    ]
    await collect(anthropicMessagesQuery('主任务', {
      env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'k', ANTHROPIC_BASE_URL: 'https://mock.example', ANTHROPIC_MODEL: 'm' },
      signal: new AbortController().signal,
      sessionId: 'session-api',
      messages: turns,
    }))
    const sent = requestBody?.messages?.[0]?.content as MessageContentBlock[]
    expect(sent[1].source).toEqual({ type: 'base64', media_type: 'image/png', data: PNG_1PX_BASE64 })
    // 调用方数组不被突变（水合产物只在请求体）
    expect((turns[0].content as MessageContentBlock[])[1].source).toBeUndefined()
  })

  async function collect(gen: AsyncGenerator<SDKMessage>): Promise<SDKMessage[]> {
    const out: SDKMessage[] = []
    for (;;) {
      const next = await gen.next()
      if (next.done) return out
      out.push(next.value)
    }
  }
})

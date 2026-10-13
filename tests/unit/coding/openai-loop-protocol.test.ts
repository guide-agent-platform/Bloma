import { describe, expect, it, vi } from 'vitest'
import { OPENAI_LOOP_ADAPTER, openAiLoopBody } from '../../../main/platform/upstream/providers/openai-loop-protocol'
import { anthropicMessagesQueryViaProviders } from '../../../main/platform/upstream/providers/loop-query'

describe('regular GLM API protocol', () => {
  it('converts tool continuation and reasoning history, preserving all tool result IDs', () => {
    const body = openAiLoopBody({ model: 'glm-5.3', max_tokens: 8192, system: 'system', thinking: { type: 'adaptive' }, output_config: { effort: 'low' },
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }], messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan' }, { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: [{ type: 'text', text: 'file result' }] }, { type: 'text', text: 'continue' }] }] })
    expect(body.messages).toEqual([{ role: 'system', content: 'system' }, { role: 'assistant', content: null, reasoning_content: 'plan',
      tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'file result' }, { role: 'user', content: 'continue' }])
    expect(body.reasoning_effort).toBe('low')
    expect(body.stream_options).toEqual({ include_usage: true })
  })
  it('uses output indexes for interleaved argument fragments and reports normalized cached usage', () => {
    expect(OPENAI_LOOP_ADAPTER.parseSSELine(JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b"}' } }] } }] })))
      .toEqual([{ type: 'tool_call_delta', toolCallId: '', argumentsDelta: '"b"}', metadata: { outputIndex: 'oa:1' } }])
    expect(OPENAI_LOOP_ADAPTER.parseSSELine('{"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":40}}}'))
      .toEqual([{ type: 'usage', inputTokens: 60, outputTokens: 10, cacheReadInputTokens: 40 }])
  })
  it('native query sends regular API authentication and assembles indexed parallel tool calls', async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":' } }, { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '"b"}' } }, { index: 0, function: { arguments: '"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } } ]
    const fetchMock = vi.fn().mockResolvedValue(new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n'))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const messages = []
      for await (const message of anthropicMessagesQueryViaProviders('probe', { sessionId: 'test', signal: new AbortController().signal,
        env: { PATH: 'test', ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4', ANTHROPIC_MODEL: 'glm-5.3', ANTHROPIC_PROVIDER_TYPE: 'zhipu' }, maxTokens: 8192, thinkingLevel: 'low' })) messages.push(message)
      expect(fetchMock.mock.calls[0][0]).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions')
      expect(fetchMock.mock.calls[0][1].headers).toEqual({ authorization: 'Bearer test', 'content-type': 'application/json' })
      expect(messages.filter(m => m.type === 'assistant').map(m => m.message?.content)).toEqual([
        [{ type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a' } }], [{ type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b' } }] ])
      expect(messages.at(-1)?.usage).toEqual({ input_tokens: 100, output_tokens: 10 })
    } finally { vi.unstubAllGlobals() }
  })
})

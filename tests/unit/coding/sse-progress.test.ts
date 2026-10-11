import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANTHROPIC_SSE_ADAPTER } from '../../../main/platform/upstream/providers/anthropic-sse-adapter'
import { setSseRetryWaitBudgetForTests, streamSSE } from '../../../main/platform/upstream/providers/sse-reader'
import { anthropicMessagesQueryViaProviders } from '../../../main/platform/upstream/providers/loop-query'

const request = { url: 'https://fixture.invalid', headers: {}, body: '{}' }
const line = (data: unknown) => `data: ${JSON.stringify(data)}\n\n`
const text = (value: string) => line({ type: 'content_block_delta', delta: { type: 'text_delta', text: value } })
function openStream(initial: string, progress = false) {
  const encoder = new TextEncoder()
  let interval: ReturnType<typeof setInterval>
  const cancelled = vi.fn(() => clearInterval(interval))
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (initial) controller.enqueue(encoder.encode(initial))
      let ticks = 0
      interval = setInterval(() => {
        ticks++
        controller.enqueue(encoder.encode(progress ? text('继续') : ': heartbeat\n\n'))
        if (progress && ticks === 12) controller.enqueue(encoder.encode(line({ type: 'message_stop' })))
      }, 10)
    }, cancel: cancelled,
  })
  const fetchFn = vi.fn(async () => new Response(stream)) as unknown as typeof fetch
  return { fetchFn, cancelled }
}
describe('SSE semantic progress and protocol completion', () => {
  beforeEach(() => { vi.useFakeTimers(); setSseRetryWaitBudgetForTests(0) })
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setSseRetryWaitBudgetForTests() })
  it('heartbeats cannot keep a request alive without progress', async () => {
    const fixture = openStream('')
    const outcome = streamSSE({ request, adapter: ANTHROPIC_SSE_ADAPTER, onEvent() {}, ...fixture, streamProgressTimeoutMs: 40, streamIdleTimeoutMs: 100 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(60)
    expect((await outcome).name).toBe('StreamProgressTimeoutError')
    expect(fixture.cancelled).toHaveBeenCalledTimes(1)
    expect(fixture.fetchFn).toHaveBeenCalledTimes(1)
  })
  it('partial text followed by heartbeats fails without duplicating the request', async () => {
    const fixture = openStream(text('半截'))
    const outcome = streamSSE({ request, adapter: ANTHROPIC_SSE_ADAPTER, onEvent() {}, ...fixture, streamProgressTimeoutMs: 40 }).catch(e => e)
    await vi.advanceTimersByTimeAsync(60)
    expect((await outcome).name).toBe('StreamProgressTimeoutError')
    expect(fixture.fetchFn).toHaveBeenCalledTimes(1)
  })
  it.each(['anthropic', 'sentinel'])('settles %s terminal markers without waiting for EOF and preserves usage', async marker => {
    const events: string[] = []
    const fixture = openStream(text('完成') + line({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) +
      (marker === 'anthropic' ? line({ type: 'message_stop' }) : 'data: [DONE]\n\n'))
    const result = await streamSSE({ request, adapter: ANTHROPIC_SSE_ADAPTER, onEvent: e => events.push(e.type), ...fixture })
    expect(result).toMatchObject({ content: '完成', stopReason: 'end_turn' })
    expect(events).toContain('usage')
    expect(fixture.cancelled).toHaveBeenCalledTimes(1)
  })
  it('genuine progress can continue longer than the idle budget', async () => {
    const fixture = openStream('', true)
    const outcome = streamSSE({ request, adapter: ANTHROPIC_SSE_ADAPTER, onEvent() {}, ...fixture, streamProgressTimeoutMs: 40 })
    await vi.advanceTimersByTimeAsync(150)
    expect((await outcome).content).toBe('继续'.repeat(12))
  })
  it('hands complete tool parameters back to the actual SDK query without network EOF', async () => {
    const fixture = openStream(
      line({ type: 'content_block_start', content_block: { type: 'tool_use', id: 'read-1', name: 'read_file' } }) +
      line({ type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"path":"app.py"}' } }) +
      line({ type: 'content_block_stop' }) +
      line({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }) +
      line({ type: 'message_stop' }),
    )
    vi.stubGlobal('fetch', fixture.fetchFn)
    const messages = []
    for await (const message of anthropicMessagesQueryViaProviders('', {
      env: { PATH: 'fixture', ANTHROPIC_AUTH_TOKEN: 'test-not-a-key', ANTHROPIC_BASE_URL: 'https://fixture.invalid', ANTHROPIC_MODEL: 'fixture-model' },
      signal: new AbortController().signal, sessionId: 'sse-sdk-fixture', messages: [{ role: 'user', content: 'read' }],
    })) messages.push(message)
    expect(messages.find(m => m.message?.content.some(b => b.type === 'tool_use'))?.message?.content).toContainEqual({ type: 'tool_use', id: 'read-1', name: 'read_file', input: { path: 'app.py' } })
    expect(messages.at(-1)).toMatchObject({ type: 'result', stop_reason: 'tool_use', usage: { output_tokens: 8 } })
    expect(fixture.cancelled).toHaveBeenCalledTimes(1)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { anthropicMessagesQueryViaProviders } from '../../main/platform/upstream/providers/loop-query'
import { savePastedImage } from '../../main/platform/shell/pasted-images'
import { restorePromaHome } from '../support/proma-home-guard'

describe('DeepSeek screenshot transport', () => {
  const original = process.env.PROMA_HOME
  let home: string
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-vision-transport-')); process.env.PROMA_HOME = home })
  afterEach(() => { vi.unstubAllGlobals(); restorePromaHome(original); rmSync(home, { recursive: true, force: true }) })
  it('hydrates local images and sends actual OpenAI image blocks; text-only stays on Anthropic', async () => {
    const requests: Array<{ url: string; body: any }> = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init.body)) })
      const text = url.endsWith('/chat/completions')
        ? 'data: {"choices":[{"delta":{"content":"seen"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":1}}\n\ndata: [DONE]\n\n'
        : 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"text"}}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n'
      return new Response(text, { headers: { 'content-type': 'text/event-stream' } })
    })
    vi.stubGlobal('fetch', fetch)
    const image = savePastedImage('vision', Buffer.from('test-image-bytes').toString('base64'), 'png')
    const env = { PATH: process.env.PATH ?? 'path', ANTHROPIC_AUTH_TOKEN: 'synthetic-test-key', ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic', ANTHROPIC_MODEL: 'deepseek-flash', ANTHROPIC_PROVIDER_TYPE: 'deepseek' }
    const guard = vi.fn()
    for await (const _ of anthropicMessagesQueryViaProviders('compare', { env, sessionId: 'vision', signal: new AbortController().signal, images: [image], maxTokens: 128, requestGuard: guard })) {}
    expect(requests[0]!.url).toBe('https://api.deepseek.com/chat/completions')
    const blocks = requests[0]!.body.messages.at(-1).content
    expect(blocks.find((row: any) => row.type === 'image_url').image_url.url).toBe('data:image/png;base64,' + Buffer.from('test-image-bytes').toString('base64'))
    expect(guard).toHaveBeenCalledTimes(1)
    for await (const _ of anthropicMessagesQueryViaProviders('text', { env, sessionId: 'vision', signal: new AbortController().signal, maxTokens: 128 })) {}
    expect(requests[1]!.url).toContain('/anthropic/')
    expect(requests[1]!.body.messages.at(-1).content).toBe('text')
  })
})

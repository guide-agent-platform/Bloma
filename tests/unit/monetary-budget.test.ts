import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fetchWithMonetaryBudget, reserveModelRequest } from '../../main/platform/llm/monetary-budget'
import { streamSSE } from '../../main/platform/upstream/providers/sse-reader'
import { ANTHROPIC_SSE_ADAPTER } from '../../main/platform/upstream/providers/anthropic-sse-adapter'

const roots: string[] = []
function fixture(cap = 3) {
  const root = mkdtempSync(join(tmpdir(), 'bloma-money-')); roots.push(root)
  const path = join(root, 'policy.json')
  writeFileSync(path, JSON.stringify({ version: 1, models: [{ host: 'api.example.com', model: 'M1', cap_rmb: cap,
    context_tokens: 1_000_000, input_rmb_per_million: 2, output_rmb_per_million: 8, cache_rmb_per_million: 0.04 }] }))
  return path
}
const url = 'https://api.example.com/v1/messages'
const body = JSON.stringify({ model: 'M1', max_tokens: 1000, messages: [] })
const state = (path: string) => JSON.parse(readFileSync(`${path}.state.json`, 'utf8'))
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('shared monetary ceiling', () => {
  it('reserves concurrently across homes/restarts and settles cached usage at peak rates', () => {
    const path = fixture()
    const first = reserveModelRequest(url, body, path)!
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_BUDGET_EXHAUSTED')
    first.settle({ input_tokens: 1000, cache_read_input_tokens: 2000, output_tokens: 20 }, true)
    expect(state(path).entries[0].charged_micro_rmb).toBe(2240)
    expect(reserveModelRequest(url, body, path)).toBeDefined()
  })
  it('unknown failures and incomplete usage keep full reservations for every attempt', () => {
    const path = fixture(5)
    reserveModelRequest(url, body, path)!.settle(undefined, false)
    reserveModelRequest(url, body, path)!.settle({ input_tokens: 10 }, true)
    expect(state(path).entries.map((row: { charged_micro_rmb: number }) => row.charged_micro_rmb)).toEqual([2008000, 2008000])
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_BUDGET_EXHAUSTED')
  })
  it('rejects unknown models, missing output bounds, policy changes and corrupt state', () => {
    const path = fixture()
    expect(() => reserveModelRequest(url, '{}', path)).toThrow('MONETARY_MODEL_NOT_ALLOWED')
    expect(() => reserveModelRequest(url, '{"model":"M1"}', path)).toThrow('MONETARY_OUTPUT_LIMIT_REQUIRED')
    reserveModelRequest(url, body, path)
    writeFileSync(path, readFileSync(path, 'utf8') + '\n')
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_STATE_INVALID')
    writeFileSync(`${path}.state.json`, '{}')
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_STATE_INVALID')
  })
  it('fails before the physical stream fetch and does not retry a budget refusal', async () => {
    vi.stubEnv('BLOMA_MONETARY_POLICY', fixture(1))
    const fetchFn = vi.fn()
    await expect(streamSSE({ request: { url, body, headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: () => {}, fetchFn })).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it('settles streamed final usage and separately guards non-streaming probes', async () => {
    const path = fixture(); vi.stubEnv('BLOMA_MONETARY_POLICY', path)
    const lines = [ { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' } ]
    await streamSSE({ request: { url, body, headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER, onEvent: () => {},
      fetchFn: vi.fn().mockResolvedValue(new Response(lines.map(row => `data: ${JSON.stringify(row)}\n\n`).join(''))) })
    await fetchWithMonetaryBudget(url, { body }, vi.fn().mockResolvedValue(new Response(JSON.stringify({ usage: {
      prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } }))))
    expect(state(path).entries.map((row: { charged_micro_rmb: number }) => row.charged_micro_rmb)).toEqual([360, 262])
  })
})

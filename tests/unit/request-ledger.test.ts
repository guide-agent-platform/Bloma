import { appendFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { accountSdkQuery, normalizeHttpUsage, readProjectUsage, startDirectQuery } from '../../main/platform/llm/request-ledger'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'
import { restorePromaHome } from '../support/proma-home-guard'
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'request-ledger-')); process.env.PROMA_HOME = home })
afterEach(() => { restorePromaHome(process.env.PROMA_HOME); rmSync(home, { recursive: true, force: true }) })
const options = (role = 'orchestrator'): SDKQueryOptions => ({ sessionId: role, signal: new AbortController().signal,
  env: { ANTHROPIC_MODEL: 'model', ANTHROPIC_BASE_URL: 'https://name:secret@api.test/v1?key=hidden', ANTHROPIC_AUTH_TOKEN: 'private-key' },
  accounting: { projectId: 'p1', runId: 'run', role, parentSessionId: role === 'implement' ? 'parent' : undefined, scope: role === 'auxiliary' ? 'handoff' : 'loop' } })
const successful: SDKQuery = async function* (_prompt, opts) {
  opts.onTransportAttempt?.('started')
  yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'private response' }] } }
  yield { type: 'result', subtype: 'success', usage: { input_tokens: 70, output_tokens: 5, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } }
}
async function drain(query: SDKQuery, opts = options()) { for await (const _ of accountSdkQuery(query, 'private request', opts)) { /* consume */ } }

describe('project request accounting', () => {
  it('records bounded response metadata without changing usage totals or exposing response bodies', async () => {
    const query: SDKQuery = async function* (_prompt, opts) {
      opts.onTransportAttempt?.('started')
      opts.onTransportResponse?.({ status: 200, content_type: 'text/event-stream', response_bytes: 14,
        sse_data_lines: 1, protocol_ended: true, body_sha256: 'a'.repeat(64) })
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }
    }
    await drain(query)
    const rows = readFileSync(join(home, 'usage-ledger/p1.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(rows.find(row => row.event === 'transport_response').response).toMatchObject({ status: 200, response_bytes: 14, protocol_ended: true })
    expect(readProjectUsage('p1')).toMatchObject({ logical_queries: 1, physical_requests: 1, reported_total: 15, complete: true })
  })
  it('separates actual endpoint/model usage and filters runs without changing the active home', async () => {
    await drain(successful)
    const other = options(); other.env.ANTHROPIC_MODEL = 'second'; other.accounting!.runId = 'other'
    await drain(successful, other)
    const filtered = readProjectUsage('p1', { home, runId: 'run' })
    expect(filtered).toMatchObject({ logical_queries: 1, reported_total: 115, complete: true })
    expect(Object.values(filtered.by_model)).toEqual([{ model: 'model', endpoint_host: 'api.test', queries: 1, input: 110, output: 5,
      cache_read: 30, cache_creation: 10, missing_usage_queries: 0 }])
    expect(Object.values(readProjectUsage('p1').by_model)).toHaveLength(2)
    expect(readProjectUsage('p1', { runId: 'missing' })).toMatchObject({ logical_queries: 0, complete: false })
  })
  it('counts parent, child and auxiliary usage once, including both cache categories', async () => {
    await drain(successful)
    await drain(successful, options('implement'))
    await drain(successful, options('auxiliary'))
    const totals = readProjectUsage('p1')
    expect(totals).toMatchObject({ logical_queries: 3, physical_requests: 3, reported_input: 330, reported_output: 15, reported_total: 345, complete: true })
    expect(totals.by_role.implement).toMatchObject({ queries: 1, input: 110, output: 5 })
    const path = join(home, 'usage-ledger/p1.jsonl')
    const content = readFileSync(path, 'utf8')
    for (const secret of ['private-key', 'private request', 'private response', 'secret', 'hidden']) expect(content).not.toContain(secret)
    appendFileSync(path, content)
    expect(readProjectUsage('p1').reported_total).toBe(345)
  })
  it('missing usage is unknown; retries preserve unmeasured attempts', async () => {
    const retry: SDKQuery = async function* (_prompt, opts) {
      opts.onTransportAttempt?.('started'); opts.onTransportAttempt?.('failed')
      yield* successful('', opts)
    }
    await drain(retry)
    expect(readProjectUsage('p1')).toMatchObject({ physical_requests: 2, reported_total: 115, complete: false, unmeasured_failed_attempts: 1 })
    await drain(async function* (_prompt, opts) { opts.onTransportAttempt?.('started'); yield { type: 'result', subtype: 'success' } })
    expect(readProjectUsage('p1').missing_usage_queries).toBe(1)
  })
  it('cancellation and thrown errors close the logical record without inventing usage', async () => {
    const controller = new AbortController()
    const opts = { ...options(), signal: controller.signal }
    await drain(async function* (_prompt, queryOptions) {
      queryOptions.onTransportAttempt?.('started'); controller.abort(); yield { type: 'assistant' }
    }, opts)
    await expect(drain(async function* (_prompt, queryOptions) { queryOptions.onTransportAttempt?.('started'); throw new Error('secret exception') })).rejects.toThrow()
    expect(readProjectUsage('p1')).toMatchObject({ logical_queries: 2, active_queries: 0, missing_usage_queries: 2, complete: false })
  })
  it('normalizes OpenAI cache-inclusive usage and direct qualification without double counting', () => {
    const usage = normalizeHttpUsage({ prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 80 } }, true)
    const direct = startDirectQuery({ projectId: 'p1', sessionId: 's1' })
    direct.startAttempt(); direct.finish(usage); direct.finish(usage)
    expect(readProjectUsage('p1')).toMatchObject({ logical_queries: 1, physical_requests: 1, reported_input: 100, reported_output: 7, cache_read: 80, complete: true })
  })
  it('unfinished and damaged records prevent a complete cost claim', () => {
    const direct = startDirectQuery({ projectId: 'p1', sessionId: 's1' })
    direct.startAttempt()
    appendFileSync(join(home, 'usage-ledger/p1.jsonl'), 'damaged\n')
    expect(readProjectUsage('p1')).toMatchObject({ active_queries: 1, malformed_lines: 1, complete: false })
  })
})

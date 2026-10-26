import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { fetchWithMonetaryBudget, reserveModelRequest, reserveModelRequestWhenAvailable, readMonetaryBudget, MonetaryBudgetError, monetaryStopMessage, fitMonetaryRequest, monetaryInputBlocked } from '../../main/platform/llm/monetary-budget'
import { streamSSE } from '../../main/platform/upstream/providers/sse-reader'
import { ANTHROPIC_SSE_ADAPTER } from '../../main/platform/upstream/providers/anthropic-sse-adapter'
import { activateMonetaryPolicy, activeMonetaryPolicyPath } from '../../main/platform/llm/monetary-epoch'

const roots: string[] = []
beforeEach(() => { const registry = mkdtempSync(join(tmpdir(), 'bloma-epoch-')); roots.push(registry); vi.stubEnv('BLOMA_MONETARY_EPOCH_DIR', registry) })
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
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('shared monetary ceiling', () => {
  it('detects an impossible input reserve without touching the ledger, while pending contention is not a permanent stop',()=>{
    const path=fixture(1);expect(monetaryInputBlocked(url,'M1',path)).toBe(true)
    const possible=fixture(3),pending=reserveModelRequest(url,body,possible)!
    const before=readFileSync(possible+'.state.json','utf8');expect(monetaryInputBlocked(url,'M1',possible)).toBe(false)
    expect(readFileSync(possible+'.state.json','utf8')).toBe(before)
    pending.settle(undefined,false);expect(monetaryInputBlocked(url,'M1',possible)).toBe(true)
    expect(monetaryInputBlocked(url,'M1','')).toBe(false)
  })
  function nearBoundary() {
    const path = fixture(), policy = JSON.parse(readFileSync(path, 'utf8'))
    policy.models[0].context_tokens = 1048576; writeFileSync(path, JSON.stringify(policy))
    reserveModelRequest(url, body, path)!.settle({ input_tokens: 416697, output_tokens: 1000 }, true)
    return path
  }
  it('fits a near-boundary output ceiling while retaining the full input reserve, cap and prior ledger bytes', () => {
    const path = nearBoundary(), before = readFileSync(path + '.state.json', 'utf8'), policy = readFileSync(path, 'utf8')
    const original = JSON.stringify({ model: 'M1', max_tokens: 8192, messages: [{ role: 'user', content: 'Keep my exact goal.' }] })
    const fitted = fitMonetaryRequest(url, original, path)
    expect(JSON.parse(fitted)).toEqual({ ...JSON.parse(original), max_tokens: 7681 })
    expect(readFileSync(path + '.state.json', 'utf8')).toBe(before); expect(readFileSync(path, 'utf8')).toBe(policy)
    const ticket = reserveModelRequest(url, fitted, path)!
    const entry = state(path).entries.at(-1)
    expect(entry).toMatchObject({ input_tokens_limit: 1048576, output_tokens_limit: 7681, reserved_micro_rmb: 2158600 })
    expect(readMonetaryBudget(path)[0].accounted_upper_rmb).toBe(2.999994)
    // A stale quote cannot admit a second request while the first is in flight.
    expect(() => reserveModelRequest(url, fitted, path)).toThrow('MONETARY_BUDGET_EXHAUSTED')
    ticket.settle(undefined, false)
    expect(state(path).entries.at(-1)).toMatchObject({ status: 'unknown', charged_micro_rmb: 2158600 })
    expect(state(path).entries[0]).toEqual(JSON.parse(before).entries[0])
    const unknown = readFileSync(path + '.state.json', 'utf8')
    expect(fitMonetaryRequest(url, original, path)).toBe(original)
    expect(() => reserveModelRequest(url, fitted, path)).toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(readFileSync(path + '.state.json', 'utf8')).toBe(unknown)
  })
  it('does not reduce below half the requested output, explicit thinking budget, or the minimum useful response', () => {
    const path = nearBoundary()
    const thinking = JSON.stringify({ model: 'M1', max_tokens: 8192, thinking: { type: 'enabled', budget_tokens: 8000 } })
    expect(fitMonetaryRequest(url, thinking, path)).toBe(thinking)
    const original = JSON.stringify({ model: 'M1', max_tokens: 16384 })
    expect(fitMonetaryRequest(url, original, path)).toBe(original)
    expect(() => reserveModelRequest(url, original, path)).toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(fitMonetaryRequest(url, body, '')).toBe(body)
  })
  it('sends and guards the fitted physical SSE body and settles only the usage actually reported', async () => {
    const path = nearBoundary(), seen: string[] = []
    const original = JSON.stringify({ model: 'M1', max_tokens: 8192, messages: [] })
    const lines = [{ type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }, { type: 'message_stop' }]
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { seen.push(String(init?.body)); return new Response(lines.map(row => `data: ${JSON.stringify(row)}\n\n`).join('')) })
    await streamSSE({ request: { url, body: original, headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER, monetaryPolicyPath: path,
      requestGuard: request => seen.push(request.body), onEvent: () => {}, fetchFn })
    expect(fetchFn).toHaveBeenCalledTimes(1); expect(seen).toHaveLength(2); expect(seen[0]).toBe(seen[1])
    expect(JSON.parse(seen[0]).max_tokens).toBe(7681)
    expect(state(path).entries.at(-1)).toMatchObject({ status: 'reported', charged_micro_rmb: 360, output_tokens_limit: 7681 })
  })
  it('fits non-streaming probes without generating an extra request', async () => {
    const path = nearBoundary(); vi.stubEnv('BLOMA_MONETARY_POLICY', path)
    const fetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => { expect(JSON.parse(String(init?.body)).max_tokens).toBe(7681); return new Response(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 20 } })) })
    await fetchWithMonetaryBudget(url, { method: 'POST', body: JSON.stringify({ model: 'M1', max_tokens: 8192 }) }, fetchFn)
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(state(path).entries.at(-1)).toMatchObject({ status: 'reported', output_tokens_limit: 7681 })
  })
  it('distinguishes insufficient reservation from actual spending without sending, repricing or resetting anything', async () => {
    const path = fixture(), rate = JSON.parse(readFileSync(path, 'utf8'))
    rate.models[0].context_tokens = 1048576; writeFileSync(path, JSON.stringify(rate))
    reserveModelRequest(url, body, path)!.settle({ input_tokens: 416697, output_tokens: 1000 }, true)
    const before = readFileSync(path + '.state.json', 'utf8'), request = JSON.stringify({ model: 'M1', max_tokens: 8192 })
    let refusal: unknown
    try { await reserveModelRequestWhenAvailable(url, request, undefined, path) } catch (error) { refusal = error }
    expect(refusal).toBeInstanceOf(MonetaryBudgetError)
    expect(refusal).toMatchObject({ message: 'MONETARY_BUDGET_EXHAUSTED', admission: {
      cap_rmb: 3, accounted_upper_rmb: .841394, reported_upper_rmb: .841394,
      unresolved_reserve_rmb: 0, next_request_reserve_rmb: 2.162688, remaining_rmb: 2.158606, shortfall_rmb: .004082,
    } })
    expect(monetaryStopMessage(refusal)).toContain('预留不足不等于实际花完预算')
    expect(monetaryStopMessage(refusal)).toContain('0.004082')
    expect(readFileSync(path + '.state.json', 'utf8')).toBe(before)
    expect(monetaryStopMessage(new Error('MONETARY_BUDGET_EXHAUSTED'))).toBeUndefined()
  })
  it('restores only a settled model while another policy member remains reserved', () => {
    const original = fixture(20), temporary = fixture(20)
    const policy = JSON.parse(readFileSync(original, 'utf8'))
    policy.models.push({ ...policy.models[0], model: 'M2' })
    writeFileSync(original, JSON.stringify(policy))
    reserveModelRequest(url, body, original)!.settle(undefined, false)
    const pending = reserveModelRequest(url, JSON.stringify({ model: 'M2', max_tokens: 1000 }), original)!
    const copied = state(original); copied.entries = copied.entries.filter((e: any) => e.model === 'M1')
    copied.policy_hash = createHash('sha256').update(readFileSync(temporary)).digest('hex')
    writeFileSync(`${temporary}.state.json`, JSON.stringify(copied))
    activateMonetaryPolicy(temporary)
    const originalBytes = readFileSync(`${original}.state.json`, 'utf8')
    expect(() => activateMonetaryPolicy(original)).toThrow('MONETARY_EPOCH_HAS_ACTIVE_REQUESTS')
    expect(() => activateMonetaryPolicy(original, { only_models: ['M2'] })).toThrow('MONETARY_EPOCH_HAS_ACTIVE_REQUESTS')
    activateMonetaryPolicy(original, { only_models: ['M1'] })
    expect(activeMonetaryPolicyPath({ host: 'api.example.com', model: 'M1' })?.toLowerCase()).toBe(original.toLowerCase())
    expect(readFileSync(`${original}.state.json`, 'utf8')).toBe(originalBytes)
    expect(state(original).entries.find((e: any) => e.model === 'M2').status).toBe('reserved')
    pending.settle(undefined, false)
  })
  it('rejects empty, unknown or duplicated activation selections', () => {
    const path = fixture()
    for (const only_models of [[], ['missing'], ['M1', 'M1']]) {
      expect(() => activateMonetaryPolicy(path, { only_models })).toThrow('MONETARY_EPOCH_POLICY_INVALID')
    }
  })
  it('rejects a second policy before HTTP and requires explicit carried-liability activation', async () => {
    const a = fixture(), b = fixture(), fetcher = vi.fn()
    reserveModelRequest(url, body, a)!.settle(undefined, false)
    vi.stubEnv('BLOMA_MONETARY_POLICY', b)
    await expect(fetchWithMonetaryBudget(url, { body }, fetcher)).rejects.toThrow('MONETARY_INACTIVE_EPOCH')
    expect(fetcher).not.toHaveBeenCalled()
    const started = Date.now()
    vi.stubGlobal('fetch', fetcher)
    await expect(streamSSE({ request: { url, body, headers: {} }, adapter: ANTHROPIC_SSE_ADAPTER,
      onEvent: vi.fn() })).rejects.toThrow('MONETARY_INACTIVE_EPOCH')
    expect(Date.now() - started).toBeLessThan(500)
    expect(fetcher).not.toHaveBeenCalled()
    expect(() => activateMonetaryPolicy(b)).toThrow('MONETARY_EPOCH_LIABILITIES_NOT_CARRIED')
    const copied = state(a); copied.policy_hash = createHash('sha256').update(readFileSync(b)).digest('hex'); writeFileSync(`${b}.state.json`, JSON.stringify(copied))
    activateMonetaryPolicy(b)
    expect(() => reserveModelRequest(url, body, a)).toThrow('MONETARY_INACTIVE_EPOCH')
    expect(readMonetaryBudget(b)[0].accounted_upper_rmb).toBe(2.008)
  })
  it('refuses switching an in-flight model and preserves the previous active policy', () => {
    const a = fixture(), b = fixture(), ticket = reserveModelRequest(url, body, a)!
    expect(() => activateMonetaryPolicy(b, { reset_models: ['M1'] })).toThrow('MONETARY_EPOCH_HAS_ACTIVE_REQUESTS')
    ticket.settle({ input_tokens: 1, output_tokens: 1 }, true)
    expect(() => reserveModelRequest(url, body, a)).not.toThrow()
  })
  it('allows an explicitly authorized new window and keeps the prior ledger bytes untouched', () => {
    const a = fixture(), b = fixture()
    reserveModelRequest(url, body, a)!.settle(undefined, false)
    const old = readFileSync(`${a}.state.json`, 'utf8')
    activateMonetaryPolicy(b, { reset_models: ['M1'] })
    reserveModelRequest(url, body, b)!.settle({ input_tokens: 1, output_tokens: 1 }, true)
    expect(readFileSync(`${a}.state.json`, 'utf8')).toBe(old)
    expect(() => reserveModelRequest(url, body, a)).toThrow('MONETARY_INACTIVE_EPOCH')
  })
  it('uses a trusted balance ceiling while keeping unknown per-request records unchanged', () => {
    const path = fixture(); reserveModelRequest(url, body, path)!.settle(undefined, false)
    const data = state(path), id = data.entries[0].id, evidencePath = `${path}.proof.json`
    const proof = JSON.stringify({ source: 'direct_user_confirmation', host: 'api.example.com', model: 'M1',
      start_balance_rmb: 3, end_balance_lower_bound_rmb: 2.1, external_changes: false, covered_request_ids: [id] })
    writeFileSync(evidencePath, proof)
    data.balance_checkpoints = [{ id: 'balance-1', host: 'api.example.com', model: 'M1', covered_request_ids: [id],
      spent_upper_micro_rmb: 900000, evidence_path: evidencePath, evidence_sha256: createHash('sha256').update(proof).digest('hex') }]
    writeFileSync(`${path}.state.json`, JSON.stringify(data))
    expect(readMonetaryBudget(path)[0].accounted_upper_rmb).toBe(0.9)
    reserveModelRequest(url, body, path)
    expect(state(path).entries[0]).toMatchObject({ status: 'unknown', charged_micro_rmb: 2008000 })
    expect(readMonetaryBudget(path)[0].accounted_upper_rmb).toBe(2.908)
    writeFileSync(evidencePath, proof + ' ')
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_BALANCE_EVIDENCE_CHANGED')
  })
  it('rejects duplicate balance coverage rather than crediting a call twice', () => {
    const path = fixture(); reserveModelRequest(url, body, path)!.settle(undefined, false)
    const data = state(path), id = data.entries[0].id, evidencePath = `${path}.proof.json`
    const proof = JSON.stringify({ source: 'direct_user_confirmation', host: 'api.example.com', model: 'M1',
      start_balance_rmb: 3, end_balance_lower_bound_rmb: 2.1, external_changes: false, covered_request_ids: [id] })
    writeFileSync(evidencePath, proof)
    const checkpoint = { id: 'balance-1', host: 'api.example.com', model: 'M1', covered_request_ids: [id], spent_upper_micro_rmb: 900000,
      evidence_path: evidencePath, evidence_sha256: createHash('sha256').update(proof).digest('hex') }
    data.balance_checkpoints = [checkpoint, { ...checkpoint, id: 'balance-2' }]
    writeFileSync(`${path}.state.json`, JSON.stringify(data))
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_BALANCE_CHECKPOINT_INVALID')
  })
  it('queues temporary contention and records the wait without expanding the cap', async () => {
    const path = fixture()
    const first = reserveModelRequest(url, body, path)!
    const next = reserveModelRequestWhenAvailable(url, body, undefined, path)
    expect(state(path).entries).toHaveLength(1)
    first.settle({ input_tokens: 100, output_tokens: 10 }, true)
    const second = await next
    expect(state(path).entries[1].budget_wait_ms).toBeGreaterThan(0)
    second!.settle({ input_tokens: 100, output_tokens: 10 }, true)
    expect(state(path).entries.reduce((sum: number, row: { charged_micro_rmb: number }) => sum + row.charged_micro_rmb, 0)).toBe(560)
  })
  it('does not wait when unknown spending permanently prevents a new reservation', async () => {
    const path = fixture()
    reserveModelRequest(url, body, path)!.settle(undefined, false)
    await expect(reserveModelRequestWhenAvailable(url, body, undefined, path)).rejects.toThrow('MONETARY_BUDGET_EXHAUSTED')
    expect(state(path).entries).toHaveLength(1)
  })
  it('cancels a queued request before it can make another reservation', async () => {
    const path = fixture(), controller = new AbortController()
    reserveModelRequest(url, body, path)
    const next = reserveModelRequestWhenAvailable(url, body, controller.signal, path)
    controller.abort(new Error('stop queued sample'))
    await expect(next).rejects.toThrow('stop queued sample')
    expect(state(path).entries).toHaveLength(1)
  })
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
    const original = readFileSync(path, 'utf8')
    writeFileSync(path, original + '\n')
    expect(() => reserveModelRequest(url, body, path)).toThrow('MONETARY_INACTIVE_EPOCH')
    writeFileSync(path, original) // Isolate state corruption from the earlier epoch rejection.
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

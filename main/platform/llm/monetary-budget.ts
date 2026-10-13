import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SDKMessage } from '../../../shared/types'

type Usage = NonNullable<SDKMessage['usage']>
interface Rate { host: string; model: string; cap_rmb: number; context_tokens: number; input_rmb_per_million: number; output_rmb_per_million: number; cache_rmb_per_million: number }
interface Policy { version: 1; models: Rate[] }
interface Entry { id: string; model: string; host: string; at?: string; home?: string; budget_wait_ms?: number; reserved_micro_rmb: number; charged_micro_rmb: number; status: 'reserved' | 'reported' | 'unknown' | 'reconciled_unauthenticated' | 'reconciled_pre_execution'; usage?: Usage }
interface State { version: 1; policy_hash: string; entries: Entry[] }

export class MonetaryBudgetError extends Error {
  constructor(code: string) { super(code); this.name = 'MonetaryBudgetError' }
}
const fail = (code: string): never => { throw new MonetaryBudgetError(code) }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const micro = (tokens: number, rmbPerMillion: number) => Math.ceil(tokens * rmbPerMillion)

/** Optional shared, cross-home spending ceiling. No prompts, keys, or request bodies are persisted.
 * Reserve a full context at peak rates before EACH physical request. Missing usage and crashes
 * retain the reservation; they never become free calls. State/policy corruption fails closed.
 */
export function reserveModelRequest(url: string, body: string, policyPath = process.env.BLOMA_MONETARY_POLICY, waitedMs = 0) {
  if (!policyPath) return undefined
  const bytes = readFileSync(policyPath)
  const policy = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as Policy
  const policyHash = createHash('sha256').update(bytes).digest('hex')
  if (policy.version !== 1 || !Array.isArray(policy.models) || !policy.models.length) fail('MONETARY_POLICY_INVALID')
  for (const row of policy.models) {
    if (!row.host || !row.model || !Number.isFinite(row.cap_rmb) || row.cap_rmb <= 0 || !integer(row.context_tokens) || !row.context_tokens
      || [row.input_rmb_per_million, row.output_rmb_per_million, row.cache_rmb_per_million].some(rate => !Number.isFinite(rate) || rate < 0)
      || row.cache_rmb_per_million > row.input_rmb_per_million) fail('MONETARY_POLICY_INVALID')
  }
  const request = JSON.parse(body) as { model?: string; max_tokens?: number }
  const host = new URL(url).host
  const matches = policy.models.filter(row => row.host === host && row.model === request.model)
  if (matches.length !== 1) fail('MONETARY_MODEL_NOT_ALLOWED')
  const rate = matches[0]
  if (!integer(request.max_tokens) || !request.max_tokens || request.max_tokens > rate.context_tokens) fail('MONETARY_OUTPUT_LIMIT_REQUIRED')
  const reserved = micro(rate.context_tokens, rate.input_rmb_per_million) + micro(request.max_tokens!, rate.output_rmb_per_million)
  const statePath = `${policyPath}.state.json`, lockPath = `${policyPath}.lock`
  const mutate = (fn: (state: State) => void) => {
    let fd: number
    const deadline = Date.now() + 2000
    for (;;) {
      try { fd = openSync(lockPath, 'wx'); break } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) return fail('MONETARY_STATE_LOCKED')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
      }
    }
    const temp = `${statePath}.${randomUUID()}.tmp`
    try {
      const state: State = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { version: 1, policy_hash: policyHash, entries: [] }
      if (state.version !== 1 || state.policy_hash !== policyHash || !Array.isArray(state.entries)
        || state.entries.some(entry => !integer(entry.charged_micro_rmb) || !integer(entry.reserved_micro_rmb)
          || !policy.models.some(row => row.model === entry.model && row.host === entry.host))) fail('MONETARY_STATE_INVALID')
      fn(state)
      writeFileSync(temp, JSON.stringify(state, null, 2), { flag: 'wx' })
      renameSync(temp, statePath)
    } finally {
      if (existsSync(temp)) unlinkSync(temp)
      closeSync(fd); unlinkSync(lockPath)
    }
  }
  const id = randomUUID()
  mutate(state => {
    const spent = state.entries.filter(entry => entry.model === rate.model && entry.host === host).reduce((sum, entry) => sum + entry.charged_micro_rmb, 0)
    if (spent + reserved > Math.floor(rate.cap_rmb * 1_000_000)) fail('MONETARY_BUDGET_EXHAUSTED')
    state.entries.push({ id, model: rate.model, host, at: new Date().toISOString(), home: process.env.PROMA_HOME,
      ...(waitedMs > 0 ? { budget_wait_ms: waitedMs } : {}),
      reserved_micro_rmb: reserved, charged_micro_rmb: reserved, status: 'reserved' })
  })
  return {
    settle(usage?: Usage, completed = false) {
      mutate(state => {
        const entry = state.entries.find(row => row.id === id)
        if (!entry || entry.status !== 'reserved') return fail('MONETARY_RESERVATION_INVALID')
        const keys = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const
        const valid = completed && usage && integer(usage.input_tokens) && integer(usage.output_tokens)
          && keys.every(key => usage[key] === undefined || integer(usage[key]))
        if (!valid) { entry.status = 'unknown'; return }
        const input = usage.input_tokens! + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
        if (input > rate.context_tokens || usage.output_tokens! > request.max_tokens!) fail('MONETARY_USAGE_EXCEEDS_RESERVATION')
        const actual = micro(usage.input_tokens! + (usage.cache_creation_input_tokens ?? 0), rate.input_rmb_per_million)
          + micro(usage.cache_read_input_tokens ?? 0, rate.cache_rmb_per_million) + micro(usage.output_tokens!, rate.output_rmb_per_million)
        entry.charged_micro_rmb = actual; entry.status = 'reported'; entry.usage = usage
      })
    },
  }
}

/** Wait only for in-flight reservations that can release capacity. Permanent exhaustion
 * still fails before HTTP. The caller's shared deadline also bounds this queue. */
export async function reserveModelRequestWhenAvailable(url: string, body: string, signal?: AbortSignal,
  policyPath = process.env.BLOMA_MONETARY_POLICY) {
  const started = Date.now()
  let queued = false
  for (;;) {
    signal?.throwIfAborted()
    try { return reserveModelRequest(url, body, policyPath, queued ? Date.now() - started : 0) }
    catch (error) {
      if (!(error instanceof MonetaryBudgetError) || error.message !== 'MONETARY_BUDGET_EXHAUSTED' || !policyPath) throw error
      if (!existsSync(`${policyPath}.state.json`)) throw error
      const policy = JSON.parse(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')) as Policy
      const request = JSON.parse(body), host = new URL(url).host
      const rate = policy.models.find(row => row.host === host && row.model === request.model)!
      const state = JSON.parse(readFileSync(`${policyPath}.state.json`, 'utf8')) as State
      const entries = state.entries.filter(row => row.host === host && row.model === request.model)
      const settled = entries.filter(row => row.status !== 'reserved').reduce((sum, row) => sum + row.charged_micro_rmb, 0)
      const needed = micro(rate.context_tokens, rate.input_rmb_per_million) + micro(request.max_tokens, rate.output_rmb_per_million)
      if (!entries.some(row => row.status === 'reserved') || settled + needed > Math.floor(rate.cap_rmb * 1_000_000)) throw error
      if (Date.now() - started >= 120_000) throw new MonetaryBudgetError('MONETARY_RESERVATION_WAIT_TIMEOUT')
      queued = true
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(signal?.reason ?? new Error('MONETARY_WAIT_CANCELLED')) }
        const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, 100)
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    }
  }
}

/** Non-streaming probes and provider qualification share the same physical-request ceiling. */
export async function fetchWithMonetaryBudget(url: string, init: RequestInit, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const reservation = await reserveModelRequestWhenAvailable(url, String(init.body), init.signal ?? undefined)
  let usage: Usage | undefined
  let completed = false
  try {
    const response = await fetchImpl(url, init)
    if (reservation && response.ok) {
      const raw = await response.clone().json() as { usage?: Record<string, unknown> }
      const row = raw.usage
      if (row && 'prompt_tokens' in row) {
        const cached = (row.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens ?? 0
        usage = { input_tokens: typeof row.prompt_tokens === 'number' ? row.prompt_tokens - cached : undefined,
          output_tokens: row.completion_tokens as number, cache_read_input_tokens: cached }
      } else usage = row as Usage | undefined
      completed = true
    }
    return response
  } finally { reservation?.settle(usage, completed) }
}

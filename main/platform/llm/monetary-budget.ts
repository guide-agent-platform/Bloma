import { createHash, randomUUID } from 'node:crypto'
import { acquireMonetaryEpoch } from './monetary-epoch'
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import type { SDKMessage } from '../../../shared/types'

type Usage = NonNullable<SDKMessage['usage']>
interface Rate { host: string; model: string; cap_rmb: number; context_tokens: number; input_rmb_per_million: number; output_rmb_per_million: number; cache_rmb_per_million: number }
interface Policy { version: 1; models: Rate[] }
interface Entry { id: string; model: string; host: string; at?: string; home?: string; budget_wait_ms?: number; input_tokens_limit?: number; output_tokens_limit?: number; reserved_micro_rmb: number; charged_micro_rmb: number; status: 'reserved' | 'reported' | 'unknown' | 'reconciled_unauthenticated' | 'reconciled_pre_execution'; usage?: Usage }
interface BalanceCheckpoint { id: string; host: string; model: string; covered_request_ids: string[]; spent_upper_micro_rmb: number; evidence_path: string; evidence_sha256: string }
interface State { version: 1; policy_hash: string; entries: Entry[]; balance_checkpoints?: BalanceCheckpoint[] }

export interface MonetaryAdmissionDetails {
  cap_rmb: number
  accounted_upper_rmb: number
  reported_upper_rmb: number
  unresolved_reserve_rmb: number
  next_request_reserve_rmb: number
  remaining_rmb: number
  shortfall_rmb: number
}
export class MonetaryBudgetError extends Error {
  constructor(code: string, readonly admission?: MonetaryAdmissionDetails) { super(code); this.name = 'MonetaryBudgetError' }
}
/** Keep the stable machine code while explaining admission versus actual spend.
 * Never suggest that a conservative reservation is an invoice or bad API key. */
export function monetaryStopMessage(error: unknown): string | undefined {
  if (!(error instanceof MonetaryBudgetError) || error.message !== 'MONETARY_BUDGET_EXHAUSTED') return
  const d = error.admission
  if (!d) return '本地金额保护没有放行下一次模型请求，费用和当前进度已保留。这可能是剩余额度不足以覆盖请求预留，并不表示已实际花完预算。'
  const rmb = (value: number) => value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')
  return `下一次模型请求尚未发出：本地金额上限 ${rmb(d.cap_rmb)} 元，已计入责任上界 ${rmb(d.accounted_upper_rmb)} 元（已报告计价 ${rmb(d.reported_upper_rmb)} 元，未结算请求预留 ${rmb(d.unresolved_reserve_rmb)} 元）。可用 ${rmb(d.remaining_rmb)} 元，本次最坏情况需预留 ${rmb(d.next_request_reserve_rmb)} 元，差 ${rmb(d.shortfall_rmb)} 元。预留不足不等于实际花完预算，也不是渠道余额不足。当前文件、用量和进度已保留。`
}
const fail = (code: string): never => { throw new MonetaryBudgetError(code) }
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0
const micro = (tokens: number, rmbPerMillion: number) => Math.ceil(tokens * rmbPerMillion)

/** A trusted balance statement bounds the aggregate liability of covered calls. Keep
 * every original per-call record; do not fabricate zero usage for unknown responses. */
function accountedSpent(state: State, host: string, model: string, settledOnly = false): number {
  const entries = state.entries.filter(row => row.host === host && row.model === model && (!settledOnly || row.status !== 'reserved'))
  let total = entries.reduce((sum, row) => sum + row.charged_micro_rmb, 0)
  const covered = new Set<string>()
  for (const checkpoint of state.balance_checkpoints ?? []) {
    if (checkpoint.host !== host || checkpoint.model !== model) continue
    if (!integer(checkpoint.spent_upper_micro_rmb) || !Array.isArray(checkpoint.covered_request_ids) || !checkpoint.covered_request_ids.length) fail('MONETARY_BALANCE_CHECKPOINT_INVALID')
    const bytes = readFileSync(checkpoint.evidence_path)
    if (createHash('sha256').update(bytes).digest('hex') !== checkpoint.evidence_sha256) fail('MONETARY_BALANCE_EVIDENCE_CHANGED')
    const proof = JSON.parse(bytes.toString('utf8'))
    const ceiling = Math.ceil((proof.start_balance_rmb - proof.end_balance_lower_bound_rmb) * 1_000_000)
    if (proof.source !== 'direct_user_confirmation' || proof.external_changes !== false || proof.host !== host || proof.model !== model
      || JSON.stringify(proof.covered_request_ids) !== JSON.stringify(checkpoint.covered_request_ids) || !integer(ceiling)
      || checkpoint.spent_upper_micro_rmb !== ceiling) fail('MONETARY_BALANCE_CHECKPOINT_INVALID')
    let original = 0
    for (const id of checkpoint.covered_request_ids) {
      const entry = entries.find(row => row.id === id)
      if (!entry || entry.status === 'reserved' || covered.has(id)) return fail('MONETARY_BALANCE_CHECKPOINT_INVALID')
      covered.add(id); original += entry.charged_micro_rmb
    }
    total += checkpoint.spent_upper_micro_rmb - original
  }
  return total
}

/** A published capacity does not enlarge a task's already-authorized input reserve. */
export function monetaryContextLimit(baseUrl:string|undefined,model:string|undefined,policyPath=process.env.BLOMA_MONETARY_POLICY):number|undefined {
  if(!policyPath)return undefined
  const policy=JSON.parse(readFileSync(policyPath,'utf8').replace(/^\uFEFF/,'')) as Policy
  let host:string;try{host=new URL(baseUrl??'').host}catch{fail('MONETARY_MODEL_NOT_AUTHORIZED')}
  const rate=policy.models?.find(row=>row.host===host&&row.model===model)
  if(!rate)throw new MonetaryBudgetError('MONETARY_MODEL_NOT_AUTHORIZED')
  if(!Number.isSafeInteger(rate.context_tokens)||rate.context_tokens<1024)fail('MONETARY_POLICY_INVALID')
  return rate.context_tokens
}
export function readMonetaryBudget(policyPath: string) {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')) as Policy
  const state = JSON.parse(readFileSync(`${policyPath}.state.json`, 'utf8')) as State
  if (state.policy_hash !== createHash('sha256').update(readFileSync(policyPath)).digest('hex')) fail('MONETARY_STATE_INVALID')
  return policy.models.map(rate => ({ model: rate.model, host: rate.host, cap_rmb: rate.cap_rmb,
    accounted_upper_rmb: accountedSpent(state, rate.host, rate.model) / 1_000_000,
    remaining_rmb: rate.cap_rmb - accountedSpent(state, rate.host, rate.model) / 1_000_000,
    reported_peak_rmb: state.entries.filter(e => e.host === rate.host && e.model === rate.model && e.status === 'reported').reduce((sum, e) => sum + e.charged_micro_rmb, 0) / 1_000_000 }))
}

/** Read-only output fitting. Input liability, historical charges and the policy
 * stay intact. The atomic reservation still decides admission after this quote;
 * concurrent senders cannot spend a stale quote as if it were a reservation.
 * Retain a useful minimum response and never violate explicit thinking budgets. */
export function fitMonetaryRequest(url: string, body: string, policyPath = process.env.BLOMA_MONETARY_POLICY): string {
  if (!policyPath || !existsSync(`${policyPath}.state.json`)) return body
  const bytes = readFileSync(policyPath)
  const policy = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) as Policy
  const state = JSON.parse(readFileSync(`${policyPath}.state.json`, 'utf8')) as State
  if (state.policy_hash !== createHash('sha256').update(bytes).digest('hex') || !Array.isArray(state.entries)) fail('MONETARY_STATE_INVALID')
  const request = JSON.parse(body) as { model?: string; max_tokens?: number; thinking?: { type?: string; budget_tokens?: number } }
  const host = new URL(url).host, matches = policy.models?.filter(rate => rate.host === host && rate.model === request.model)
  // Unknown shapes retain the original request and are rejected by normal admission.
  if (matches?.length !== 1) return body
  const rate = matches[0], requested = request.max_tokens
  if (!integer(requested) || !requested || requested > rate.context_tokens || !integer(rate.context_tokens)
    || !Number.isFinite(rate.cap_rmb) || rate.cap_rmb <= 0
    || !Number.isFinite(rate.input_rmb_per_million) || rate.input_rmb_per_million < 0
    || !Number.isFinite(rate.output_rmb_per_million) || rate.output_rmb_per_million <= 0) return body
  if (state.entries.some(entry => !integer(entry.charged_micro_rmb) || !integer(entry.reserved_micro_rmb))) fail('MONETARY_STATE_INVALID')
  const spent = accountedSpent(state, host, rate.model), cap = Math.floor(rate.cap_rmb * 1e6)
  const inputReserve = micro(rate.context_tokens, rate.input_rmb_per_million)
  const available = cap - spent - inputReserve
  if (inputReserve + micro(requested, rate.output_rmb_per_million) <= cap - spent || available < 0) return body
  let limit = Math.min(requested, Math.floor(available / rate.output_rmb_per_million))
  // Floating point rounding must never turn a quote into a one-micro overspend.
  while (limit > 0 && micro(limit, rate.output_rmb_per_million) > available) limit--
  const thinking = request.thinking?.type === 'enabled' && integer(request.thinking.budget_tokens) ? request.thinking.budget_tokens + 1 : 0
  const minimum = Math.min(requested, Math.max(512, thinking))
  if (limit < minimum || limit >= requested) return body
  return JSON.stringify({ ...request, max_tokens: limit })
}

/** When even the policy's full input reserve cannot fit, no output choice can
 * make the next request admissible. Let the host finish existing checks without
 * first calling the model. In-flight contention is not permanent exhaustion. */
export function monetaryInputBlocked(baseUrl:string|undefined,model:string|undefined,policyPath=process.env.BLOMA_MONETARY_POLICY):boolean{
  if(!policyPath||!baseUrl||!model)return false
  const bytes=readFileSync(policyPath),policy=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')) as Policy
  if(policy.version!==1||!Array.isArray(policy.models))fail('MONETARY_POLICY_INVALID')
  const host=new URL(baseUrl).host,matches=policy.models.filter(rate=>rate.host===host&&rate.model===model)
  if(matches.length!==1)fail('MONETARY_MODEL_NOT_ALLOWED')
  const rate=matches[0]
  if(!integer(rate.context_tokens)||!rate.context_tokens||!Number.isFinite(rate.cap_rmb)||rate.cap_rmb<=0
    ||[rate.input_rmb_per_million,rate.output_rmb_per_million,rate.cache_rmb_per_million].some(v=>!Number.isFinite(v)||v<0)
    ||rate.cache_rmb_per_million>rate.input_rmb_per_million)fail('MONETARY_POLICY_INVALID')
  let spent=0
  if(existsSync(policyPath+'.state.json')){
    const state=JSON.parse(readFileSync(policyPath+'.state.json','utf8')) as State
    if(state.version!==1||state.policy_hash!==createHash('sha256').update(bytes).digest('hex')||!Array.isArray(state.entries)
      ||state.entries.some(row=>!integer(row.charged_micro_rmb)||!integer(row.reserved_micro_rmb)||!policy.models.some(rate=>rate.host===row.host&&rate.model===row.model)))fail('MONETARY_STATE_INVALID')
    if(state.entries.some(row=>row.host===host&&row.model===model&&row.status==='reserved'))return false
    spent=accountedSpent(state,host,model)
  }
  return spent+micro(rate.context_tokens,rate.input_rmb_per_million)>Math.floor(rate.cap_rmb*1e6)
}

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
  const releaseEpoch = (() => {
    try { return acquireMonetaryEpoch(policyPath, rate, policyHash) }
    catch (error) { return fail(error instanceof Error && error.message.startsWith('MONETARY_') ? error.message : 'MONETARY_EPOCH_INVALID') }
  })()
  try { mutate(state => {
    const spent = accountedSpent(state, host, rate.model)
    if (spent + reserved > Math.floor(rate.cap_rmb * 1_000_000)) {
      const entries = state.entries.filter(row => row.host === host && row.model === rate.model)
      const cap = Math.floor(rate.cap_rmb * 1_000_000)
      throw new MonetaryBudgetError('MONETARY_BUDGET_EXHAUSTED', {
        cap_rmb: cap / 1e6, accounted_upper_rmb: spent / 1e6,
        reported_upper_rmb: entries.filter(row => row.status === 'reported').reduce((sum, row) => sum + row.charged_micro_rmb, 0) / 1e6,
        unresolved_reserve_rmb: entries.filter(row => row.status === 'reserved' || row.status === 'unknown').reduce((sum, row) => sum + row.charged_micro_rmb, 0) / 1e6,
        next_request_reserve_rmb: reserved / 1e6, remaining_rmb: Math.max(0, cap - spent) / 1e6,
        shortfall_rmb: (spent + reserved - cap) / 1e6,
      })
    }
    state.entries.push({ id, model: rate.model, host, at: new Date().toISOString(), home: process.env.PROMA_HOME,
      ...(waitedMs > 0 ? { budget_wait_ms: waitedMs } : {}),
      input_tokens_limit: rate.context_tokens, output_tokens_limit: request.max_tokens,
      reserved_micro_rmb: reserved, charged_micro_rmb: reserved, status: 'reserved' })
  }) } finally { releaseEpoch() }
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
      const settled = accountedSpent(state, host, rate.model, true)
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
  const originalBody = String(init.body), body = fitMonetaryRequest(url, originalBody)
  const reservation = await reserveModelRequestWhenAvailable(url, body, init.signal ?? undefined)
  let usage: Usage | undefined
  let completed = false
  try {
    const response = await fetchImpl(url, body === originalBody ? init : { ...init, body })
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

import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getAgentSessionsIndexPath, getPromaHome } from '../../../storage/config-paths'
import type { SDKQuery, SDKQueryOptions } from '../../orchestration/stages/orchestration-contracts'
import type { SDKMessage, ModelTransportReceipt } from '../../../shared/types'

export interface QueryAccounting { projectId: string; runId?: string; parentSessionId?: string; role?: string; scope?: string }
type Usage = NonNullable<SDKMessage['usage']>
interface LedgerEvent {
  version: 1; at: string; query_id: string; event: 'query_started' | 'query_finished' | 'transport_started' | 'transport_finished' | 'transport_response'
  project_id: string; session_id: string; run_id?: string; parent_session_id?: string; role: string; scope: string
  model?: string; endpoint_host?: string; transport_index?: number; status?: string; duration_ms?: number; usage?: Usage
  system_sha256?: string
  response?: ModelTransportReceipt
}
let sessionCache: { path: string; mtime: number; sessions: Map<string, { project_id: string; parent_session_id?: string }> } | undefined
const recordingErrors = new Map<string, number>()
function metadata(sessionId: string) {
  try {
    const path = getAgentSessionsIndexPath()
    const mtime = statSync(path).mtimeMs
    if (!sessionCache || sessionCache.path !== path || sessionCache.mtime !== mtime) {
      const raw = JSON.parse(readFileSync(path, 'utf8'))
      sessionCache = { path, mtime, sessions: new Map((Array.isArray(raw.sessions) ? raw.sessions : []).map((s: { session_id: string }) => [s.session_id, s])) }
    }
    return sessionCache.sessions.get(sessionId)
  } catch { return undefined }
}
function ledgerPath(projectId: string, home = getPromaHome()): string {
  const safeId = /^[A-Za-z0-9_-]+$/.test(projectId) ? projectId : 'unassigned'
  return join(home, 'usage-ledger', `${safeId}.jsonl`)
}
function append(event: LedgerEvent): void {
  try {
    mkdirSync(join(getPromaHome(), 'usage-ledger'), { recursive: true })
    appendFileSync(ledgerPath(event.project_id), JSON.stringify(event) + '\n', 'utf8')
  } catch (error) {
    const key = `${getPromaHome()}/${event.project_id}`
    recordingErrors.set(key, (recordingErrors.get(key) ?? 0) + 1)
    console.error('[request-ledger] usage recording unavailable:', (error as NodeJS.ErrnoException).code ?? 'unknown')
  }
}
function cleanUsage(usage: Usage | undefined): Usage | undefined {
  if (!usage) return undefined
  const result: Usage = {}
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) result[key] = value
  }
  return Object.keys(result).length ? result : undefined
}

export function normalizeHttpUsage(raw: unknown, openai: boolean): Usage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const usage = raw as Record<string, unknown>
  if (!openai) return cleanUsage(usage as Usage)
  const cached = (usage.prompt_tokens_details as { cached_tokens?: number } | undefined)?.cached_tokens
  const input = usage.prompt_tokens
  return cleanUsage({ input_tokens: typeof input === 'number' ? Math.max(0, input - (typeof cached === 'number' ? cached : 0)) : undefined,
    output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    cache_read_input_tokens: typeof cached === 'number' ? cached : undefined })
}

/** Non-streaming qualification uses the same accounting protocol. */
export function startDirectQuery(ctx: QueryAccounting & { sessionId: string; model?: string; endpointHost?: string }) {
  const base = { version: 1 as const, query_id: randomUUID(), project_id: ctx.projectId, session_id: ctx.sessionId,
    run_id: ctx.runId, parent_session_id: ctx.parentSessionId, role: ctx.role ?? 'provider_qualification', scope: ctx.scope ?? 'provider_real',
    model: ctx.model, endpoint_host: ctx.endpointHost }
  const started = Date.now()
  let index = 0, active = false, done = false
  append({ ...base, at: new Date().toISOString(), event: 'query_started' })
  return {
    startAttempt() { index++; active = true; append({ ...base, at: new Date().toISOString(), event: 'transport_started', transport_index: index }) },
    failAttempt() { if (active) append({ ...base, at: new Date().toISOString(), event: 'transport_finished', transport_index: index, status: 'failed' }); active = false },
    finish(usage?: Usage, status = 'completed') {
      if (done) return
      done = true
      if (active) append({ ...base, at: new Date().toISOString(), event: 'transport_finished', transport_index: index, status })
      append({ ...base, at: new Date().toISOString(), event: 'query_finished', usage: cleanUsage(usage), status, duration_ms: Date.now() - started })
    },
  }
}

/** Counts a logical model query once, plus every physical retry. Never stores prompts or keys. */
export async function* accountSdkQuery(query: SDKQuery, prompt: string, options: SDKQueryOptions): AsyncGenerator<SDKMessage> {
  const session = metadata(options.sessionId)
  const ctx = options.accounting
  let host: string | undefined
  try { host = new URL(options.env.ANTHROPIC_BASE_URL ?? '').host } catch { /* unavailable */ }
  const base = { version: 1 as const, query_id: randomUUID(), project_id: ctx?.projectId ?? session?.project_id ?? 'unassigned',
    session_id: options.sessionId, run_id: ctx?.runId, parent_session_id: ctx?.parentSessionId ?? session?.parent_session_id,
    role: ctx?.role ?? (session?.parent_session_id ? 'child' : 'guide_or_other'), scope: ctx?.scope ?? 'direct',
    model: options.env.ANTHROPIC_MODEL, endpoint_host: host }
  const systems = (options.messages ?? options.history ?? []).filter(message => message.role === 'system').map(message => message.content)
  const withPrompt = { ...base, system_sha256: createHash('sha256').update(JSON.stringify(systems)).digest('hex') }
  const started = Date.now()
  let usage: Usage | undefined
  let finished = false
  let transportIndex = 0
  let activeTransport = false
  append({ ...withPrompt, at: new Date().toISOString(), event: 'query_started' })
  const observe: SDKQueryOptions['onTransportAttempt'] = state => {
    try { options.onTransportAttempt?.(state) } catch { /* telemetry must not affect requests */ }
    if (state === 'started') {
      transportIndex++
      activeTransport = true
      append({ ...base, at: new Date().toISOString(), event: 'transport_started', transport_index: transportIndex })
    } else {
      append({ ...base, at: new Date().toISOString(), event: 'transport_finished', transport_index: transportIndex, status: state })
      activeTransport = false
    }
  }
  try {
    for await (const message of query(prompt, { ...options, onTransportAttempt: observe, onTransportResponse: receipt => {
      try { options.onTransportResponse?.(receipt) } catch { /* telemetry only */ }
      append({ ...base, at: new Date().toISOString(), event: 'transport_response', transport_index: transportIndex, response: receipt })
    } })) {
      if (message.usage) usage = { ...usage, ...cleanUsage(message.usage) }
      if (message.type === 'result') finished = message.subtype === 'success'
      yield message
    }
  } finally {
    const status = options.signal.aborted ? 'cancelled' : finished ? 'completed' : 'error'
    if (activeTransport) append({ ...base, at: new Date().toISOString(), event: 'transport_finished', transport_index: transportIndex, status })
    append({ ...base, at: new Date().toISOString(), event: 'query_finished', status, duration_ms: Date.now() - started, usage: cleanUsage(usage) })
  }
}

/** Missing/partial usage is explicit; parent summaries and child requests are never added twice. */
export function readProjectUsage(projectId: string, options: { home?: string; runId?: string } = {}) {
  const home = options.home ?? getPromaHome(), path = ledgerPath(projectId, home)
  const queries = new Map<string, { start?: LedgerEvent; end?: LedgerEvent; transports: Map<number, LedgerEvent>; failedTransports: Set<number> }>()
  let malformed = 0
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as LedgerEvent
      if (event.version !== 1 || event.project_id !== projectId || typeof event.query_id !== 'string') { malformed++; continue }
      if (options.runId && event.run_id !== options.runId) continue
      const query: { start?: LedgerEvent; end?: LedgerEvent; transports: Map<number, LedgerEvent>; failedTransports: Set<number> } = queries.get(event.query_id) ?? { transports: new Map(), failedTransports: new Set() }
      if (event.event === 'query_started') query.start = event
      else if (event.event === 'query_finished') query.end = event
      else if (event.event === 'transport_started' && event.transport_index) query.transports.set(event.transport_index, event)
      else if (event.event === 'transport_finished' && event.transport_index && event.status !== 'completed') query.failedTransports.add(event.transport_index)
      queries.set(event.query_id, query)
    } catch { malformed++ }
  }
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0, missingUsage = 0, active = 0, physical = 0, failedAttempts = 0, partial = 0
  const byRole: Record<string, { queries: number; input: number; output: number }> = Object.create(null)
  const byScope: Record<string, { queries: number; input: number; output: number }> = Object.create(null)
  const byModel: Record<string, { model: string; endpoint_host: string; queries: number; input: number; output: number; cache_read: number; cache_creation: number; missing_usage_queries: number }> = Object.create(null)
  for (const query of queries.values()) {
    const usage = cleanUsage(query.end?.usage)
    const role = query.end?.role ?? query.start?.role ?? 'unknown'
    const row = byRole[role] ??= { queries: 0, input: 0, output: 0 }
    const scopeRow = byScope[query.end?.scope ?? query.start?.scope ?? 'unknown'] ??= { queries: 0, input: 0, output: 0 }
    const model = query.end?.model ?? query.start?.model ?? 'unknown', host = query.end?.endpoint_host ?? query.start?.endpoint_host ?? 'unknown'
    const modelRow = byModel[JSON.stringify([host, model])] ??= { model, endpoint_host: host, queries: 0, input: 0, output: 0, cache_read: 0, cache_creation: 0, missing_usage_queries: 0 }
    modelRow.queries++
    row.queries++
    scopeRow.queries++
    physical += query.transports.size
    failedAttempts += query.failedTransports.size
    if (!query.end) active++
    if (!query.start) partial++
    if (usage?.input_tokens === undefined || usage.output_tokens === undefined) { missingUsage++; modelRow.missing_usage_queries++ }
    const read = usage?.cache_read_input_tokens ?? 0
    const creation = usage?.cache_creation_input_tokens ?? 0
    const totalInput = (usage?.input_tokens ?? 0) + read + creation
    input += totalInput; output += usage?.output_tokens ?? 0; cacheRead += read; cacheCreation += creation
    row.input += totalInput; row.output += usage?.output_tokens ?? 0
    scopeRow.input += totalInput; scopeRow.output += usage?.output_tokens ?? 0
    modelRow.input += totalInput; modelRow.output += usage?.output_tokens ?? 0; modelRow.cache_read += read; modelRow.cache_creation += creation
  }
  const writeErrors = recordingErrors.get(`${home}/${projectId}`) ?? 0
  const warningLimit = Number(process.env.BLOMA_PROJECT_TOKEN_WARNING)
  return { project_id: projectId, logical_queries: queries.size, physical_requests: physical,
    reported_input: input, reported_output: output, reported_total: input + output, cache_read: cacheRead, cache_creation: cacheCreation,
    missing_usage_queries: missingUsage, unmeasured_failed_attempts: failedAttempts, active_queries: active, malformed_lines: malformed, by_role: byRole, by_scope: byScope, by_model: byModel,
    partial_records: partial,
    recording_errors: writeErrors,
    ...(Number.isFinite(warningLimit) && warningLimit > 0 ? { warning_limit: warningLimit, budget_warning: input + output >= warningLimit } : {}),
    complete: queries.size > 0 && !missingUsage && !active && !failedAttempts && !malformed && !partial && !writeErrors,
    scope: 'streaming parent/child/auxiliary SDK queries and provider qualification; totals are known reported usage, not a bill; failed attempts without usage remain unknown' }
}

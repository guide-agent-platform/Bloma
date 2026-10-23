import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readJsonFile, writeJsonFile } from '../../storage/json-store'
import type { SDKQuery, SDKQueryOptions } from '../orchestration/stages/orchestration-contracts'

interface BudgetState {
  version: 1
  requests: number
  output: number
  phases: Record<string, number>
  phaseStarts?: Record<string, number>
}
export interface ProductionLimits { requests: number; output: number; perResponse: number; phaseRequests: number }
const PHASE_REQUESTS: Record<string, number> = { 'desktop-arch': 64, 'desktop-scaffold': 32, 'desktop-implement': 160, 'desktop-verify': 64 }
export const PRODUCTION_LIMITS = { requests: 256, output: 262144, perResponse: 16384 }
export function productionDeadlineMs(phase: string): number {
  return ({ 'desktop-arch': 8, 'desktop-scaffold': 5, 'desktop-implement': 30, 'desktop-verify': 15 }[phase] ?? 15) * 60_000
}

/** Persistent admission, shared by primary, children, continuation and transport
 * retries. This measures requests/output, not money; existing monetary policy is
 * still authoritative. No prompts, keys or generated code enter this record. */
export function createProductionBudget(projectId: string, scope: string, phase: string,
  limits: ProductionLimits = { ...PRODUCTION_LIMITS, phaseRequests: PHASE_REQUESTS[phase] ?? 64 }) {
  const key = createHash('sha256').update(`${projectId}\n${scope}`).digest('hex')
  const file = join(getPromaHome(), 'harness-budgets', `${key}.json`)
  const load = (): BudgetState => {
    let value: BudgetState
    try { value = readJsonFile<BudgetState>(file, { version: 1, requests: 0, output: 0, phases: {} }) }
    catch { throw new Error('HARNESS_BUDGET_UNREADABLE: 运行预算记录损坏，未发起请求') }
    if (value.version !== 1 || !Number.isSafeInteger(value.requests) || value.requests < 0 || !Number.isSafeInteger(value.output)
      || value.output < 0 || !value.phases || typeof value.phases !== 'object' || Array.isArray(value.phases)
      || Object.values(value.phases).some(n => !Number.isSafeInteger(n) || n < 0)
      || value.phaseStarts !== undefined && (!value.phaseStarts || typeof value.phaseStarts !== 'object' || Array.isArray(value.phaseStarts)
        || Object.values(value.phaseStarts).some(n => !Number.isSafeInteger(n) || n < 0))) throw new Error('HARNESS_BUDGET_UNREADABLE')
    return value
  }
  const persist = (value: BudgetState) => {
    try { writeJsonFile(file, value) } catch { throw new Error('HARNESS_BUDGET_UNWRITABLE: 预算不能落盘，未放行后续请求') }
  }
  const reserve = (requested: number) => {
    const state = load()
    if (state.requests >= limits.requests || (state.phases[phase] ?? 0) >= limits.phaseRequests) throw new Error('HARNESS_REQUEST_BUDGET_EXHAUSTED')
    const tokens = Math.min(requested, limits.perResponse, limits.output - state.output)
    if (tokens < 512) throw new Error('HARNESS_OUTPUT_BUDGET_EXHAUSTED')
    state.requests++
    state.phases[phase] = (state.phases[phase] ?? 0) + 1
    state.output += tokens
    persist(state)
    return tokens
  }
  const wrap = (query: SDKQuery): SDKQuery => async function* (prompt, options) {
    options.signal.throwIfAborted()
    let reservation = reserve(Math.max(512, options.maxTokens ?? limits.perResponse))
    let physical = 0
    let usage: { output_tokens?: number } | undefined
    let completed = false
    const requestGuard: SDKQueryOptions['requestGuard'] = request => {
      options.signal.throwIfAborted()
      options.requestGuard?.(request)
      const body = JSON.parse(request.body) as { max_tokens?: number; max_output_tokens?: number }
      const actual = body.max_tokens ?? body.max_output_tokens
      if (typeof actual === 'number' && actual > reservation) throw new Error('HARNESS_RESPONSE_LIMIT_EXCEEDED')
      if (physical++ > 0) {
        const next = reserve(reservation)
        if (next < reservation) throw new Error('HARNESS_OUTPUT_BUDGET_EXHAUSTED')
        reservation = next
      }
    }
    try {
      for await (const message of query(prompt, { ...options, maxTokens: reservation, requestGuard })) {
        if (message.usage) usage = { ...usage, ...message.usage }
        if (message.type === 'result') completed = message.subtype === 'success'
        yield message
      }
    } finally {
      // Unknown/cancelled requests keep their full reservation. Retried failed
      // transports also retain theirs; only the final complete usage releases it.
      if (completed && !options.signal.aborted && Number.isSafeInteger(usage?.output_tokens) && usage!.output_tokens! >= 0) {
        const state = load()
        state.output += usage!.output_tokens! - reservation
        persist(state)
      }
    }
  }
  return { wrap, executionScope: `${key}-${phase}`, snapshot: () => ({ ...load(), limits, file }), phaseStartedAt: () => {
    const state = load()
    if (!state.phaseStarts?.[phase]) {
      state.phaseStarts = { ...state.phaseStarts, [phase]: Date.now() }
      persist(state)
    }
    return state.phaseStarts![phase]!
  } }
}

import { readFileSync } from 'node:fs'
import { MonetaryBudgetError } from './monetary-budget'
import { activeMonetaryPolicyPath } from './monetary-epoch'
import type { SDKQuery } from '../../orchestration/stages/orchestration-contracts'
import type { SDKMessage } from '../../../shared/types'

interface Rate { host: string; model: string; context_tokens: number; input_rmb_per_million: number; output_rmb_per_million: number; cache_rmb_per_million: number }
interface Limits { requests: number; outputTokens: number; rmb: number }
type Usage = NonNullable<SDKMessage['usage']>
const valid = (x: unknown): x is number => Number.isSafeInteger(x) && (x as number) >= 0

/** A per-operation guard, shared by drafts, visual calls and transport retries. */
export function createRequestBudget(env: Record<string, string>, limits: Limits) {
  const uncappedExperiment = process.env.BLOMA_DISPATCH_EXPERIMENT === '1' && process.env.BLOMA_EXPERIMENT_UNLIMITED_MONETARY === '1'
  let policyPath = uncappedExperiment ? '' : process.env.BLOMA_MONETARY_POLICY
  let rates: Rate[] | undefined, setupError: string | undefined
  try {
    if (!uncappedExperiment && !policyPath && env.ANTHROPIC_BASE_URL && env.ANTHROPIC_MODEL) policyPath = activeMonetaryPolicyPath({ host: new URL(env.ANTHROPIC_BASE_URL).host, model: env.ANTHROPIC_MODEL })
    if (policyPath) {
      const policy = JSON.parse(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, ''))
      if (policy.version !== 1 || !Array.isArray(policy.models) || !policy.models.length) throw new Error('invalid policy')
      rates = policy.models
      for (const rate of rates!) if (!valid(rate.context_tokens) || !rate.context_tokens ||
        [rate.input_rmb_per_million, rate.output_rmb_per_million, rate.cache_rmb_per_million].some(x => !Number.isFinite(x) || x < 0) ||
        rate.cache_rmb_per_million > rate.input_rmb_per_million) throw new Error('invalid rate')
    }
  } catch { setupError = 'MONETARY_POLICY_UNAVAILABLE' }
  const reservations: Array<{ upper: number; rate?: Rate; reported: boolean }> = []
  let queries = 0, physicalStarts = 0
  const used = () => reservations.reduce((sum, row) => sum + row.upper, 0)
  const wrap = (query: SDKQuery): SDKQuery => async function* (prompt, options) {
    if (setupError) throw new MonetaryBudgetError(setupError)
    if (++queries > limits.requests) throw new MonetaryBudgetError('REQUEST_BUDGET_EXHAUSTED')
    let latest: typeof reservations[number] | undefined, usage: Usage | undefined, completed = false
    try {
      for await (const message of query(prompt, { ...options, maxTokens: Math.min(options.maxTokens ?? limits.outputTokens, limits.outputTokens),
        monetaryPolicyPath: uncappedExperiment ? '' : options.monetaryPolicyPath ?? policyPath,
        onTransportAttempt: state => {
          if (state === 'started') physicalStarts++
          try { options.onTransportAttempt?.(state) } catch { /* telemetry is separate from admission */ }
        },
        requestGuard: request => {
          options.requestGuard?.(request)
          if (reservations.length >= limits.requests) throw new MonetaryBudgetError('REQUEST_BUDGET_EXHAUSTED')
          const body = JSON.parse(request.body), host = new URL(request.url).host
          if (!valid(body.max_tokens) || !body.max_tokens || body.max_tokens > limits.outputTokens) throw new MonetaryBudgetError('REQUEST_OUTPUT_LIMIT')
          const matches = rates?.filter(row => row.host === host && row.model === body.model)
          if (rates && matches?.length !== 1) throw new MonetaryBudgetError('MONETARY_MODEL_NOT_ALLOWED')
          const rate = matches?.[0]
          const images = /"type":"(?:image|image_url)"/.test(request.body)
          const inputUpper = rate ? (images ? rate.context_tokens : Math.min(rate.context_tokens, Buffer.byteLength(request.body) + 4096)) : 0
          const upper = rate ? (Math.ceil(inputUpper * rate.input_rmb_per_million) + Math.ceil(body.max_tokens * rate.output_rmb_per_million)) / 1e6 : 0
          if (rate && used() + upper > limits.rmb) throw new MonetaryBudgetError('MONETARY_OPERATION_EXHAUSTED')
          latest = { upper, rate, reported: false }; reservations.push(latest)
        } })) {
        if (message.usage) usage = { ...usage, ...message.usage }
        if (message.type === 'result') completed = message.subtype === 'success'
        yield message
      }
    } finally {
      if (latest && completed && usage && valid(usage.input_tokens) && valid(usage.output_tokens) &&
        [usage.cache_read_input_tokens, usage.cache_creation_input_tokens].every(x => x === undefined || valid(x))) {
        latest.reported = true
        if (latest.rate) {
          const r = latest.rate
          const actual = (Math.ceil((usage.input_tokens + (usage.cache_creation_input_tokens ?? 0)) * r.input_rmb_per_million) +
            Math.ceil((usage.cache_read_input_tokens ?? 0) * r.cache_rmb_per_million) + Math.ceil(usage.output_tokens * r.output_rmb_per_million)) / 1e6
          // Unexpected usage never releases a reservation or admits further requests.
          if (actual > latest.upper) setupError = 'MONETARY_USAGE_EXCEEDS_RESERVATION'
          latest.upper = actual
        }
      }
    }
  }
  return { wrap, snapshot: () => ({ logical_queries: queries, physical_requests: physicalStarts, admitted_requests: reservations.length,
    monetary_control: uncappedExperiment ? 'uncapped_experiment' : setupError ? 'unavailable' : rates ? 'verified_policy' : 'not_configured',
    ...(rates ? { upper_rmb: used(), limit_rmb: limits.rmb } : {}), max_requests: limits.requests, max_output_tokens: limits.outputTokens,
    unreported_requests: reservations.filter(row => !row.reported).length }) }
}

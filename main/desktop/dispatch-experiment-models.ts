import { resolveDelegationChannelOverride, type DelegationChannelOverride } from '../agent/delegation/delegation-channel'
import { findDelegation, restoreCompletedDelegation } from '../agent/delegation/agent-collaboration'
import { getChannelByIdRaw, listChannels } from '../platform/llm/channel-manager'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { SDKQuery } from '../orchestration/orchestrator'
import { getPromaHome } from '../../storage/config-paths'
import { assertExperimentEvaluator } from './dispatch-experiment-evaluator'
import { capMaxTokensForProvider } from '../platform/llm/model-resolution'
import { finishExperiment, readExperimentEvents } from './dispatch-experiment-records'
import { experimentInputsIntact } from './dispatch-experiment-inputs'
import { DEFAULT_EXPERIMENT_SETTINGS, experimentLimits, experimentPath, recordExperiment, validateExperiment, writeExperiment, type DispatchExperiment, type ExperimentModel, type ExperimentModels } from './dispatch-experiment'

export function resolveExperimentModel(binding: ExperimentModel): DelegationChannelOverride {
  let channel = getChannelByIdRaw(binding.channel_id)
  if (!channel) {
    const matches = listChannels().filter(item => item.enabled && item.name === binding.channel_id)
    if (matches.length !== 1) throw new Error('EXPERIMENT_CHANNEL_SELECTOR_AMBIGUOUS_OR_MISSING')
    channel = getChannelByIdRaw(matches[0].id)
  }
  if (!channel?.enabled) throw new Error('EXPERIMENT_CHANNEL_DISABLED')
  const models = channel.models.filter(model => model.enabled && (model.id === binding.model_id || model.name === binding.model_id))
  if (models.length !== 1) throw new Error('EXPERIMENT_MODEL_SELECTOR_AMBIGUOUS_OR_MISSING')
  return resolveDelegationChannelOverride({ channelId: channel.id, modelId: models[0].id })!
}
const hostOf = (env: Record<string, string>) => { try { return new URL(env.ANTHROPIC_BASE_URL).host } catch { return '' } }
export function lockExperimentModel(config: DispatchExperiment, role: keyof ExperimentModels): DelegationChannelOverride {
  const binding = resolveExperimentModel(config.models![role])
  binding.maxTokens = Math.min(binding.maxTokens ?? Infinity, experimentLimits(config).max_output_tokens)
  const receipt = { channel_id: binding.channelId, model: binding.modelName, endpoint_host: hostOf(binding.env),
    endpoint_fingerprint: createHash('sha256').update(binding.env.ANTHROPIC_BASE_URL).digest('hex'), provider_type: binding.providerType }
  const previous = config.observed_models?.[role]
  if (previous && JSON.stringify(previous) !== JSON.stringify(receipt)) throw new Error('EXPERIMENT_MODEL_CATALOG_CHANGED')
  if (!previous) { config.observed_models ??= {}; config.observed_models[role] = receipt; writeExperiment(config); recordExperiment(config, 'model_bound', { role, ...receipt }) }
  return binding
}
export function bindExperimentWorkers(config: DispatchExperiment): void {
  const binding = config.models && lockExperimentModel(config, 'executor')
  for (const worker of Object.values(config.workers)) {
    const context = { projectId: config.project_id, sessionId: config.parent_session_id! }
    const record = findDelegation(context.sessionId, worker.delegation_id) ?? restoreCompletedDelegation(context, worker.delegation_id)
    if (binding) record.channelOverride = binding
  }
}
export function experimentRunSignal(config: DispatchExperiment, signal: AbortSignal): AbortSignal {
  if (!config.started_at) { config.started_at = new Date().toISOString(); writeExperiment(config) }
  const remaining = Date.parse(config.started_at) + experimentLimits(config).wall_ms - Date.now()
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('EXPERIMENT_WALL_BUDGET_EXHAUSTED')
  return AbortSignal.any([signal, AbortSignal.timeout(Math.ceil(remaining))])
}
/** Attest requested routing before invoking the SDK; never logs keys or message bodies. */
export function guardExperimentQuery(query: SDKQuery, config: DispatchExperiment, stage: 'implement' | 'verify'): SDKQuery {
  return async function* (prompt, options) {
    const executor = stage === 'implement' && (config.policy === 'standalone' || options.accounting?.role === 'implement')
    const role = stage === 'verify' ? 'verifier' : executor ? 'executor' : 'dispatcher'
    options.signal.throwIfAborted()
    const latest = validateExperiment(JSON.parse(readFileSync(experimentPath(config.project_id), 'utf8')))
    if (latest.run_id !== config.run_id || latest.condition_hash !== config.condition_hash) throw new Error('EXPERIMENT_RUN_CHANGED')
    if (readExperimentEvents(latest).events.some(event => event.event === 'run_finished')) throw new Error('EXPERIMENT_ALREADY_FINISHED_RESTORE_FRESH_RUN')
    if (!experimentInputsIntact(latest)) throw new Error('EXPERIMENT_FROZEN_INPUT_CHANGED')
    assertExperimentEvaluator(getPromaHome(), latest.evaluator_hash)
    config.request_count = latest.request_count ?? 0; config.started_at = latest.started_at ?? config.started_at
    const expected = lockExperimentModel(config, role)
    if (options.env.ANTHROPIC_MODEL !== expected.modelName || options.env.ANTHROPIC_BASE_URL !== expected.env.ANTHROPIC_BASE_URL) {
      recordExperiment(config, 'model_mismatch', { role, session_id: options.sessionId, requested_model: options.env.ANTHROPIC_MODEL })
      throw new Error('EXPERIMENT_MODEL_MISMATCH')
    }
    if (config.request_count >= experimentLimits(config).max_requests) throw new Error('EXPERIMENT_REQUEST_BUDGET_EXHAUSTED')
    config.request_count++; writeExperiment(config)
    const signal = experimentRunSignal(config, options.signal)
    const settings = config.settings ?? DEFAULT_EXPERIMENT_SETTINGS
    recordExperiment(config, 'model_request', { role, channel_id: expected.channelId, model: expected.modelName,
      endpoint_host: hostOf(expected.env), session_id: options.sessionId, sdk_request_id: options.accounting?.runId,
      host_max_tokens: expected.maxTokens!, caller_max_tokens: options.maxTokens,
      max_tokens: capMaxTokensForProvider(expected.maxTokens!, expected.providerType, expected.modelName), temperature: settings.temperature,
      thinking_level: settings.thinking_level, response_header_timeout_ms: settings.response_header_timeout_ms ?? 30000, request_number: config.request_count })
    const number = config.request_count
    try {
      yield* query(prompt, { ...options, signal, env: expected.env,
        maxTokens: expected.maxTokens!, providerType: expected.providerType,
        temperature: settings.temperature, thinkingLevel: settings.thinking_level,
        responseHeaderTimeoutMs: settings.response_header_timeout_ms ?? 30000,
        accounting: options.accounting ? { ...options.accounting, runId: config.run_id, role: `experiment_${role}` } : undefined })
    } catch (error) {
      const rejection = error as { status?: number; providerCode?: string; nonRetryable?: boolean }
      if (rejection?.status === 429 && rejection.providerCode === '1113' && rejection.nonRetryable === true) {
        finishExperiment(config, 'failed', 'PROVIDER_BALANCE_EXHAUSTED')
      }
      throw error
    } finally { recordExperiment(config, 'model_request_finished', { role, session_id: options.sessionId, request_number: number }) }
  }
}

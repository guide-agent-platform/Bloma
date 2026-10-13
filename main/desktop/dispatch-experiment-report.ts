import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readProjectUsage } from '../platform/llm/request-ledger'
import { experimentPath, validateExperiment } from './dispatch-experiment'

/** Native outcomes are evidence of pipeline state, not a substitute for fixed product scoring. */
export function reportModelExperiment(projectId: string) {
  const home = getPromaHome(), config = validateExperiment(JSON.parse(readFileSync(experimentPath(projectId), 'utf8')))
  const path = join(home, 'dispatch-experiments/events', `${config.run_id}.jsonl`)
  const events: Array<Record<string, unknown>> = []; let malformed = 0
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try { const event = JSON.parse(line); if (event.run_id === config.run_id) events.push(event) } catch { malformed++ }
  }
  const requests = events.filter(event => event.event === 'model_request')
  const roles: Record<string, { requests: number; models: string[] }> = {}
  for (const request of requests) {
    const role = String(request.role), row = roles[role] ??= { requests: 0, models: [] }
    row.requests++; if (!row.models.includes(String(request.model))) row.models.push(String(request.model))
  }
  const active = new Set<string>(); let peak = 0
  for (const event of events) {
    const key = `${event.session_id}:${event.request_number}`
    if (event.event === 'model_request' && event.role === 'executor') { active.add(key); peak = Math.max(peak, active.size) }
    if (event.event === 'model_request_finished' && event.role === 'executor') active.delete(key)
  }
  const first = events.find(event => event.event === 'implement_started')
  const started = config.started_at ?? first?.at
  const ready = events.find(event => event.event === 'mvp_ready' || event.event === 'delivered')
  const delivered = events.find(event => event.event === 'delivered')
  const elapsed = (a: unknown, b: unknown) => {
    const value = Date.parse(String(b)) - Date.parse(String(a)); return Number.isFinite(value) && value >= 0 ? value : null
  }
  const latestStage = events.filter(event => event.event === 'stage_finished').at(-1)
  return { version: 1, run_id: config.run_id, project_id: projectId, mode: config.mode, policy: config.policy,
    input_hash: config.input_hash, condition_hash: config.condition_hash, models: config.models, observed_models: config.observed_models,
    declared_tasks: config.tasks, model_requests_by_role: roles, peak_overlapping_executor_requests: peak,
    implemented_worker_sessions: config.policy === 'standalone' ? 0 : Object.values(config.workers).filter(worker => worker.has_executed).length,
    machine_ms: started && ready ? elapsed(started, ready.at) : null,
    human_wait_ms: ready?.event === 'mvp_ready' && delivered ? elapsed(ready.at, delivered.at) : null,
    native_outcome: delivered ? 'delivered' : ready ? 'mvp_ready' : requests.length ? 'not_finished' : 'not_started',
    last_stage_status: latestStage?.status ?? null,
    product_quality: null, // Supplied by the independent, frozen task evaluator, not invented from loop status.
    project_usage: readProjectUsage(projectId), malformed_events: malformed, unfinished_executor_requests: active.size,
    protocol_rejections: events.filter(event => ['dispatch_rejected', 'write_rejected', 'model_mismatch'].includes(String(event.event))).length }
}

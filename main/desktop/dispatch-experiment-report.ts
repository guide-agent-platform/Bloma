import { readFileSync } from 'node:fs'
import { getPromaHome } from '../../storage/config-paths'
import { readProjectUsage } from '../platform/llm/request-ledger'
import { experimentPath, validateExperiment } from './dispatch-experiment'
import { readExperimentEvents } from './dispatch-experiment-records'
import { evaluationEvidenceValid, type Evaluation } from './dispatch-experiment-evaluator'

/** Native outcomes are evidence of pipeline state, not a substitute for fixed product scoring. */
export function reportModelExperiment(projectId: string, home = getPromaHome()) {
  const config = validateExperiment(JSON.parse(readFileSync(experimentPath(projectId, home), 'utf8')))
  const { events, malformed } = readExperimentEvents(config, home)
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
  const finished = events.find(event => event.event === 'run_finished')
  const evaluation = events.filter(event => event.event === 'product_evaluated').at(-1)?.evaluation as Evaluation | undefined
  const evidenceValid = evaluation ? evaluationEvidenceValid(home, projectId, config.evaluator_hash, evaluation) : null
  const repairDuringReview = ready && delivered && events.some(event => event.event === 'experiment_stage_started'
    && Date.parse(String(event.at)) >= Date.parse(String(ready.at)) && Date.parse(String(event.at)) <= Date.parse(String(delivered.at)))
  const elapsed = (a: unknown, b: unknown) => {
    const value = Date.parse(String(b)) - Date.parse(String(a)); return Number.isFinite(value) && value >= 0 ? value : null
  }
  const latestStage = events.filter(event => event.event === 'stage_finished').at(-1)
  return { version: 2, run_id: config.run_id, project_id: projectId, mode: config.mode, policy: config.policy,
    sample: config.sample, evaluator_hash: config.evaluator_hash, limits: config.limits, settings: config.settings, runtime_hash: config.runtime_hash, required_writes: config.required_writes,
    input_hash: config.input_hash, condition_hash: config.condition_hash, models: config.models, observed_models: config.observed_models,
    declared_tasks: config.tasks, model_requests_by_role: roles, peak_overlapping_executor_requests: peak,
    implemented_worker_sessions: config.policy === 'standalone' ? 0 : Object.values(config.workers).filter(worker => worker.has_executed).length,
    started_at: started ?? null, ended_at: finished?.at ?? null, run_outcome: finished?.outcome ?? null, termination_reason: finished?.reason ?? null,
    machine_ms: started && (finished || ready) ? elapsed(started, finished?.at ?? ready?.at) : null,
    time_to_ready_ms: started && ready ? elapsed(started, ready.at) : null,
    human_wait_ms: ready?.event === 'mvp_ready' && delivered && !repairDuringReview ? elapsed(ready.at, delivered.at) : null,
    mvp_review_span_ms: ready?.event === 'mvp_ready' && delivered ? elapsed(ready.at, delivered.at) : null,
    native_outcome: delivered ? 'delivered' : ready ? 'mvp_ready' : requests.length ? 'not_finished' : 'not_started',
    last_stage_status: latestStage?.status ?? null,
    product_quality: evaluation?.complete && evidenceValid ? evaluation.score : null, product_success: evaluation?.complete && evidenceValid ? evaluation.success : null,
    evaluation: evaluation ?? null, evaluation_evidence_valid: evidenceValid, stage_attempts: events.filter(event => event.event === 'experiment_stage_finished'),
    declared_task_count: config.tasks.length,
    project_usage: readProjectUsage(projectId, { home }), run_usage: readProjectUsage(projectId, { home, runId: config.run_id }),
    malformed_events: malformed, unfinished_executor_requests: active.size,
    protocol_rejections: events.filter(event => ['dispatch_rejected', 'write_rejected', 'model_mismatch'].includes(String(event.event))).length }
}

/** Internal, opt-in experiment state. Stored outside the agent's product root. */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { appendJsonLine, writeTextFileAtomic } from '../../storage/json-store'
import { finishExperiment } from './dispatch-experiment-records'

export const EXPERIMENT_SWITCH = 'BLOMA_DISPATCH_EXPERIMENT'
export const EXPERIMENT_POLICIES = ['single_worker', 'parallel_workers', 'autonomous', 'standalone'] as const
export type ExperimentPolicy = typeof EXPERIMENT_POLICIES[number]
export interface ExperimentModel { channel_id: string; model_id: string }
export interface ExperimentModels { dispatcher: ExperimentModel; executor: ExperimentModel; verifier: ExperimentModel }
export interface ExperimentSettings { temperature: number; thinking_level: 'off' | 'low' | 'high' | 'max' }
export const DEFAULT_EXPERIMENT_SETTINGS: ExperimentSettings = { temperature: 0.1, thinking_level: 'low' }
export interface ExperimentModelReceipt { channel_id: string; model: string; endpoint_host: string; endpoint_fingerprint?: string; provider_type?: string }
export interface ExperimentLimits { max_workers: number; max_tasks: number; dispatcher_turns: number; executor_turns: number; max_requests: number; max_output_tokens: number; wall_ms: number }
export const DEFAULT_EXPERIMENT_LIMITS: ExperimentLimits = { max_workers: 2, max_tasks: 16, dispatcher_turns: 40, executor_turns: 32, max_requests: 128, max_output_tokens: 8192, wall_ms: 1_800_000 }
export interface ExperimentTask { id: string; instruction: string; depends_on: string[]; writes: string[] }
export interface ExperimentWorker { delegation_id: string; child_session_id: string; task_ids: string[]; has_executed?: boolean }
export interface ExperimentSample { task_id: string; repeat_id: string; pair_id: string; group: 'G11' | 'G12' | 'G21' | 'G22' | 'S1' | 'S2' }
export interface DispatchExperiment {
  version: 1; project_id: string; mode: 'quick' | 'longterm'; experiment_id: string; run_id: string
  state: 'prepare' | 'prepared' | 'running'; policy?: ExperimentPolicy; planning?: 'fixed' | 'autonomous'
  snapshot_id?: string; input_hash?: string; parent_session_id?: string
  runtime_hash?: string
  sample?: ExperimentSample; evaluator_hash?: string
  models?: ExperimentModels; limits?: ExperimentLimits; condition_hash?: string
  settings?: ExperimentSettings; protected_inputs?: Record<string, string>
  observed_models?: Partial<Record<keyof ExperimentModels, ExperimentModelReceipt>>
  started_at?: string; request_count?: number; plan_locked?: boolean
  tasks: ExperimentTask[]; workers: Record<string, ExperimentWorker>
  prepared?: { at: string; requirements_digest: string; ux_html?: string; ux_design?: string }
}
export const experimentLimits = (config: DispatchExperiment) => config.limits ?? DEFAULT_EXPERIMENT_LIMITS
export function experimentConditionHash(config: DispatchExperiment): string {
  return createHash('sha256').update(JSON.stringify({ mode: config.mode, policy: config.policy,
    planning: config.planning ?? 'fixed', models: config.models, limits: config.limits, settings: config.models ? config.settings ?? DEFAULT_EXPERIMENT_SETTINGS : config.settings,
    protected_inputs: config.protected_inputs, input_hash: config.input_hash, runtime_hash: config.runtime_hash,
    sample: config.sample, evaluator_hash: config.evaluator_hash })).digest('hex')
}
export function validateExperimentTasks(tasks: ExperimentTask[], maximum: number): void {
  if (!Array.isArray(tasks) || tasks.length > maximum) throw new Error('EXPERIMENT_INVALID_TASKS')
  const ids = new Set(tasks.map(task => task.id))
  if (ids.size !== tasks.length) throw new Error('EXPERIMENT_DUPLICATE_TASK')
  for (const task of tasks) {
    assertExperimentId(task.id)
    if (typeof task.instruction !== 'string' || !task.instruction.trim() || !Array.isArray(task.depends_on)
      || !Array.isArray(task.writes) || !task.writes.length) throw new Error('EXPERIMENT_INVALID_TASK')
    for (const dependency of task.depends_on) if (!ids.has(dependency) || dependency === task.id) throw new Error('EXPERIMENT_INVALID_DEPENDENCY')
    for (const path of task.writes) if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/')
      || path.includes(':') || path.split('/').includes('..') || path.split('/').includes('.')) throw new Error('EXPERIMENT_INVALID_WRITE_PATH')
  }
  const visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('EXPERIMENT_CYCLIC_TASKS')
    if (visited.has(id)) return
    visiting.add(id); for (const dependency of tasks.find(task => task.id === id)!.depends_on) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of ids) visit(id)
}
const identifier = /^[A-Za-z0-9_-]{1,100}$/
export function assertExperimentId(value: string): string {
  if (typeof value !== 'string' || !identifier.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('EXPERIMENT_INVALID_ID')
  return value
}
export function experimentPath(projectId: string, home = getPromaHome()): string {
  return join(home, 'dispatch-experiments', `${assertExperimentId(projectId)}.json`)
}
export function assertExperimentHome(home = getPromaHome()): void {
  if (resolve(home).toLowerCase() === resolve(join(homedir(), '.proma')).toLowerCase()
    || !existsSync(join(home, 'dispatch-experiment-home.json'))
    || JSON.parse(readFileSync(join(home, 'dispatch-experiment-home.json'), 'utf8')).version !== 1) {
    throw new Error('EXPERIMENT_REQUIRES_ISOLATED_HOME')
  }
}
export function validateExperiment(raw: unknown): DispatchExperiment {
  const value = raw as DispatchExperiment
  if (!value || value.version !== 1 || !['quick', 'longterm'].includes(value.mode)
    || !['prepare', 'prepared', 'running'].includes(value.state)) throw new Error('EXPERIMENT_INVALID_CONFIG')
  for (const id of [value.project_id, value.experiment_id, value.run_id]) assertExperimentId(id)
  if (value.parent_session_id) assertExperimentId(value.parent_session_id)
  if (value.sample) {
    for (const id of [value.sample.task_id, value.sample.repeat_id, value.sample.pair_id]) assertExperimentId(id)
    if (!['G11', 'G12', 'G21', 'G22', 'S1', 'S2'].includes(value.sample.group)) throw new Error('EXPERIMENT_INVALID_SAMPLE')
    if ((value.policy === 'standalone') !== value.sample.group.startsWith('S')) throw new Error('EXPERIMENT_SAMPLE_POLICY_MISMATCH')
  }
  if (value.evaluator_hash && !/^[a-f0-9]{64}$/.test(value.evaluator_hash)) throw new Error('EXPERIMENT_INVALID_EVALUATOR_HASH')
  if (value.settings && (!Number.isFinite(value.settings.temperature) || value.settings.temperature < 0 || value.settings.temperature > 2
    || !['off', 'low', 'high', 'max'].includes(value.settings.thinking_level))) throw new Error('EXPERIMENT_INVALID_SETTINGS')
  for (const [path, hash] of Object.entries(value.protected_inputs ?? {})) if (path.includes('\\') || path.startsWith('/') || path.includes(':') || path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(hash)) throw new Error('EXPERIMENT_INVALID_PROTECTED_INPUT')
  if (value.planning && !['fixed', 'autonomous'].includes(value.planning)) throw new Error('EXPERIMENT_INVALID_PLANNING')
  if (!value.workers || typeof value.workers !== 'object' || Array.isArray(value.workers)) throw new Error('EXPERIMENT_INVALID_WORKERS')
  if (value.limits) for (const [key, maximum] of Object.entries({ max_workers: 4, max_tasks: 32, dispatcher_turns: 100, executor_turns: 100, max_requests: 1000, max_output_tokens: 640000, wall_ms: 7_200_000 })) {
    const number = value.limits[key as keyof ExperimentLimits]
    if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('EXPERIMENT_INVALID_LIMITS')
  }
  validateExperimentTasks(value.tasks, value.planning === 'autonomous' ? experimentLimits(value).max_tasks : 2)
  const ids = new Set(value.tasks.map(task => task.id))
  if (value.models) for (const role of ['dispatcher', 'executor', 'verifier'] as const) {
    const binding = value.models[role]
    for (const selector of [binding?.channel_id, binding?.model_id]) if (typeof selector !== 'string' || !selector.trim() || selector !== selector.trim() || selector.length > 160) throw new Error('EXPERIMENT_INVALID_MODEL_BINDING')
    if (Object.keys(binding).some(key => !['channel_id', 'model_id'].includes(key))) throw new Error('EXPERIMENT_MODEL_BINDING_ACCEPTS_SELECTORS_ONLY')
  }
  const modern = value.policy === 'autonomous' || value.policy === 'standalone'
  if (value.state === 'running' && (!(EXPERIMENT_POLICIES as readonly string[]).includes(value.policy ?? '')
    || (!modern && value.tasks.length !== 2) || (modern && (value.planning !== 'autonomous' || !value.models || !value.condition_hash))
    || !value.snapshot_id || !/^[a-f0-9]{64}$/.test(value.input_hash ?? '') || !value.parent_session_id)) throw new Error('EXPERIMENT_RUN_NOT_FROZEN')
  if (value.policy === 'standalone' && value.tasks.length) throw new Error('EXPERIMENT_STANDALONE_HAS_NO_DISPATCH_PLAN')
  if (value.condition_hash && value.condition_hash !== experimentConditionHash(value)) throw new Error('EXPERIMENT_CONDITION_CHANGED')
  if (value.request_count !== undefined && (!Number.isSafeInteger(value.request_count) || value.request_count < 0)) throw new Error('EXPERIMENT_INVALID_REQUEST_COUNT')
  for (const worker of Object.values(value.workers)) {
    assertExperimentId(worker.delegation_id); assertExperimentId(worker.child_session_id)
    if (!Array.isArray(worker.task_ids) || worker.task_ids.some(id => !ids.has(id))) throw new Error('EXPERIMENT_INVALID_WORKER')
  }
  return value
}
export function writeExperiment(config: DispatchExperiment, home = getPromaHome()): void {
  assertExperimentHome(home)
  writeTextFileAtomic(experimentPath(config.project_id, home), JSON.stringify(validateExperiment(config), null, 2) + '\n')
}
export function readExperiment(projectId: string): DispatchExperiment | undefined {
  if (process.env[EXPERIMENT_SWITCH] !== '1') return undefined
  const path = experimentPath(projectId)
  if (!existsSync(path)) return undefined
  assertExperimentHome()
  const config = validateExperiment(JSON.parse(readFileSync(path, 'utf8')))
  if (config.project_id !== projectId) throw new Error('EXPERIMENT_PROJECT_MISMATCH')
  if (config.state === 'running' && config.runtime_hash) {
    const bundle = resolve('dist-main/main/index.js')
    if (!existsSync(bundle) || createHash('sha256').update(readFileSync(bundle)).digest('hex') !== config.runtime_hash) throw new Error('EXPERIMENT_RUNTIME_CHANGED')
  }
  return config
}
export function recordExperiment(config: DispatchExperiment, event: string, payload: Record<string, unknown> = {}, home = getPromaHome()): void {
  appendJsonLine(join(home, 'dispatch-experiments', 'events', `${config.run_id}.jsonl`), {
    at: new Date().toISOString(), event, experiment_id: config.experiment_id, run_id: config.run_id,
    project_id: config.project_id, mode: config.mode, policy: config.policy, snapshot_id: config.snapshot_id, ...payload,
  })
}
export function recordExperimentBoundary(projectId: string, event: string, payload: Record<string, unknown> = {}): void {
  const config = readExperiment(projectId)
  if (config?.state === 'running') {
    recordExperiment(config, event, payload)
    if (event === 'mvp_ready' || event === 'delivered') finishExperiment(config, 'ready', event)
  }
}
export function holdExperimentBeforeImplement(project: { project_id: string; mode: string }, sessionId: string,
  context: { requirements_digest: string; ux_html?: string; ux_design?: string }): boolean {
  const config = readExperiment(project.project_id)
  if (!config) return false
  if (config.mode !== project.mode) throw new Error('EXPERIMENT_MODE_MISMATCH')
  if (config.state === 'running') {
    if (config.parent_session_id !== sessionId) throw new Error('EXPERIMENT_SESSION_MISMATCH')
    return false
  }
  if (config.state === 'prepare') {
    config.state = 'prepared'; config.parent_session_id = sessionId
    config.prepared = { at: new Date().toISOString(), ...context }
    writeExperiment(config)
    recordExperiment(config, 'prepared', { parent_session_id: sessionId })
  }
  return true
}

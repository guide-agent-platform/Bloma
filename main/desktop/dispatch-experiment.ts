/** Internal, opt-in experiment state. Stored outside the agent's product root. */
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { appendJsonLine, writeTextFileAtomic } from '../../storage/json-store'

export const EXPERIMENT_SWITCH = 'BLOMA_DISPATCH_EXPERIMENT'
export interface ExperimentTask { id: string; instruction: string; depends_on: string[]; writes: string[] }
export interface ExperimentWorker { delegation_id: string; child_session_id: string; task_ids: string[]; has_executed?: boolean }
export interface DispatchExperiment {
  version: 1; project_id: string; mode: 'quick' | 'longterm'; experiment_id: string; run_id: string
  state: 'prepare' | 'prepared' | 'running'; policy?: 'single_worker' | 'parallel_workers'
  snapshot_id?: string; input_hash?: string; parent_session_id?: string
  runtime_hash?: string
  tasks: ExperimentTask[]; workers: Record<string, ExperimentWorker>
  prepared?: { at: string; requirements_digest: string; ux_html?: string; ux_design?: string }
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
  if (!Array.isArray(value.tasks) || value.tasks.length > 2 || !value.workers || typeof value.workers !== 'object' || Array.isArray(value.workers)) throw new Error('EXPERIMENT_INVALID_TASKS')
  const ids = new Set(value.tasks.map(task => task.id))
  if (ids.size !== value.tasks.length) throw new Error('EXPERIMENT_DUPLICATE_TASK')
  for (const task of value.tasks) {
    assertExperimentId(task.id)
    if (typeof task.instruction !== 'string' || !task.instruction.trim() || !Array.isArray(task.depends_on)
      || !Array.isArray(task.writes) || !task.writes.length) throw new Error('EXPERIMENT_INVALID_TASK')
    for (const dependency of task.depends_on) if (!ids.has(dependency) || dependency === task.id) throw new Error('EXPERIMENT_INVALID_DEPENDENCY')
    for (const path of task.writes) if (typeof path !== 'string' || !path || path.includes('\\') || path.startsWith('/')
      || path.includes(':') || path.split('/').includes('..') || path.split('/').includes('.')) throw new Error('EXPERIMENT_INVALID_WRITE_PATH')
  }
  if (value.tasks.length === 2 && value.tasks.every(task => task.depends_on.length)) throw new Error('EXPERIMENT_CYCLIC_TASKS')
  if (value.state === 'running' && (!['single_worker', 'parallel_workers'].includes(value.policy ?? '')
    || value.tasks.length !== 2 || !value.snapshot_id || !/^[a-f0-9]{64}$/.test(value.input_hash ?? '') || !value.parent_session_id)) throw new Error('EXPERIMENT_RUN_NOT_FROZEN')
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
  if (config?.state === 'running') recordExperiment(config, event, payload)
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

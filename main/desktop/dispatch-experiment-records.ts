import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import type { DispatchExperiment } from './dispatch-experiment'

export type ExperimentOutcome = 'ready' | 'failed' | 'timeout' | 'cancelled' | 'interrupted'
export function readExperimentEvents(config: DispatchExperiment, home = getPromaHome()) {
  const path = join(home, 'dispatch-experiments/events', `${config.run_id}.jsonl`)
  const events: Array<Record<string, unknown>> = []; let malformed = 0
  if (existsSync(path)) for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line)
      if (!event || event.run_id !== config.run_id || event.project_id !== config.project_id
        || typeof event.event !== 'string' || !Number.isFinite(Date.parse(event.at))) { malformed++; continue }
      events.push(event)
    } catch { malformed++ }
  }
  return { events, malformed }
}
/** The first terminal receipt is immutable. Further work must use a fresh restored run. */
export function finishExperiment(config: DispatchExperiment, outcome: ExperimentOutcome, reason: string, home = getPromaHome()) {
  if (readExperimentEvents(config, home).events.some(event => event.event === 'run_finished')) return
  appendJsonLine(join(home, 'dispatch-experiments/events', `${config.run_id}.jsonl`), {
    at: new Date().toISOString(), event: 'run_finished', experiment_id: config.experiment_id, run_id: config.run_id,
    project_id: config.project_id, mode: config.mode, policy: config.policy, snapshot_id: config.snapshot_id,
    outcome, reason,
  })
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'

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

import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
export function supervisionState({ launcher_alive, driver_alive, electron_alive, terminal, heartbeat_at, now }) {
  if (!launcher_alive && !driver_alive && !electron_alive) return terminal ? 'finished' : 'process-lost'
  if (terminal) return 'stopping'
  if (heartbeat_at && now - Date.parse(heartbeat_at) > 45000) return 'heartbeat-stale'
  return heartbeat_at ? 'locally-running' : 'starting'
}

export function ledgerClosure(events) {
  const starts = events.filter(e => e.event === 'query_started')
  const ends = events.filter(e => e.event === 'query_finished')
  const orphaned = starts.filter(s => !ends.some(e => e.query_id === s.query_id))
  return { queries: starts.length, terminal_receipts: ends.length, malformed_lines: events.malformed_lines ?? 0, read_error: events.read_error ?? null,
    orphaned: orphaned.map(s => ({ query_id: s.query_id, model: s.model, usage: 'unknown', remote_outcome: 'unknown' })) }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))throw Error('LEGACY_EXPERIMENT_EXECUTION_RETIRED: use inspect/report/aggregate')

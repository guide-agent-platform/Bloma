import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ledgerClosure, supervisionState } from './dispatch-experiment-supervisor.mjs'

test('a running marker cannot make an absent process healthy', () => {
  assert.equal(supervisionState({ launcher_alive: false, driver_alive: false, electron_alive: false, terminal: null, now: 100000, state: 'running' }), 'process-lost')
})
test('terminal cleanup waits for live owned processes and detects stale heartbeats', () => {
  const owned = { launcher_alive: true, driver_alive: true, electron_alive: true }
  assert.equal(supervisionState({ ...owned, terminal: { outcome: 'failed' }, now: 100000 }), 'stopping')
  assert.equal(supervisionState({ ...owned, heartbeat_at: new Date(0).toISOString(), now: 100000 }), 'heartbeat-stale')
  assert.equal(supervisionState({ ...owned, heartbeat_at: new Date(99000).toISOString(), now: 100000 }), 'locally-running')
})
test('orphan receipts remain unknown without fabricated completion or zero usage', () => {
  const events = [{ event: 'query_started', query_id: 'a' }, { event: 'query_finished', query_id: 'a' },
    { event: 'query_started', query_id: 'b', model: 'glm-5.3-flash' }]
  const before = JSON.stringify(events), result = ledgerClosure(events)
  assert.equal(result.queries, 2); assert.equal(result.terminal_receipts, 1)
  assert.deepEqual(result.orphaned, [{ query_id: 'b', model: 'glm-5.3-flash', usage: 'unknown', remote_outcome: 'unknown' }])
  assert.equal(JSON.stringify(events), before)
})

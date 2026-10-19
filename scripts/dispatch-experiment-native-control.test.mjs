import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeHeartbeat, nativeProcessEvent, nativeProcessReceipt } from './dispatch-experiment-native-control.mjs'

test('process receipt records both ownership PIDs without copying environment or prompts', () => {
  const receipt = nativeProcessReceipt({ at: 'now', driver_pid: 12, driver_ppid: 11, electron_pid: 13, home: 'isolated', run_id: 'run',
    env: { API_KEY: 'secret' }, prompt: 'private', argv: ['secret'] })
  assert.deepEqual(receipt, { at: 'now', driver_pid: 12, driver_ppid: 11, electron_pid: 13, home: 'isolated', run_id: 'run' })
  assert(!JSON.stringify(receipt).includes('secret'))
})

test('heartbeat preserves a real zero exit code and supports fresh preparation without a project', () => {
  const heartbeat = nativeHeartbeat({ at: 'now', driver_pid: 12, electron_pid: 13, electron_exit_code: 0, electron_killed: false,
    env: { API_KEY: 'secret' }, screen_text: 'private' })
  assert.equal(heartbeat.electron_exit_code, 0)
  assert.equal(heartbeat.project_id, null)
  assert.equal(heartbeat.run_id, null)
  assert.equal(heartbeat.electron_killed, false)
  assert(!JSON.stringify(heartbeat).includes('secret'))
  assert(!JSON.stringify(heartbeat).includes('private'))
})

test('exit and close telemetry retain observed termination without inventing an outcome', () => {
  for (const event of ['exit', 'close']) {
    const value = nativeProcessEvent({ at: 'now', event, exit_code: null, signal: 'SIGKILL', driver_pid: 12, electron_pid: 13,
      outcome: 'completed', usage: { output_tokens: 99 } })
    assert.equal(value.event, event)
    assert.equal(value.signal, 'SIGKILL')
    assert.equal(value.exit_code, null)
    assert(!('usage' in value))
    assert(!('outcome' in value))
  }
})

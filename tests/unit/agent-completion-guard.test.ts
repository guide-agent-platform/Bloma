import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAgentLoop, type AgentLoopInput } from '../../main/agent/loop/agent-loop'
import { restorePromaHome } from '../support/proma-home-guard'
import type { SDKMessage } from '../../shared/types'

describe('host completion prerequisites', () => {
  const prior = process.env.PROMA_HOME
  beforeEach(() => { process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-completion-')) })
  afterEach(() => restorePromaHome(prior))
  function input(): AgentLoopInput {
    return { projectId: 'p', sessionId: 's', requestId: 'r', system: '', task: 'work', tools: [], env: {}, maxTokens: 128, maxTurns: 4,
      permissionMode: 'allow-all', signal: new AbortController().signal, publish: () => {},
      query: async function* () {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'model end' }] } } as SDKMessage
        yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' } as SDKMessage
      } }
  }
  it('does not complete or spend another model call while a host prerequisite is waiting', async () => {
    let calls = 0, release!: () => void, entered!: () => void
    const wait = new Promise<void>(r => { release = r }), started = new Promise<void>(r => { entered = r })
    const options = input(), query = options.query
    options.query = async function* (...args) { calls++; yield* query(...args) }
    options.beforeComplete = async () => { if (calls === 1) { entered(); await wait; return 'child completed; inspect actual evidence' } return undefined }
    const running = runAgentLoop(options)
    await started; expect(calls).toBe(1)
    release()
    expect((await running).status).toBe('completed'); expect(calls).toBe(2)
  })
  it('cancellation while waiting does not buy the next request', async () => {
    let calls = 0, entered!: () => void
    const started = new Promise<void>(r => { entered = r }), abort = new AbortController(), options = input(), query = options.query
    options.signal = abort.signal
    options.query = async function* (...args) { calls++; yield* query(...args) }
    options.beforeComplete = async () => new Promise((_, reject) => { entered(); abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true }) })
    const running = runAgentLoop(options); await started; abort.abort()
    expect((await running).status).toBe('cancelled'); expect(calls).toBe(1)
  })
  it('a grace summary cannot bypass an unsatisfied prerequisite at the turn limit', async () => {
    const options = input(); options.maxTurns = 1; options.beforeComplete = async () => 'still pending'
    expect((await runAgentLoop(options)).status).toBe('turn_limit')
  })
})

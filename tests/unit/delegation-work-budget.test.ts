import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDelegationTurns } from '../../main/agent/delegation/delegation-context'
import { runAgentLoop } from '../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
afterEach(() => vi.unstubAllEnvs())

describe('delegation work budgets', () => {
  it('keeps existing callers unchanged and assigns implementation a distinct budget within the parent cap', () => {
    const context = { maxTurns: 40, delegationMaxTurns: 12, delegationTurnLimits: { implement: 24, custom: 24 } }
    expect(resolveDelegationTurns(context, 'implement')).toBe(24)
    expect(resolveDelegationTurns(context, 'research')).toBe(12)
    expect(resolveDelegationTurns({ maxTurns: 6, delegationMaxTurns: 4 }, 'implement')).toBe(4)
    expect(resolveDelegationTurns({ ...context, maxTurns: 20 }, 'implement')).toBe(20)
  })
  it('a 13-step implementation reaches completion under its budget while a 12-turn run reports partial termination', async () => {
    vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-work-budget-')))
    const run = async (maxTurns: number) => {
      let turn = 0
      const query: SDKQuery = async function* () {
        const content = turn++ < 13 ? [{ type: 'tool_use' as const, id: `step-${turn}`, name: 'step', input: {} }] : [{ type: 'text' as const, text: 'completed' }]
        yield { type: 'assistant', message: { role: 'assistant', content } }
        yield { type: 'result', subtype: 'success', stop_reason: turn <= 13 ? 'tool_use' : 'end_turn' }
      }
      return runAgentLoop({ system: 'test', task: '13 steps', query, env: {}, maxTokens: 2048, maxTurns, sessionId: `s-${maxTurns}`, projectId: 'p', requestId: 'r', signal: new AbortController().signal, delegationDepth: 1, permissionMode: 'allow-all', publish: () => {}, tools: [{ name: 'step', description: 'step', input_schema: { type: 'object', properties: {} }, execute: async () => ({ output: 'ok' }) }] })
    }
    expect((await run(12)).status).toBe('turn_limit')
    expect((await run(24)).status).toBe('completed')
  })
})

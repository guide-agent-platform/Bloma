import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createToolState, type AgentLoopTool, type ToolContext } from '../../../main/agent/loop/agent-loop'
import * as collaboration from '../../../main/agent/delegation/agent-collaboration'
import { readTaskHandoff, type TaskHandoff } from '../../../main/agent/delegation/task-handoff'
import { experimentConditionHash, writeExperiment, type DispatchExperiment } from '../../../main/desktop/dispatch-experiment'
import { wrapAutonomousDispatcherTools } from '../../../main/desktop/dispatch-experiment-autonomous'
import { experimentTasksFinished, wrapExperimentDispatcherTools } from '../../../main/desktop/dispatch-experiment-policy'
import { readExperimentEvents } from '../../../main/desktop/dispatch-experiment-records'

const captured = JSON.parse(readFileSync(new URL('../../fixtures/dispatch-experiment/r4-handoffs.json', import.meta.url), 'utf8')) as { backend: TaskHandoff; ui: TaskHandoff }
let home: string, originalHome: string | undefined
beforeEach(() => {
  originalHome = process.env.PROMA_HOME
  home = mkdtempSync(join(tmpdir(), 'handoff-ready-'))
  process.env.PROMA_HOME = home
  writeFileSync(join(home, 'dispatch-experiment-home.json'), '{"version":1}')
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalHome === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = originalHome
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

function fixture(policy: 'autonomous' | 'parallel_workers' = 'autonomous') {
  const config: DispatchExperiment = { version: 1, project_id: 'p', mode: 'quick', experiment_id: 'replay', run_id: 'run', state: 'running',
    policy, ...(policy === 'autonomous' ? { planning: 'autonomous' as const,
      models: { dispatcher: { channel_id: 'fixture', model_id: 'fixture' }, executor: { channel_id: 'fixture', model_id: 'fixture' }, verifier: { channel_id: 'fixture', model_id: 'fixture' } } } : {}),
    snapshot_id: 's', input_hash: 'a'.repeat(64), parent_session_id: 'parent',
    tasks: [{ id: 'ui', instruction: '实现界面', depends_on: [], writes: ['ui/'] },
      { id: 'verify', instruction: '核对真实行为并补齐测试', depends_on: ['ui'], writes: ['test_ui.py'] }],
    workers: { ui: { delegation_id: 'ui-worker', child_session_id: 'ui-child', task_ids: ['ui'], has_executed: true } } }
  config.condition_hash = experimentConditionHash(config)
  writeExperiment(config)
  const record = { delegationId: 'ui-worker', parentSessionId: 'parent', childSessionId: 'ui-child', projectId: 'p', role: 'implement',
    status: 'completed', loopStatus: 'completed', taskHandoff: readTaskHandoff(structuredClone(captured.ui)) } as collaboration.DelegationRecord
  vi.spyOn(collaboration, 'findDelegation').mockReturnValue(record)
  const execute = vi.fn(async () => ({ output: '验证任务已接手', detail: { delegation_id: 'verifier-worker', child_session_id: 'verifier-child' } }))
  const raw: AgentLoopTool[] = [{ name: 'delegate_agent', description: 'test', input_schema: {}, execute }]
  const tools = policy === 'autonomous' ? wrapAutonomousDispatcherTools(raw, config, async (_slot, _ids, action) => action(), () => ({}), () => {})
    : wrapExperimentDispatcherTools(raw, config)
  const ctx: ToolContext = { projectId: 'p', sessionId: 'parent', requestId: 'request', signal: new AbortController().signal, state: createToolState() }
  return { config, record, execute, ctx, delegate: tools.find(tool => tool.name === 'delegate_agent')!, status: tools.find(tool => tool.name === 'experiment_status') }
}

describe('r4 host execution readiness replay', () => {
  it.each(['autonomous', 'parallel_workers'] as const)('%s admits the verifier with the captured failed handoff intact', async policy => {
    const f = fixture(policy)
    const before = structuredClone(f.record.taskHandoff)
    expect(before?.completion).toBe('incomplete')
    const result = await f.delegate.execute(policy === 'autonomous' ? { task_ids: ['verify'] } : { task_id: 'verify' }, f.ctx)
    expect(result.isError).not.toBe(true)
    expect(f.execute).toHaveBeenCalledTimes(1)
    expect(f.record.taskHandoff).toEqual(before)
    expect(f.record.taskHandoff?.verification.filter(fact => fact.verification === 'failed')).toHaveLength(3)
    expect(readExperimentEvents(f.config).events.some(event => event.event === 'run_finished')).toBe(false)
  })

  it.each([
    ['running', undefined], ['failed', undefined], ['cancelled', 'cancelled'], ['completed', 'turn_limit'], ['completed', 'budget_exhausted'],
  ] as const)('does not release %s/%s execution', async (status, loopStatus) => {
    const f = fixture()
    f.record.status = status
    f.record.loopStatus = loopStatus
    expect((await f.delegate.execute({ task_ids: ['verify'] }, f.ctx)).isError).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
    expect(experimentTasksFinished(f.config)).toBe(false)
  })

  it('does not release a merely registered owner or a missing worker', async () => {
    const f = fixture()
    f.config.workers.ui.has_executed = false
    expect((await f.delegate.execute({ task_ids: ['verify'] }, f.ctx)).isError).toBe(true)
    f.config.workers.ui.has_executed = true
    vi.mocked(collaboration.findDelegation).mockReturnValue(undefined)
    expect((await f.delegate.execute({ task_ids: ['verify'] }, f.ctx)).isError).toBe(true)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('terminal cumulative resource failure remains terminal before another task is sent', async () => {
    const f = fixture()
    f.record.taskHandoff!.verification.push({ schema_version: 1, execution: 'not_run', verification: 'unverified', category: 'budget',
      budget: { resource: 'script_runs', scope: 'session', used: 64, limit: 64, remaining: 0, resets_on: 'new_run' } })
    expect((await f.delegate.execute({ task_ids: ['verify'] }, f.ctx)).output).toContain('EXPERIMENT_EXECUTION_BUDGET_EXHAUSTED')
    expect(f.execute).not.toHaveBeenCalled()
    expect(readExperimentEvents(f.config).events.filter(event => event.event === 'run_finished')).toHaveLength(1)
    expect(experimentTasksFinished(f.config)).toBe(false)
  })

  it('execution coverage reaches host verification without attesting old failed or stale proofs', () => {
    const f = fixture()
    f.config.workers.ui.task_ids.push('verify')
    const before = structuredClone(f.record.taskHandoff)
    expect(experimentTasksFinished(f.config)).toBe(true)
    expect(f.record.taskHandoff).toEqual(before)
    expect(before?.completion).toBe('incomplete')
    f.record.taskHandoff = readTaskHandoff(structuredClone(captured.backend))
    expect(experimentTasksFinished(f.config)).toBe(true)
    expect(f.record.taskHandoff?.verification.some(fact => fact.evidence?.freshness === 'stale')).toBe(true)
  })
})

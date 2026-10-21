import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { wrapAutonomousDispatcherTools } from '../../../main/desktop/dispatch-experiment-autonomous'
import { experimentConditionHash, writeExperiment, type DispatchExperiment } from '../../../main/desktop/dispatch-experiment'
import * as collaboration from '../../../main/agent/delegation/agent-collaboration'
import { buildTaskHandoff } from '../../../main/agent/delegation/task-handoff'

let home: string, originalHome: string | undefined
beforeEach(() => {
  originalHome = process.env.PROMA_HOME
  home = mkdtempSync(join(tmpdir(), 'dispatch-reliability-'))
  process.env.PROMA_HOME = home
  writeFileSync(join(home, 'dispatch-experiment-home.json'), '{"version":1}')
})
afterEach(() => {
  vi.restoreAllMocks()
  if (originalHome === undefined) delete process.env.PROMA_HOME
  else process.env.PROMA_HOME = originalHome
  rmSync(home, { recursive: true, force: true })
})
function fixture(required = ['CORE_CHECK.json', 'DELIVERY.md', 'LAUNCH.json']) {
  const role = { channel_id: 'fixture', model_id: 'fixture' }
  const config = Object.assign({ version: 1, project_id: 'p', mode: 'quick', experiment_id: 'reliability', run_id: 'run', state: 'running',
    policy: 'autonomous', planning: 'autonomous', snapshot_id: 'snapshot', input_hash: 'a'.repeat(64), parent_session_id: 'parent',
    models: { dispatcher: role, executor: role, verifier: role }, tasks: [], workers: {},
  } as DispatchExperiment, { required_writes: required })
  config.condition_hash = experimentConditionHash(config)
  writeExperiment(config)
  const created = vi.fn(async (_slot, _ids, action) => action())
  const delegated = vi.fn(async () => ({ output: 'created' }))
  const tools = wrapAutonomousDispatcherTools([{ name: 'delegate_agent', description: 'test', input_schema: { type: 'object', properties: {} }, execute: delegated }], config, created, () => ({}), () => {})
  const ctx: ToolContext = { projectId: 'p', sessionId: 'parent', requestId: 'request', signal: new AbortController().signal, state: createToolState(0) }
  return { config, created, ctx, plan: tools.find(t => t.name === 'experiment_plan')!, delegate: tools.find(t => t.name === 'delegate_agent')!, status: tools.find(t => t.name === 'experiment_status')! }
}
describe('pre-dispatch required artifact permission coverage', () => {
  it('releases ended execution to the next verifier while preserving failed host facts', async () => {
    const f = fixture([])
    await f.plan.execute({ tasks: [{ id: 'left', instruction: '接口', depends_on: [], writes: ['left.py'] },
      { id: 'right', instruction: '消费者', depends_on: ['left'], writes: ['right.py'] }] }, f.ctx)
    f.config.workers.left = { delegation_id: 'left-worker', child_session_id: 'left-child', task_ids: ['left'], has_executed: true }
    const taskHandoff = buildTaskHandoff({ status: 'completed', turns: 1, finalText: '', toolCalls: [],
      tool_feedback: [{ schema_version: 1, execution: 'completed', verification: 'failed', category: 'product_assertion' }] })
    vi.spyOn(collaboration, 'findDelegation').mockReturnValue({ status: 'completed', loopStatus: 'completed', taskHandoff } as collaboration.DelegationRecord)
    expect((await f.delegate.execute({ task_ids: ['right'] }, f.ctx)).isError).not.toBe(true)
    expect(f.created).toHaveBeenCalledTimes(1)
    expect(taskHandoff.completion).toBe('incomplete')
    expect(taskHandoff.verification).toContainEqual(expect.objectContaining({ verification: 'failed' }))
    const status = JSON.parse((await f.status.execute({}, f.ctx)).output)
    expect(status.workers[0]).toMatchObject({ dependency_ready: true, verification_state: 'incomplete' })
  })
  it('status uses the actual continuation admission policy, including exhausted cumulative resources', async () => {
    const f = fixture([])
    f.config.workers.left = { delegation_id: 'left-worker', child_session_id: 'left-child', task_ids: [], has_executed: true }
    const taskHandoff = buildTaskHandoff({ status: 'completed', turns: 1, finalText: '', toolCalls: [], tool_feedback: [{ schema_version: 1,
      execution: 'completed', verification: 'not_applicable', scope: 'execution_resources',
      budget: { resource: 'script_runs', scope: 'session', used: 12, limit: 12, remaining: 0, resets_on: 'new_run' } }] })
    vi.spyOn(collaboration, 'findDelegation').mockReturnValue({ status: 'completed', loopStatus: 'completed', taskHandoff } as collaboration.DelegationRecord)
    const status = JSON.parse((await f.status.execute({}, f.ctx)).output)
    expect(status.workers[0].can_continue).toBe(false)
    expect(status.workers[0].dependency_ready).toBe(true)
    expect(status.workers[0].continuation_blocked_reason).toContain('DELEGATION_BUDGET_REQUIRES_NEW_RUN')
  })
  it('rejects an incomplete plan before irreversible dispatch; allows the model to correct its own plan', async () => {
    const f = fixture()
    const task = { id: 'chosen-by-model', instruction: '业务与自测', depends_on: [], writes: ['app.py', 'test_logic.py'] }
    const rejected = await f.plan.execute({ tasks: [task] }, f.ctx)
    expect(rejected.isError).toBe(true)
    expect(rejected.output).toContain('EXPERIMENT_PLAN_MISSING_REQUIRED_WRITES')
    expect(rejected.output).toContain('CORE_CHECK.json')
    expect(f.config.tasks).toEqual([])
    expect(f.config.plan_locked).not.toBe(true)
    expect((await f.delegate.execute({ task_ids: [task.id] }, f.ctx)).isError).toBe(true)
    expect(f.created).not.toHaveBeenCalled()
    const corrected = { ...task, writes: [...task.writes, ...f.config.required_writes] }
    expect((await f.plan.execute({ tasks: [corrected] }, f.ctx)).isError).not.toBe(true)
    expect(f.config.tasks).toEqual([corrected])
    expect(f.config.tasks[0].writes).not.toContain('core_check.py')
    await f.delegate.execute({ task_ids: [task.id] }, f.ctx)
    expect(f.created).toHaveBeenCalledTimes(1)
    expect(f.config.plan_locked).toBe(true)
  })
  it('accepts case-insensitive file scopes and existing directory permissions without prescribing decomposition', async () => {
    const f = fixture(['validation/check.json', 'DELIVERY.md'])
    expect((await f.plan.execute({ tasks: [{ id: 'custom', instruction: '自选实现结构', depends_on: [], writes: ['validation/', 'delivery.md'] }] }, f.ctx)).isError).not.toBe(true)
    expect(f.config.tasks).toHaveLength(1)
  })
  it('rejects unsupported glob scopes before locking and lets the planner correct its own plan', async () => {
    const f = fixture([])
    const task = { id: 'core', instruction: '自选模块', depends_on: [], writes: ['core/**', 'ui/*.js'] }
    const rejected = await f.plan.execute({ tasks: [task] }, f.ctx)
    expect(rejected.isError).toBe(true)
    expect(rejected.output).toContain('EXPERIMENT_PLAN_UNSUPPORTED_WRITE_SCOPE')
    expect(f.config.tasks).toEqual([])
    expect(f.config.plan_locked).not.toBe(true)
    expect(f.created).not.toHaveBeenCalled()
    const corrected = { ...task, writes: ['core/', 'ui/'] }
    expect((await f.plan.execute({ tasks: [corrected] }, f.ctx)).isError).not.toBe(true)
    expect(f.config.tasks).toEqual([corrected])
    await f.delegate.execute({ task_ids: ['core'] }, f.ctx)
    expect(f.created).toHaveBeenCalledTimes(1)
    expect(f.config.plan_locked).toBe(true)
  })
  it('binds the requirement list to the frozen condition fingerprint', () => {
    const f = fixture()
    f.config.required_writes.push('new-mandate.json')
    expect(() => writeExperiment(f.config)).toThrow('EXPERIMENT_CONDITION_CHANGED')
  })
  it('binds persistent execution limits to the condition fingerprint and rejects invalid capacities', () => {
    const f = fixture()
    f.config.execution_limits = { script_runs: 12, install_calls: 4 }
    f.config.condition_hash = experimentConditionHash(f.config)
    writeExperiment(f.config)
    f.config.execution_limits.script_runs = 13
    expect(() => writeExperiment(f.config)).toThrow('EXPERIMENT_CONDITION_CHANGED')
    f.config.execution_limits.script_runs = 0
    expect(() => writeExperiment(f.config)).toThrow('EXPERIMENT_INVALID_EXECUTION_LIMITS')
  })
})

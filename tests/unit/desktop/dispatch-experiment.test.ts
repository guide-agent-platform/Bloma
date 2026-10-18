import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXPERIMENT_SWITCH, holdExperimentBeforeImplement, readExperiment, validateExperiment, writeExperiment, experimentPath, type DispatchExperiment } from '../../../main/desktop/dispatch-experiment'
import { freezeExperiment, restoreExperiment } from '../../../main/desktop/dispatch-experiment-snapshot'
import { experimentPhase, wrapExperimentDispatcherTools, wrapExperimentWorkerTools } from '../../../main/desktop/dispatch-experiment-policy'
import { DESKTOP_PHASES } from '../../../main/desktop/dispatcher-phases'
import { runDesktopDispatcherLoop } from '../../../main/desktop/dispatcher-loop'
import type { AgentLoopTool, ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/orchestrator'
import { restorePromaHome } from '../../support/proma-home-guard'
import { reconcileInterruptedProjects } from '../../../main/project/recovery-service'

let temp: string, home: string, root: string, oldSwitch: string | undefined, oldDesktop: string | undefined
const tasks = [
  { id: 'one', instruction: '实现模块一', depends_on: [] as string[], writes: ['one.py'] },
  { id: 'two', instruction: '实现模块二', depends_on: [] as string[], writes: ['two.py'] },
]
function save(path: string, text: string) { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
function config(state: DispatchExperiment['state'] = 'prepared', mode: 'quick' | 'longterm' = 'quick'): DispatchExperiment {
  return { version: 1, project_id: 'p', mode, experiment_id: 'pilot', run_id: 'prepare', state, parent_session_id: 'parent',
    tasks: structuredClone(tasks), workers: {}, prepared: { at: '2026-10-13', requirements_digest: 'frozen PRD' },
    ...(state === 'running' ? { policy: 'single_worker' as const, snapshot_id: 'snapshot', input_hash: 'a'.repeat(64) } : {}) }
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'bloma-dispatch-experiment-')); home = join(temp, 'source'); mkdirSync(home)
  process.env.PROMA_HOME = home; oldSwitch = process.env[EXPERIMENT_SWITCH]; process.env[EXPERIMENT_SWITCH] = '1'
  oldDesktop = process.env.BLOMA_DESKTOP_DISPATCH; process.env.BLOMA_DESKTOP_DISPATCH = '1'
  root = join(home, 'agent-workspaces/default-software-builder/generated-projects/p')
  save(join(home, 'dispatch-experiment-home.json'), '{"version":1}')
  save(join(home, 'projects.json'), JSON.stringify({ projects: [{ project_id: 'p', mode: 'quick', name: 'pilot', workspace_slug: 'default-software-builder', root_path: root, desktop_phase: 'desktop-implement', current_stage: 'generating_mvp', status: 'active' }] }))
  save(join(root, 'one.py'), '# start')
  save(join(root, 'two.py'), '# start')
  save(join(home, 'agent-workspaces/default-software-builder/documents/p/prd.json'), '{"project_id":"p","user_confirmed_at":"2026-10-13","requirements":[],"acceptance":{},"out_of_scope":[],"assumptions":[]}')
  save(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: 'parent', project_id: 'p', jsonl_path: join(home, 'agent-sessions/parent.jsonl'), status: 'completed' }] }))
  save(join(home, 'agent-sessions/parent.jsonl'), JSON.stringify({ role: 'user', content: [{ type: 'text', text: '冻结需求' }] }) + '\n')
  writeExperiment(config())
})
afterEach(() => {
  restorePromaHome(process.env.PROMA_HOME)
  if (oldSwitch === undefined) delete process.env[EXPERIMENT_SWITCH]; else process.env[EXPERIMENT_SWITCH] = oldSwitch
  if (oldDesktop === undefined) delete process.env.BLOMA_DESKTOP_DISPATCH; else process.env.BLOMA_DESKTOP_DISPATCH = oldDesktop
  rmSync(temp, { recursive: true, force: true })
})
describe('pause and isolation', () => {
  it('off does not load even corrupt experiment config', () => {
    delete process.env[EXPERIMENT_SWITCH]; save(experimentPath('p'), 'broken')
    expect(readExperiment('p')).toBeUndefined()
    expect(holdExperimentBeforeImplement({ project_id: 'p', mode: 'quick' }, 'parent', { requirements_digest: '' })).toBe(false)
  })
  it.each(['quick', 'longterm'] as const)('holds %s once and persists its parent, without a model', mode => {
    writeExperiment(config('prepare', mode))
    expect(holdExperimentBeforeImplement({ project_id: 'p', mode }, 'parent', { requirements_digest: 'frozen' })).toBe(true)
    const first = readFileSync(experimentPath('p'), 'utf8')
    expect(holdExperimentBeforeImplement({ project_id: 'p', mode }, 'parent', { requirements_digest: 'other' })).toBe(true)
    expect(readFileSync(experimentPath('p'), 'utf8')).toBe(first)
  })
  it('rejects a mismatched mode and non-isolated home', () => {
    expect(() => holdExperimentBeforeImplement({ project_id: 'p', mode: 'longterm' }, 'parent', { requirements_digest: '' })).toThrow('MODE_MISMATCH')
    rmSync(join(home, 'dispatch-experiment-home.json'))
    expect(() => readExperiment('p')).toThrow('ISOLATED_HOME')
  })
  it('rejects cycles and unsafe write scopes', () => {
    const value = config(); value.tasks[0].depends_on = ['two']; value.tasks[1].depends_on = ['one']
    expect(() => validateExperiment(value)).toThrow('CYCLIC')
    value.tasks[1].depends_on = []; value.tasks[0].writes = ['../escape']
    expect(() => validateExperiment(value)).toThrow('WRITE_PATH')
  })
  it('does not enter the actual Implement loop while only prepared', async () => {
    const query = vi.fn(async function* () { throw new Error('model must not be called') })
    const result = await runDesktopDispatcherLoop({ projectId: 'p', sessionId: 'parent', requestId: 'req', currentPhase: 'desktop-implement', task: '', query,
      env: {}, maxTokens: 1024, signal: new AbortController().signal, publish: () => {}, projectName: 'pilot', quickMode: true, sandboxRoot: root })
    expect(result.error_message).toBe('EXPERIMENT_NOT_READY_FOR_IMPLEMENT'); expect(query).not.toHaveBeenCalled()
  })
})
describe('frozen source and two independent homes', () => {
  it('does not mistake a restored pre-execution pause for an interrupted generation at startup', async () => {
    const snapshot = join(temp, 'startup-snapshot'); freezeExperiment(home, 'p', snapshot, tasks)
    const destination = join(temp, 'startup-arm'); restoreExperiment(snapshot, destination, 'single_worker', 'startup-arm')
    const session = join(destination, 'agent-sessions/parent.jsonl'), before = readFileSync(session, 'utf8')
    process.env.PROMA_HOME = destination
    expect(await reconcileInterruptedProjects()).toEqual([])
    expect(JSON.parse(readFileSync(join(destination, 'projects.json'), 'utf8')).projects[0]).toMatchObject({ current_stage: 'blocked_for_user_decision', desktop_phase: 'desktop-implement' })
    expect(readFileSync(session, 'utf8')).toBe(before)
  })
  it('runs prepare, freeze and restore through the actual Node CLI', () => {
    rmSync(experimentPath('p'))
    const run = (args: string[]) => spawnSync(process.execPath, ['scripts/dispatch-experiment.mjs', ...args], { encoding: 'utf8', windowsHide: true })
    expect(run(['prepare', '--home', home, '--project', 'p', '--experiment', 'cli', '--planning', 'fixed']).status).toBe(0)
    holdExperimentBeforeImplement({ project_id: 'p', mode: 'quick' }, 'parent', { requirements_digest: 'frozen' })
    const taskFile = join(temp, 'tasks.json'); save(taskFile, JSON.stringify(tasks))
    const snapshot = join(temp, 'cli-snapshot')
    const frozen = run(['freeze', '--home', home, '--project', 'p', '--tasks', taskFile, '--out', snapshot])
    expect(frozen.status, frozen.stderr).toBe(0)
    const restored = run(['restore', '--snapshot', snapshot, '--home', join(temp, 'cli-a'), '--policy', 'single_worker', '--run', 'a1'])
    expect(restored.status, restored.stderr).toBe(0)
    expect(JSON.parse(restored.stdout).input_hash).toBe(JSON.parse(frozen.stdout).input_hash)
  })
  it('preserves input bytes/material IDs and isolates roots, histories, credentials and usage', () => {
    save(join(home, 'bloma-channels.json'), 'secret'); save(join(home, 'usage-ledger/p.jsonl'), 'old cost')
    save(join(home, 'bloma-composer/attachments/material.json'), '{"project_id":"p","session_id":"parent","text":"材料"}')
    save(join(root, '.venv/pyvenv.cfg'), 'absolute source path')
    const snapshot = join(temp, 'snapshot'), manifest = freezeExperiment(home, 'p', snapshot, tasks)
    const source = readFileSync(join(home, 'projects.json'), 'utf8')
    const a = restoreExperiment(snapshot, join(temp, 'a'), 'single_worker', 'a1')
    const b = restoreExperiment(snapshot, join(temp, 'b'), 'parallel_workers', 'b1')
    expect(a.input_hash).toBe(b.input_hash); expect(a.input_hash).toBe(manifest.input_hash)
    expect(readFileSync(join(home, 'projects.json'), 'utf8')).toBe(source)
    for (const arm of ['a', 'b']) {
      expect(existsSync(join(temp, arm, 'bloma-channels.json'))).toBe(false)
      expect(existsSync(join(temp, arm, 'usage-ledger/p.jsonl'))).toBe(false)
      expect(existsSync(join(temp, arm, 'bloma-composer/attachments/material.json'))).toBe(true)
      expect(existsSync(join(temp, arm, 'agent-workspaces/default-software-builder/generated-projects/p/.venv'))).toBe(false)
      expect(JSON.parse(readFileSync(join(temp, arm, 'projects.json'), 'utf8')).projects[0].root_path).toContain(join(temp, arm))
    }
    save(join(temp, 'a/agent-sessions/parent.jsonl'), 'changed A')
    expect(readFileSync(join(temp, 'b/agent-sessions/parent.jsonl'), 'utf8')).toContain('冻结需求')
  })
  it('rejects tampered snapshot bytes before creating the target', () => {
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, tasks)
    save(join(snapshot, 'home/agent-sessions/parent.jsonl'), 'tampered')
    expect(() => restoreExperiment(snapshot, join(temp, 'a'), 'single_worker', 'a1')).toThrow('SNAPSHOT_CHANGED')
    expect(existsSync(join(temp, 'a'))).toBe(false)
  })
  it('rejects mutated task/worker metadata and linked product files', () => {
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, tasks)
    const manifest = JSON.parse(readFileSync(join(snapshot, 'manifest.json'), 'utf8'))
    manifest.config.tasks[0].instruction = 'changed task'; save(join(snapshot, 'manifest.json'), JSON.stringify(manifest))
    expect(() => restoreExperiment(snapshot, join(temp, 'a'), 'single_worker', 'a1')).toThrow('SNAPSHOT_CHANGED')
    const linked = join(temp, 'linked'); mkdirSync(linked); save(join(linked, 'data.txt'), 'not in product')
    symlinkSync(linked, join(root, 'link'), 'junction')
    expect(() => freezeExperiment(home, 'p', join(temp, 'linked-snapshot'), tasks)).toThrow('LINK_NOT_PORTABLE')
  })
  it('rejects overwrite and snapshots nested inside their source', () => {
    expect(() => freezeExperiment(home, 'p', join(home, 'snapshot'), tasks)).toThrow('TARGET_NOT_FRESH')
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, tasks)
    expect(() => restoreExperiment(snapshot, home, 'single_worker', 'a1')).toThrow('TARGET_NOT_FRESH')
  })
  it('requires longterm scaffold provenance, then preserves a completed seed for both arms', () => {
    const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')); index.projects[0].mode = 'longterm'; save(join(home, 'projects.json'), JSON.stringify(index))
    writeExperiment(config('prepared', 'longterm'))
    expect(() => freezeExperiment(home, 'p', join(temp, 'bad'), tasks)).toThrow('HANDOFF_REQUIRED')
    const sessions = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
    sessions.sessions.push({ session_id: 'seed-session', project_id: 'p', parent_session_id: 'parent', source_delegation_id: 'seed', jsonl_path: join(home, 'agent-sessions/seed-session.jsonl') })
    save(join(home, 'bloma-agent-sessions.json'), JSON.stringify(sessions))
    save(join(home, 'agent-sessions/seed-session.jsonl'), JSON.stringify({ delegation_settle: 'completed', loop_status: 'completed', task_handoff: { schema_version: 1, completion: 'unverified', loop_status: 'completed', changed_files: [], verification: [], pending: [] } }) + '\n')
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, tasks, 'seed')
    expect(restoreExperiment(snapshot, join(temp, 'a'), 'single_worker', 'a1').workers.all.task_ids).toEqual(['one', 'two'])
    expect(restoreExperiment(snapshot, join(temp, 'b'), 'parallel_workers', 'b1').workers.one.task_ids).toEqual(['one'])
  })
})
describe('host tool boundaries', () => {
  const ctx = () => ({ projectId: 'p', sessionId: 'parent', requestId: 'req', signal: new AbortController().signal, state: { delegation_depth: 0 } }) as ToolContext
  it('rejects cross-model/role and unassigned tasks before tool execution', async () => {
    const value = config('running'); writeExperiment(value)
    const execute = vi.fn(async () => ({ output: 'should not execute' }))
    const tool = wrapExperimentDispatcherTools([{ name: 'delegate_agent', description: '', input_schema: {}, execute }], value)[0]
    for (const input of [{ task_id: 'one' }, { task_id: 'all', channelId: 'other' }, { task_id: 'all', role: 'research' }]) expect((await tool.execute(input, ctx())).isError).toBe(true)
    expect(execute).not.toHaveBeenCalled()
  })
  it('blocks dependent task before its predecessor even starts', async () => {
    const value = config('running'); value.policy = 'parallel_workers'; value.tasks[1].depends_on = ['one']; writeExperiment(value)
    const execute = vi.fn(async () => ({ output: '' }))
    const tool = wrapExperimentDispatcherTools([{ name: 'delegate_agent', description: '', input_schema: {}, execute }], value)[0]
    expect((await tool.execute({ task_id: 'two' }, ctx())).output).toBe('EXPERIMENT_DEPENDENCY_WAIT'); expect(execute).not.toHaveBeenCalled()
  })
  it('guards direct writes including directory scopes and traversal', async () => {
    const value = config('running'); value.workers.all = { delegation_id: 'd', child_session_id: 'child', task_ids: ['one'] }; writeExperiment(value)
    const execute = vi.fn(async () => ({ output: 'ok' }))
    const tool = wrapExperimentWorkerTools([{ name: 'write_file', description: '', input_schema: {}, execute }], value, root)[0]
    const child = { ...ctx(), sessionId: 'child' }
    expect((await tool.execute({ path: 'one.py' }, child)).isError).toBeUndefined()
    const refused = await tool.execute({ path: 'two.py' }, child)
    expect(refused.isError).toBe(true)
    expect(refused.output).toContain('two.py')
    expect(refused.output).toContain('one.py')
    expect(refused.output).toContain('已有授权文件')
    expect(refused.feedback).toMatchObject({ execution: 'not_run', category: 'permission', recovery: 'correct_input' })
    expect((await tool.execute({ path: '../escape.py' }, child)).isError).toBe(true)
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('removes contradictory single-worker prompt guidance only for the experimental phase', () => {
    const value = config('running'); value.policy = 'parallel_workers'
    const adapted = experimentPhase(DESKTOP_PHASES['desktop-implement'], value)
    expect(adapted.quickTaskTemplate).not.toContain('一次性委派 implement 子会话完成实现')
    expect(adapted.taskTemplate).toContain('最多两名实现者')
    expect(DESKTOP_PHASES['desktop-implement'].quickTaskTemplate).toContain('一次性委派 implement 子会话完成实现')
  })
})

describe('actual dispatcher + actual child tools, zero model/network', () => {
  it('a parent advance without executing frozen tasks cannot pass the experiment', async () => {
    writeExperiment(config('running'))
    const query: SDKQuery = async function* () {
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PHASE_ADVANCE: desktop-verify' }] } }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    const result = await runDesktopDispatcherLoop({ projectId: 'p', sessionId: 'parent', requestId: 'req', currentPhase: 'desktop-implement', task: '', query,
      env: {}, maxTokens: 1024, signal: new AbortController().signal, publish: () => {}, projectName: 'pilot', quickMode: true, sandboxRoot: root })
    expect(result.status).toBe('error')
    expect(result.loopResult?.status).toBe('turn_limit') // Repeated premature end responses cannot bypass the prerequisite.
  })
  it('longterm replays scaffold history into the same worker rather than creating a replacement', async () => {
    const index = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')); index.projects[0].mode = 'longterm'; save(join(home, 'projects.json'), JSON.stringify(index))
    const sessions = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
    sessions.sessions.push({ session_id: 'seed-session', project_id: 'p', parent_session_id: 'parent', source_delegation_id: 'seed-live', jsonl_path: join(home, 'agent-sessions/seed-session.jsonl') })
    save(join(home, 'bloma-agent-sessions.json'), JSON.stringify(sessions))
    save(join(home, 'agent-sessions/seed-session.jsonl'), [
      { role: 'user', content: [{ type: 'text', text: '骨架阶段历史事实' }] },
      { role: 'assistant', content: [{ type: 'text', text: '骨架已准备，业务尚未实现。' }] },
      { delegation_settle: 'completed', loop_status: 'completed', task_handoff: { schema_version: 1, completion: 'unverified', loop_status: 'completed', changed_files: [], verification: [], pending: [] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    const value = config('running', 'longterm'); value.workers.all = { delegation_id: 'seed-live', child_session_id: 'seed-session', task_ids: ['one', 'two'] }; writeExperiment(value)
    let parentCalls = 0, childCalls = 0, history = ''
    const query: SDKQuery = async function* (_prompt, options) {
      let name = '', input: Record<string, unknown> = {}
      if (options.sessionId === 'parent') {
        parentCalls++
        if (parentCalls === 1) { name = 'delegate_agent'; input = { task_id: 'all' } }
        else if (parentCalls === 2) { name = 'wait_for_delegations'; input = { timeout_ms: 2000 } }
      } else {
        childCalls++; history ||= JSON.stringify(options.messages)
      }
      if (name) yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `${name}-${parentCalls}`, name, input }] } }
      else yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '本段结束，未声明交付通过。' }] } }
      yield { type: 'result', subtype: 'success', stop_reason: name ? 'tool_use' : 'end_turn' }
    }
    await runDesktopDispatcherLoop({ projectId: 'p', sessionId: 'parent', requestId: 'req', currentPhase: 'desktop-implement', task: '', query,
      env: {}, maxTokens: 1024, maxTurns: 6, signal: new AbortController().signal, publish: () => {}, projectName: 'pilot', sandboxRoot: root })
    expect(childCalls).toBeGreaterThan(0); expect(history).toContain('骨架阶段历史事实')
    expect(readExperiment('p')!.workers.all.child_session_id).toBe('seed-session')
    expect(Object.keys(readExperiment('p')!.workers)).toHaveLength(1)
  })
  it.each(['single_worker', 'parallel_workers'] as const)('%s creates its actual workers and executes owned writes', async policy => {
    const value = config('running'); value.policy = policy; writeExperiment(value)
    const calls = new Map<string, number>(), childIds = new Set<string>()
    const query: SDKQuery = async function* (_prompt, options) {
      const count = (calls.get(options.sessionId) ?? 0) + 1; calls.set(options.sessionId, count)
      const tool = (name: string, input: Record<string, unknown>, id: string) => ({ type: 'assistant' as const,
        message: { role: 'assistant' as const, content: [{ type: 'tool_use' as const, id, name, input }] } })
      if (options.sessionId === 'parent') {
        if (count === 1) yield tool('delegate_agent', { task_id: policy === 'single_worker' ? 'all' : 'one' }, 'create-one')
        else if (count === 2 && policy === 'parallel_workers') yield tool('delegate_agent', { task_id: 'two' }, 'create-two')
        else if (count <= (policy === 'single_worker' ? 2 : 3)) yield tool('wait_for_delegations', { timeout_ms: 2000 }, 'wait')
        else yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '执行完成，交付仍需验收。' }] } }
      } else {
        childIds.add(options.sessionId)
        const registered = Object.values(readExperiment('p')!.workers).find(worker => worker.child_session_id === options.sessionId)!
        if (count === 1) for (const id of registered.task_ids) yield tool('read_file', { path: `${id}.py` }, `read-${id}`)
        else if (count === 2) for (const id of registered.task_ids) yield tool('write_file', { path: `${id}.py`, content: '# implemented' }, `write-${id}`)
        else yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已实现，未验收。' }] } }
      }
      yield { type: 'result', subtype: 'success', stop_reason: count === 1 ? 'tool_use' : 'end_turn' }
    }
    await runDesktopDispatcherLoop({ projectId: 'p', sessionId: 'parent', requestId: 'req', currentPhase: 'desktop-implement', task: '按冻结任务开工', query,
      env: {}, maxTokens: 1024, maxTurns: 8, signal: new AbortController().signal, publish: () => {}, projectName: 'pilot', quickMode: true, sandboxRoot: root })
    expect(childIds.size).toBe(policy === 'single_worker' ? 1 : 2)
    expect(readFileSync(join(root, 'one.py'), 'utf8')).toBe('# implemented')
    expect(readFileSync(join(root, 'two.py'), 'utf8')).toBe('# implemented')
    expect(Object.keys(readExperiment('p')!.workers)).toHaveLength(policy === 'single_worker' ? 1 : 2)
  })
})

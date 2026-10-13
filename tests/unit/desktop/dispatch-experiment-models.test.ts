import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, SDKMessage } from '../../../shared/types'
import type { SDKQuery } from '../../../main/orchestration/orchestrator'
import { getChannelByIdRaw, listChannels } from '../../../main/platform/llm/channel-manager'
import { DEFAULT_EXPERIMENT_LIMITS, EXPERIMENT_SWITCH, experimentConditionHash, experimentPath, readExperiment, recordExperiment, recordExperimentBoundary, writeExperiment, type DispatchExperiment, type ExperimentModels } from '../../../main/desktop/dispatch-experiment'
import { freezeExperiment } from '../../../main/desktop/dispatch-experiment-snapshot'
import { createModelMatrix } from '../../../main/desktop/dispatch-experiment-matrix'
import { guardExperimentQuery, lockExperimentModel, resolveExperimentModel } from '../../../main/desktop/dispatch-experiment-models'
import { runDesktopDispatcherLoop } from '../../../main/desktop/dispatcher-loop'
import { withAbort } from '../../../main/agent/loop/agent-loop'
import { reportModelExperiment } from '../../../main/desktop/dispatch-experiment-report'
import { spawnSync } from 'node:child_process'
import { restorePromaHome } from '../../support/proma-home-guard'
import { evaluateExperiment, installExperimentEvaluator } from '../../../main/desktop/dispatch-experiment-evaluator'
import { finishExperiment, readExperimentEvents } from '../../../main/desktop/dispatch-experiment-records'
import { aggregateModelExperiments } from '../../../main/desktop/dispatch-experiment-aggregate'

vi.mock('../../../main/platform/llm/channel-manager', async original => ({
  ...await original<typeof import('../../../main/platform/llm/channel-manager')>(),
  getChannelByIdRaw: vi.fn(), listChannels: vi.fn(), decryptApiKey: vi.fn(() => 'secret-canary'),
}))
const bindings = { one: { channel_id: 'c1', model_id: 'm1' }, two: { channel_id: 'c2', model_id: 'm2' }, verifier: { channel_id: 'cv', model_id: 'mv' } }
const profiles: ExperimentModels = { dispatcher: bindings.one, executor: bindings.two, verifier: bindings.verifier }
const task = (id: string) => ({ id, instruction: `完成模块 ${id}，保持已确认需求`, depends_on: [] as string[], writes: [`${id}.py`] })
let temp: string, home: string, root: string, switchBefore: string | undefined, desktopBefore: string | undefined
const save = (path: string, text: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, text) }
const channel = (id: string, modelId: string): Channel => ({ id, name: id, enabled: true, provider_type: 'zhipu', api_key: 'encrypted',
  base_url: `https://${id}.example/v1`, max_tokens: 2048, models: [{ id: modelId, name: modelId, enabled: true, supports_tools: true }] })
function running(policy: 'autonomous' | 'standalone' = 'autonomous'): DispatchExperiment {
  const config: DispatchExperiment = { version: 1, project_id: 'p', mode: 'quick', experiment_id: 'models', run_id: 'run1', state: 'running',
    planning: 'autonomous', policy, snapshot_id: 's', input_hash: 'a'.repeat(64), parent_session_id: 'parent', tasks: [], workers: {},
    models: structuredClone(profiles), limits: { ...DEFAULT_EXPERIMENT_LIMITS } }
  config.condition_hash = experimentConditionHash(config)
  return config
}
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'bloma-model-experiment-')); home = join(temp, 'home'); mkdirSync(home)
  process.env.PROMA_HOME = home; switchBefore = process.env[EXPERIMENT_SWITCH]; process.env[EXPERIMENT_SWITCH] = '1'
  desktopBefore = process.env.BLOMA_DESKTOP_DISPATCH; process.env.BLOMA_DESKTOP_DISPATCH = '1'
  root = join(home, 'agent-workspaces/default-software-builder/generated-projects/p')
  save(join(home, 'dispatch-experiment-home.json'), '{"version":1}')
  save(join(home, 'projects.json'), JSON.stringify({ projects: [{ project_id: 'p', workspace_slug: 'default-software-builder', mode: 'quick', name: 'models', root_path: root, desktop_phase: 'desktop-implement' }] }))
  save(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: 'parent', project_id: 'p', jsonl_path: join(home, 'agent-sessions/parent.jsonl'), status: 'completed' }] }))
  save(join(home, 'agent-sessions/parent.jsonl'), JSON.stringify({ role: 'user', content: [{ type: 'text', text: '冻结业务需求' }] }) + '\n')
  save(join(root, 'placeholder.py'), '# baseline')
  save(join(home, 'agent-workspaces/default-software-builder/documents/p/prd.json'), '{"project_id":"p","requirements":[],"acceptance":{},"out_of_scope":[],"assumptions":[]}')
  vi.mocked(getChannelByIdRaw).mockImplementation(id => ({ c1: channel('c1', 'm1'), c2: channel('c2', 'm2'), cv: channel('cv', 'mv') })[id])
  vi.mocked(listChannels).mockReturnValue([])
  writeExperiment(running())
})
afterEach(() => {
  restorePromaHome(process.env.PROMA_HOME)
  if (switchBefore === undefined) delete process.env[EXPERIMENT_SWITCH]; else process.env[EXPERIMENT_SWITCH] = switchBefore
  if (desktopBefore === undefined) delete process.env.BLOMA_DESKTOP_DISPATCH; else process.env.BLOMA_DESKTOP_DISPATCH = desktopBefore
  rmSync(temp, { recursive: true, force: true }); vi.clearAllMocks()
})
const toolMessage = (id: string, name: string, input: Record<string, unknown>): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const text = (): SDKMessage => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '本段结束，验收仍需宿主执行。' }] } })
const run = (query: SDKQuery, extra: Record<string, unknown> = {}) => runDesktopDispatcherLoop({ projectId: 'p', sessionId: 'parent', requestId: 'req', currentPhase: 'desktop-implement', task: '继续',
  query, env: {}, maxTokens: 2048, maxTurns: 16, signal: new AbortController().signal, publish: () => {}, projectName: 'models', quickMode: true, sandboxRoot: root, ...extra })

function suite(manual = false) {
  const directory = join(temp, 'suite')
  save(join(directory, 'suite.json'), JSON.stringify({ version: 1, checks: [
    { id: 'behavior', description: 'Frozen external behavioral assertion', kind: 'command', command: process.execPath, args: ['{suite}/check.cjs', '{product}'], timeout_ms: 2000 },
    ...(manual ? [{ id: 'gui', kind: 'manual', description: 'Independent GUI evidence' }] : []),
  ] }))
  save(join(directory, 'check.cjs'), "const fs = require('node:fs'); const path = require('node:path'); process.exit(fs.readFileSync(path.join(process.argv[2], 'result.txt'), 'utf8') === 'pass' ? 0 : 1)")
  return directory
}
function sealed(manual = false) {
  const config = running(); config.started_at = new Date(Date.now() - 2000).toISOString()
  config.evaluator_hash = installExperimentEvaluator(suite(manual), home); config.condition_hash = experimentConditionHash(config); writeExperiment(config)
  save(join(root, 'result.txt'), 'pass'); return config
}

describe('research data collection', () => {
  it.each(['MONETARY_BUDGET_EXHAUSTED', 'EMPTY_MODEL_STREAM', 'PROVIDER_JSON_RESPONSE'])('keeps the exact infrastructure termination code %s', async code => {
    running()
    const query: SDKQuery = async function* () { throw new Error(`${code}: diagnostic detail`) }
    await expect(run(query)).resolves.toMatchObject({ status: 'error' })
    expect(reportModelExperiment('p')).toMatchObject({ run_outcome: 'failed', termination_reason: code })
    expect(readExperimentEvents(readExperiment('p')!).events.find(event => event.event === 'experiment_stage_finished')).toMatchObject({ error_code: code })
  })
  it('records a bounded deadline failure and refuses reuse of the same terminal run', async () => {
    const config = running(); config.started_at = '2000-01-01T00:00:00Z'; writeExperiment(config)
    const query = vi.fn(async function* () { yield text() })
    await expect(run(query)).resolves.toMatchObject({ status: 'error' })
    expect(reportModelExperiment('p')).toMatchObject({ run_outcome: 'timeout', termination_reason: 'EXPERIMENT_WALL_BUDGET_EXHAUSTED' })
    expect(reportModelExperiment('p').machine_ms).toBeGreaterThan(0)
    await expect(run(query)).resolves.toMatchObject({ error_message: 'EXPERIMENT_ALREADY_FINISHED_RESTORE_FRESH_RUN' })
    expect(query).not.toHaveBeenCalled()
    expect(readExperimentEvents(config).events.filter(event => event.event === 'run_finished')).toHaveLength(1)
  })
  it('scores a failed product independently of native delivery, without erasing the failure', () => {
    const config = sealed(); save(join(root, 'result.txt'), 'fail'); finishExperiment(config, 'failed', 'turn_limit')
    expect(evaluateExperiment('p')).toMatchObject({ complete: true, score: 0, success: false })
    expect(reportModelExperiment('p')).toMatchObject({ product_quality: 0, product_success: false, run_outcome: 'failed' })
    expect(reportModelExperiment('p').machine_ms).toBeGreaterThan(0)
    expect(() => evaluateExperiment('p')).toThrow('ALREADY_EVALUATED')
  })
  it('keeps manual checks pending, binds evidence bytes and forbids result replacement', () => {
    const config = sealed(true); finishExperiment(config, 'ready', 'mvp_ready')
    expect(evaluateExperiment('p')).toMatchObject({ complete: false, score: null })
    expect(reportModelExperiment('p').product_quality).toBeNull()
    const evidence = join(temp, 'gui.txt'); save(evidence, 'independent GUI result')
    const completed = evaluateExperiment('p', [{ id: 'gui', passed: true, evidence }])
    expect(completed).toMatchObject({ complete: true, score: 1, success: true })
    expect(completed.checks[1].evidence_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(() => evaluateExperiment('p', [{ id: 'gui', passed: false, evidence }])).toThrow('ALREADY_EVALUATED')
  })
  it('rejects a modified frozen evaluator before invoking the model or scorer', async () => {
    const config = sealed(); save(join(home, 'dispatch-experiments/evaluator/check.cjs'), 'process.exit(0)')
    const query = vi.fn(async function* () { yield text() })
    await expect(run(query)).resolves.toMatchObject({ error_message: 'EXPERIMENT_EVALUATOR_CHANGED' })
    expect(query).not.toHaveBeenCalled()
    expect(() => evaluateExperiment('p')).toThrow('EVALUATOR_CHANGED')
    expect(readExperimentEvents(config).events.some(event => event.event === 'run_finished')).toBe(true)
  })
  it('requires finalization and rejects modifying the product between automatic and manual grading', () => {
    const config = sealed(true)
    expect(() => evaluateExperiment('p')).toThrow('MUST_BE_FINISHED')
    finishExperiment(config, 'ready', 'mvp_ready'); evaluateExperiment('p')
    save(join(root, 'result.txt'), 'modified'); const evidence = join(temp, 'evidence'); save(evidence, 'GUI')
    expect(() => evaluateExperiment('p', [{ id: 'gui', passed: true, evidence }])).toThrow('PRODUCT_CHANGED_AFTER')
  })
  it('invalidates an exported quality score when stored evidence has changed', () => {
    const config = sealed(); finishExperiment(config, 'ready', 'delivered')
    const evaluation = evaluateExperiment('p'); expect(reportModelExperiment('p').product_quality).toBe(1)
    save(evaluation.checks[0].evidence!, 'modified evidence')
    expect(reportModelExperiment('p')).toMatchObject({ product_quality: null, evaluation_evidence_valid: false })
  })
  it('rejects an external grader that modifies the product being scored', () => {
    const config = sealed()
    const checker = join(home, 'dispatch-experiments/evaluator/check.cjs')
    save(checker, "require('node:fs').writeFileSync(require('node:path').join(process.argv[2], 'result.txt'), 'changed')")
    // Seal the intentionally invalid grader before this simulated run begins.
    const other = join(temp, 'mutating-suite'); save(join(other, 'suite.json'), readFileSync(join(home, 'dispatch-experiments/evaluator/suite.json'), 'utf8'))
    save(join(other, 'check.cjs'), readFileSync(checker, 'utf8'))
    const fresh = join(temp, 'fresh-suite-home'); mkdirSync(fresh)
    config.evaluator_hash = installExperimentEvaluator(other, fresh)
    config.condition_hash = experimentConditionHash(config); writeExperiment(config)
    finishExperiment(config, 'ready', 'delivered')
    expect(() => evaluateExperiment('p')).toThrow('PRODUCT_CHANGED_DURING_EVALUATION')
    expect(reportModelExperiment('p').product_quality).toBeNull()
  })
  it('keeps harness failures unknown rather than reporting model failure or zero quality', () => {
    const directory = join(temp, 'bad-suite')
    save(join(directory, 'suite.json'), JSON.stringify({ version: 1, checks: [{ id: 'bad', kind: 'command', description: 'Missing grader executable',
      command: join(temp, 'missing-executable'), args: [], timeout_ms: 1000 }] }))
    const config = running(); config.evaluator_hash = installExperimentEvaluator(directory, home); config.condition_hash = experimentConditionHash(config); writeExperiment(config)
    finishExperiment(config, 'ready', 'delivered')
    expect(evaluateExperiment('p')).toMatchObject({ complete: false, score: null, checks: [{ status: 'error' }] })
  })
  it('records the native readiness boundary as a terminal receipt, keeping quality separate', () => {
    const config = sealed(); recordExperimentBoundary('p', 'mvp_ready')
    expect(reportModelExperiment('p')).toMatchObject({ run_outcome: 'ready', product_quality: null, native_outcome: 'mvp_ready' })
    recordExperimentBoundary('p', 'delivered')
    expect(readExperimentEvents(config).events.filter(event => event.event === 'run_finished')).toHaveLength(1)
  })
  it('collects six real external grader executions and computes paired D, R and G including failures', () => {
    const source = running(); source.state = 'prepared'; source.policy = undefined; source.models = undefined; source.condition_hash = undefined
    source.prepared = { at: '2026-10-13', requirements_digest: 'frozen' }; writeExperiment(source)
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, [])
    const destination = join(temp, 'matrix'), evaluator = suite()
    const matrix = createModelMatrix(snapshot, destination, { m1: bindings.one, m2: bindings.two, verifier: bindings.verifier }, 'collected', 1,
      { task_id: 'T1', repeat_id: 'r1', evaluator })
    expect(new Set(matrix.map(row => row.evaluator_hash)).size).toBe(1)
    const matrixPath = join(destination, 'matrix.json')
    expect(aggregateModelExperiments([matrixPath]).pending_pairs).toHaveLength(1)
    for (const row of matrix) {
      process.env.PROMA_HOME = row.home; const config = readExperiment('p')!
      config.started_at = new Date(Date.now() - 1000).toISOString(); writeExperiment(config)
      const product = JSON.parse(readFileSync(join(row.home, 'projects.json'), 'utf8')).projects[0].root_path
      const passed = ['G12', 'G21', 'G22', 'S2'].includes(row.group)
      save(join(product, 'result.txt'), passed ? 'pass' : 'fail')
      finishExperiment(config, passed ? 'ready' : 'failed', passed ? 'delivered' : 'turn_limit'); evaluateExperiment('p')
    }
    const report = aggregateModelExperiments([matrixPath]); expect(report.rows).toHaveLength(6); expect(report.pending_pairs).toEqual([])
    expect(report.strata[0]).toMatchObject({ matched_pairs: 1, capability_gap_signed: -1, gain_G12_vs_G11: 1,
      gain_G12_vs_best_homogeneous: 0, rescue_S2_given_S1_failed: { denominator: 1, value: 1 }, rescue_S1_given_S2_failed: { denominator: 0, value: null } })
    const list = join(temp, 'matrices.json'); save(list, JSON.stringify([matrixPath]))
    const csv = join(temp, 'rows.csv')
    const cli = spawnSync(process.execPath, ['scripts/dispatch-experiment.mjs', 'aggregate', '--home', destination, '--matrices', list, '--csv', csv], { encoding: 'utf8', windowsHide: true })
    expect(cli.status, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).strata[0].matched_pairs).toBe(1)
    expect(readFileSync(csv, 'utf8').split('\r\n')).toHaveLength(8)
    expect(() => aggregateModelExperiments([matrixPath, matrixPath])).toThrow('MATRIX_RECEIPT_MISMATCH')
    const edited = readExperiment('p')!; edited.limits!.max_workers = 2; edited.condition_hash = experimentConditionHash(edited); writeExperiment(edited)
    matrix[5].condition_hash = edited.condition_hash; save(matrixPath, JSON.stringify(matrix))
    expect(() => aggregateModelExperiments([matrixPath])).toThrow('PAIR_CONDITIONS_MISMATCH')
  })
})

describe('pinned roles and experiment conditions', () => {
  it('rejects wrong routing before invoking the SDK and never stores credentials', async () => {
    const config = readExperiment('p')!, query = vi.fn(async function* () { yield text() })
    const guarded = guardExperimentQuery(query, config, 'implement')
    await expect(async () => { for await (const _ of guarded('', { sessionId: 'parent', signal: new AbortController().signal, env: { ANTHROPIC_MODEL: 'wrong' } })) {} }).rejects.toThrow('MODEL_MISMATCH')
    expect(query).not.toHaveBeenCalled()
    expect(readFileSync(experimentPath('p'), 'utf8')).not.toContain('secret-canary')
  })
  it('rejects binding edits after condition sealing and catalogue drift after first resolution', () => {
    const config = readExperiment('p')!; config.models!.executor = bindings.one
    expect(() => writeExperiment(config)).toThrow('CONDITION_CHANGED')
    const original = readExperiment('p')!; lockExperimentModel(original, 'dispatcher')
    vi.mocked(getChannelByIdRaw).mockImplementation(id => id === 'c1' ? { ...channel('c1', 'm1'), base_url: 'https://c1.example/v2' } : undefined)
    expect(() => lockExperimentModel(original, 'dispatcher')).toThrow('CATALOG_CHANGED')
  })
  it('bounds logical requests and honours an expired run deadline', async () => {
    const config = running(); config.limits!.max_requests = 1; config.condition_hash = experimentConditionHash(config); writeExperiment(config)
    const binding = resolveExperimentModel(config.models!.dispatcher)
    const options = { sessionId: 'parent', signal: new AbortController().signal, env: binding.env }
    const query = guardExperimentQuery(async function* () { yield text() }, config, 'implement')
    for await (const _ of query('', options)) {}
    await expect(async () => { for await (const _ of query('', options)) {} }).rejects.toThrow('REQUEST_BUDGET')
    const expired = running(); expired.started_at = '2000-01-01T00:00:00Z'; writeExperiment(expired)
    await expect(run(async function* () { yield text() })).resolves.toMatchObject({ status: 'error', error_message: 'EXPERIMENT_WALL_BUDGET_EXHAUSTED' })
  })
  it('applies shared sampling and output limits at the SDK boundary and keeps experiment accounting', async () => {
    const config = running(); config.limits!.max_output_tokens = 1024; config.condition_hash = experimentConditionHash(config); writeExperiment(config)
    const binding = resolveExperimentModel(config.models!.executor)
    const base: SDKQuery = async function* (_prompt, options) {
      expect(options.env.ANTHROPIC_MODEL).toBe('m2'); expect(options.maxTokens).toBe(1024)
      expect(options.temperature).toBe(0.1); expect(options.thinkingLevel).toBe('low')
      expect(options.accounting).toMatchObject({ runId: 'run1', role: 'experiment_executor' }); yield text()
    }
    const guarded = guardExperimentQuery(base, config, 'implement')
    for await (const _ of guarded('', { sessionId: 'child', signal: new AbortController().signal, env: binding.env, maxTokens: 99999, temperature: 1.5,
      accounting: { projectId: 'p', role: 'implement', runId: 'native-request' } })) {}
    const report = reportModelExperiment('p'); expect(report.model_requests_by_role.executor.requests).toBe(1)
  })
  it('generates four model combinations and two genuine standalone controls from one input snapshot', () => {
    const source = running(); source.state = 'prepared'; source.policy = undefined; source.models = undefined; source.condition_hash = undefined
    source.prepared = { at: '2026-10-13', requirements_digest: 'frozen' }; writeExperiment(source)
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, [])
    const matrix = createModelMatrix(snapshot, join(temp, 'matrix'), { m1: bindings.one, m2: bindings.two, verifier: bindings.verifier }, 'trial')
    expect(matrix.map(item => item.group)).toEqual(['G11', 'G12', 'G21', 'G22', 'S1', 'S2'])
    expect(new Set(matrix.map(item => item.input_hash)).size).toBe(1)
    expect(new Set(matrix.map(item => item.condition_hash)).size).toBe(6)
    expect(matrix.every(item => item.models!.verifier.model_id === 'mv')).toBe(true)
    expect(matrix.filter(item => item.policy === 'standalone')).toHaveLength(2)
  })
  it('creates the model matrix through the actual CLI, without reading keys or invoking models', () => {
    const source = running(); source.state = 'prepared'; source.policy = undefined; source.models = undefined; source.condition_hash = undefined
    source.prepared = { at: '2026-10-13', requirements_digest: 'frozen' }; writeExperiment(source)
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, [])
    const pairFile = join(temp, 'pair.json'); save(pairFile, JSON.stringify({ m1: bindings.one, m2: bindings.two, verifier: bindings.verifier }))
    const result = spawnSync(process.execPath, ['scripts/dispatch-experiment.mjs', 'matrix', '--home', join(temp, 'matrix'), '--snapshot', snapshot,
      '--models', pairFile, '--run-prefix', 'cli', '--worker-limit', '2'], { encoding: 'utf8', windowsHide: true })
    expect(result.status, result.stderr).toBe(0); expect(JSON.parse(result.stdout)).toHaveLength(6)
  })
  it('refuses changed frozen requirements before querying a model', () => {
    const source = running(); source.state = 'prepared'; source.policy = undefined; source.models = undefined; source.condition_hash = undefined
    source.prepared = { at: '2026-10-13', requirements_digest: 'frozen' }; writeExperiment(source)
    const snapshot = join(temp, 'snapshot'); freezeExperiment(home, 'p', snapshot, [])
    const matrix = createModelMatrix(snapshot, join(temp, 'matrix'), { m1: bindings.one, m2: bindings.two, verifier: bindings.verifier }, 'inputcheck')
    process.env.PROMA_HOME = matrix[0].home
    save(join(matrix[0].home, 'agent-workspaces/default-software-builder/documents/p/prd.json'), '{"tampered":true}')
    const query = vi.fn(async function* () { yield text() })
    return expect(run(query, { sandboxRoot: join(matrix[0].home, 'agent-workspaces/default-software-builder/generated-projects/p') }))
      .resolves.toMatchObject({ status: 'error', error_message: 'EXPERIMENT_FROZEN_INPUT_CHANGED' }).then(() => { expect(query).not.toHaveBeenCalled() })
  })
})

describe('actual loop routing with fake SDK responses', () => {
  it.each([
    ['G11', bindings.one, bindings.one, 'm1', 'm1'], ['G12', bindings.one, bindings.two, 'm1', 'm2'],
    ['G21', bindings.two, bindings.one, 'm2', 'm1'], ['G22', bindings.two, bindings.two, 'm2', 'm2'],
  ] as const)('%s uses its dispatcher for a self-authored three-task plan and its pinned executor', async (_group, dispatcher, executor, dispatcherModel, executorModel) => {
    const initial = running(); initial.models!.dispatcher = dispatcher; initial.models!.executor = executor; initial.condition_hash = experimentConditionHash(initial); writeExperiment(initial)
    const models: Array<{ role?: string; model: string }> = [], counts = new Map<string, number>()
    const tasks = [task('alpha'), task('beta'), task('gamma')]
    const query: SDKQuery = async function* (_prompt, options) {
      models.push({ role: options.accounting?.role, model: options.env.ANTHROPIC_MODEL })
      const count = (counts.get(options.sessionId) ?? 0) + 1; counts.set(options.sessionId, count)
      if (options.sessionId === 'parent') {
        if (count === 1) yield toolMessage('plan', 'experiment_plan', { tasks })
        else if (count === 2) yield toolMessage('delegate', 'delegate_agent', { task_ids: ['alpha', 'beta', 'gamma'] })
        else if (count === 3) yield toolMessage('wait', 'wait_for_delegations', { timeout_ms: 2000 })
        else yield text()
      } else {
        if (count === 1) for (const item of tasks) yield toolMessage(`write-${item.id}`, 'write_file', { path: `${item.id}.py`, content: '# own plan implemented' })
        else yield text()
      }
      yield { type: 'result', subtype: 'success', stop_reason: count === 1 ? 'tool_use' : 'end_turn' }
    }
    await run(query)
    const config = readExperiment('p')!
    expect(config.tasks).toHaveLength(3); expect(config.plan_locked).toBe(true)
    expect(models.filter(item => item.role === 'experiment_dispatcher').every(item => item.model === dispatcherModel)).toBe(true)
    expect(models.filter(item => item.role === 'experiment_executor').length).toBeGreaterThan(0)
    expect(models.filter(item => item.role === 'experiment_executor').every(item => item.model === executorModel)).toBe(true)
    expect(readFileSync(join(root, 'gamma.py'), 'utf8')).toContain('own plan')
  })
  it('restores a completed scaffold worker and binds the new executor instead of inheriting the dispatcher', async () => {
    const config = running(); config.mode = 'longterm'; config.workers['worker-1'] = { delegation_id: 'historical-worker', child_session_id: 'scaffold-worker', task_ids: [] }
    config.condition_hash = experimentConditionHash(config); writeExperiment(config)
    const sessions = JSON.parse(readFileSync(join(home, 'bloma-agent-sessions.json'), 'utf8'))
    sessions.sessions.push({ session_id: 'scaffold-worker', project_id: 'p', parent_session_id: 'parent', source_delegation_id: 'historical-worker', jsonl_path: join(home, 'agent-sessions/scaffold-worker.jsonl') })
    save(join(home, 'bloma-agent-sessions.json'), JSON.stringify(sessions))
    save(join(home, 'agent-sessions/scaffold-worker.jsonl'), [
      { role: 'user', content: [{ type: 'text', text: '骨架历史证据' }] }, { role: 'assistant', content: [{ type: 'text', text: '骨架已准备，业务待实现' }] },
      { delegation_settle: 'completed', loop_status: 'completed', task_handoff: { schema_version: 1, completion: 'unverified', loop_status: 'completed', changed_files: [], verification: [], pending: [] } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n')
    let parentCalls = 0, childSeen = false
    const query: SDKQuery = async function* (_prompt, options) {
      if (options.sessionId === 'parent') {
        if (++parentCalls === 1) yield toolMessage('plan', 'experiment_plan', { tasks: [task('only')] })
        else if (parentCalls === 2) yield toolMessage('resume', 'delegate_agent', { task_ids: ['only'] })
        else if (parentCalls === 3) yield toolMessage('wait', 'wait_for_delegations', { timeout_ms: 2000 })
        else yield text()
      } else {
        childSeen = true; expect(options.sessionId).toBe('scaffold-worker'); expect(options.env.ANTHROPIC_MODEL).toBe('m2')
        expect(JSON.stringify(options.messages)).toContain('骨架历史证据'); yield text()
      }
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await run(query, { quickMode: false })
    expect(childSeen).toBe(true); expect(Object.keys(readExperiment('p')!.workers)).toEqual(['worker-1'])
  })
  it('really overlaps two executor requests and reports concurrency without claiming product quality', async () => {
    const tasks = [task('left'), task('right')]; let parentCalls = 0, active = 0, peak = 0
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve })
    const counts = new Map<string, number>()
    const query: SDKQuery = async function* (_prompt, options) {
      const count = (counts.get(options.sessionId) ?? 0) + 1; counts.set(options.sessionId, count)
      if (options.sessionId === 'parent') {
        if (++parentCalls === 1) yield toolMessage('plan', 'experiment_plan', { tasks })
        else if (parentCalls === 2) yield toolMessage('left', 'delegate_agent', { task_ids: ['left'] })
        else if (parentCalls === 3) yield toolMessage('right', 'delegate_agent', { task_ids: ['right'] })
        else if (parentCalls === 4) yield toolMessage('wait', 'wait_for_delegations', { timeout_ms: 2000 })
        else yield text()
      } else if (count === 1) {
        active++; peak = Math.max(peak, active); if (active === 2) release()
        try { await withAbort(barrier, options.signal); yield text() } finally { active-- }
      } else yield text()
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await run(query)
    expect(peak).toBe(2)
    const report = reportModelExperiment('p')
    expect(report.peak_overlapping_executor_requests).toBe(2)
    expect(report.implemented_worker_sessions).toBe(2)
    expect(report.product_quality).toBeNull()
    expect(report.model_requests_by_role.executor.models).toEqual(['m2'])
  })
  it('runs the standalone executor directly with write tools and zero child creation', async () => {
    writeExperiment(running('standalone')); const seen: string[] = []
    let count = 0
    const query: SDKQuery = async function* (_prompt, options) {
      seen.push(options.env.ANTHROPIC_MODEL)
      expect(options.tools?.map(tool => tool.name)).not.toContain('delegate_agent')
      expect(options.tools?.map(tool => tool.name)).not.toContain('experiment_plan')
      expect(options.tools?.map(tool => tool.name)).toContain('probe_desktop_env')
      expect(options.accounting?.role).toBe('experiment_executor')
      if (++count === 1) yield toolMessage('write', 'write_file', { path: 'solo.py', content: '# directly implemented' })
      else yield text()
      yield { type: 'result', subtype: 'success', stop_reason: count === 1 ? 'tool_use' : 'end_turn' }
    }
    await run(query)
    expect(new Set(seen)).toEqual(new Set(['m2'])); expect(readExperiment('p')!.workers).toEqual({})
    expect(readFileSync(join(root, 'solo.py'), 'utf8')).toContain('directly')
  })
  it('uses the fixed verifier rather than the dispatcher in the native Verify loop', async () => {
    let invoked = false
    const query: SDKQuery = async function* (_prompt, options) {
      invoked = true; expect(options.env.ANTHROPIC_MODEL).toBe('mv'); expect(options.accounting?.role).toBe('experiment_verifier')
      yield text(); yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    await run(query, { currentPhase: 'desktop-verify', artifactExists: () => false })
    expect(invoked).toBe(true)
  })
})

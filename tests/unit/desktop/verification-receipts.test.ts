import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DriverExecutionError } from '../../../main/desktop/process-driver'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildChildScriptRunnerTool } from '../../../main/desktop/child-exec-tool'
import { createToolState, runAgentLoop, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKMessage } from '../../../shared/types'
import { createProject } from '../../../main/project/project-service'
import { safeToolFeedback, type ToolFeedback } from '../../../shared/tool-feedback'
import { retainedToolFeedback } from '../../../shared/tool-feedback-policy'
import { consumeProjectAttempt, resetProjectAttemptScope } from '../../../main/platform/execution/project-attempts'
import { restorePromaHome } from '../../support/proma-home-guard'
import { buildTaskHandoff, readTaskHandoff } from '../../../main/agent/delegation/task-handoff'
import { refreshHandoffEvidence } from '../../../main/agent/delegation/delegation-evidence'
import type { DelegationRecord } from '../../../main/agent/delegation/agent-collaboration'
import * as jsonStore from '../../../storage/json-store'

describe('host versioned verification receipts', () => {
  const priorHome = process.env.PROMA_HOME
  let root: string, id: string, ctx: ToolContext
  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-receipts-'))
    const project = createProject({ request_id: 'receipts-test', mode: 'quick' })
    root = project.root_path; id = project.project_id
    writeFileSync(join(root, 'core_check.py'), 'print("PASS core")')
    writeFileSync(join(root, 'test_ui.py'), 'print("PASS gui")')
    ctx = { projectId: id, sessionId: 'receipt-child', requestId: 'receipt-test', signal: new AbortController().signal, state: createToolState() }
  })
  afterEach(() => { vi.restoreAllMocks(); restorePromaHome(priorHome) })
  function runner(stdout: string) {
    return buildChildScriptRunnerTool(id, { resolvePython: async () => 'C:/Python313/python.exe',
      spawn: vi.fn(async () => ({ code: stdout.startsWith('FAIL') ? 1 : 0, stdout, stderr: '' })) })
  }
  async function run(script: string, stdout: string) {
    const tool = runner(stdout), outcome = await tool.execute({ script }, ctx)
    tool.recordFeedback!(safeToolFeedback(outcome.feedback)!, ctx)
    return tool
  }
  it('retains separate logic and GUI proofs through a later no-assertion probe, restart and reads', async () => {
    await run('core_check.py', 'PASS core\n')
    await run('test_ui.py', 'PASS gui\n')
    const probe = runner('interpreter ok\n')
    const output = await probe.execute({ code: 'print("interpreter ok")' }, ctx)
    probe.recordFeedback!(safeToolFeedback(output.feedback)!, ctx)
    const facts = runner('').collectFeedback!(ctx)
    expect(facts.filter(f => f.evidence).map(f => [f.evidence!.entry, f.verification, f.evidence!.freshness]))
      .toEqual([['core_check.py', 'passed', 'current'], ['test_ui.py', 'passed', 'current']])
    expect(facts.at(-1)?.budget?.remaining).toBe(9)
    const handoff = buildTaskHandoff({ status: 'completed', turns: 1, finalText: '', toolCalls: [], tool_feedback: facts })
    expect(readTaskHandoff(JSON.parse(JSON.stringify(handoff)))?.resources?.[0].remaining).toBe(9)
  })
  it('invalidates real code/test/input/environment changes but not delivery registration prose', async () => {
    const tool = await run('core_check.py', 'PASS core\n')
    writeFileSync(join(root, 'DELIVERY.md'), 'delivery notes')
    writeFileSync(join(root, 'CORE_CHECK.json'), '{"schema_version":2}')
    expect(tool.collectFeedback!(ctx)[0].evidence?.freshness).toBe('current')
    writeFileSync(join(root, 'app.py'), 'print("changed product")')
    expect(tool.collectFeedback!(ctx)[0]).toMatchObject({ verification: 'unverified', evidence: { freshness: 'stale' } })
    await run('core_check.py', 'PASS core\n')
    consumeProjectAttempt(id, 'install:another-worker', 4)
    expect(tool.collectFeedback!(ctx)[0].evidence?.freshness).toBe('stale')
  })
  it('invalidates receipts for executable code written into the report directory', async () => {
    const tool = await run('core_check.py', 'PASS core\n')
    mkdirSync(join(root, '00_VERIFY'))
    writeFileSync(join(root, '00_VERIFY', 'core-verification.json'), '{}')
    writeFileSync(join(root, '00_VERIFY', 'mvp-review.html'), '<html>host review output</html>')
    expect(tool.collectFeedback!(ctx)[0].evidence?.freshness).toBe('current')
    writeFileSync(join(root, '00_VERIFY', 'actual_test.py'), 'assert False')
    expect(tool.collectFeedback!(ctx)[0].evidence?.freshness).toBe('stale')
  })
  it('a later FAIL of the same command replaces its earlier PASS; executions are never skipped', async () => {
    await run('core_check.py', 'PASS core\n')
    const last = await run('core_check.py', 'FAIL core\n')
    const facts = last.collectFeedback!(ctx)
    expect(facts.filter(f => f.evidence)).toHaveLength(1)
    expect(facts[0]).toMatchObject({ verification: 'failed', evidence: { failed: 1, freshness: 'current' } })
    expect(facts.at(-1)?.budget?.used).toBe(2)
  })
  it('invalidates an old PASS before execution, surviving a crash before the final receipt hook', async () => {
    await run('core_check.py', 'PASS core\n')
    const tool = runner('FAIL core\n')
    const outcome = await tool.execute({ script: 'core_check.py' }, ctx)
    expect(outcome.feedback?.evidence?.attempt_seq).toBe(2)
    // Simulate an interrupted host: the post-audit record hook never runs.
    const restarted = runner('').collectFeedback!(ctx).filter(f => f.evidence)
    expect(restarted).toHaveLength(1)
    expect(restarted[0]).toMatchObject({ verification: 'unverified', reason: 'VERIFICATION_ATTEMPT_PENDING', evidence: { attempt_seq: 2, freshness: 'unknown', passed: 0 } })
  })
  it('does not start a rerun if the old receipt cannot be durably invalidated', async () => {
    await run('core_check.py', 'PASS core\n')
    const write = jsonStore.writeTextFileAtomic
    vi.spyOn(jsonStore, 'writeTextFileAtomic').mockImplementation((file, text) => {
      if (file.includes('verification-receipts')) throw new Error('injected receipt storage error')
      write(file, text)
    })
    const spawn = vi.fn(async () => ({ code: 1, stdout: 'FAIL core', stderr: '' }))
    const tool = buildChildScriptRunnerTool(id, { resolvePython: async () => 'C:/Python313/python.exe', spawn })
    const outcome = await tool.execute({ script: 'core_check.py' }, ctx)
    expect(spawn).not.toHaveBeenCalled()
    expect(outcome.feedback).toMatchObject({ execution: 'not_run', verification: 'unverified', reason: 'EVIDENCE_INVALIDATION_FAILED' })
  })
  it('a final receipt write failure cannot resurrect PASS through loop completion, handoff refresh or restart; a newer real rerun can recover', async () => {
    await run('core_check.py', 'PASS core\n')
    let failReceipt = false
    const write = jsonStore.writeTextFileAtomic
    vi.spyOn(jsonStore, 'writeTextFileAtomic').mockImplementation((file, text) => {
      if (failReceipt && file.includes('verification-receipts')) throw new Error('injected final receipt write failure')
      write(file, text)
    })
    const tool = buildChildScriptRunnerTool(id, { resolvePython: async () => 'C:/Python313/python.exe', spawn: async () => {
      failReceipt = true
      return { code: 1, stdout: 'FAIL core\n', stderr: '' }
    } })
    let turns = 0
    const result = await runAgentLoop({ projectId: id, sessionId: ctx.sessionId, requestId: 'receipt-write-failure', signal: ctx.signal,
      task: 'rerun', system: '', env: {}, maxTokens: 256, maxTurns: 3, tools: [tool], permissionMode: 'allow-all', publish: () => {},
      query: async function* () {
        const content = ++turns === 1 ? [{ type: 'tool_use', id: 'failed-receipt', name: tool.name, input: { script: 'core_check.py' } }] : [{ type: 'text', text: 'done' }]
        yield { type: 'assistant', message: { role: 'assistant', content } } as SDKMessage
        yield { type: 'result', subtype: 'success', stop_reason: turns === 1 ? 'tool_use' : 'end_turn' } as SDKMessage
      } })
    const proof = result.tool_feedback!.find(f => f.evidence)!
    expect(proof).toMatchObject({ verification: 'unverified', reason: 'EVIDENCE_RECORD_FAILED', evidence: { attempt_seq: 2, failed: 1 } })
    const record = { projectId: id, childSessionId: ctx.sessionId, loopStatus: 'completed', abort: new AbortController(), taskHandoff: buildTaskHandoff(result) } as DelegationRecord
    expect(refreshHandoffEvidence(record, [runner('')])).toMatchObject({ completion: 'incomplete' })
    expect(refreshHandoffEvidence(record, [runner('')]).verification.find(f => f.evidence)?.reason).toBe('EVIDENCE_RECORD_FAILED')
    expect(runner('').collectFeedback!(ctx).filter(f => f.evidence).every(f => f.verification !== 'passed')).toBe(true)
    failReceipt = false
    const repaired = await run('core_check.py', 'PASS core\n')
    expect(refreshHandoffEvidence(record, [repaired]).verification.find(f => f.evidence)).toMatchObject({ verification: 'passed', evidence: { attempt_seq: 3 } })
  })
  it('execution sequence survives active budget resets and refuses a rewound counter', async () => {
    await run('core_check.py', 'PASS core\n')
    resetProjectAttemptScope(id, `script:${ctx.sessionId}`)
    const second = await run('core_check.py', 'PASS core\n')
    expect(second.collectFeedback!(ctx)[0].evidence?.attempt_seq).toBe(2)
    writeFileSync(join(process.env.PROMA_HOME!, 'execution-attempts', id + '.json'), '{"schema_version":1,"active":{},"total":{}}')
    const spawn = vi.fn(async () => ({ code: 0, stdout: 'PASS core', stderr: '' }))
    const tool = buildChildScriptRunnerTool(id, { resolvePython: async () => 'C:/Python313/python.exe', spawn })
    expect((await tool.execute({ script: 'core_check.py' }, ctx)).feedback?.reason).toBe('EVIDENCE_INVALIDATION_FAILED')
    expect(spawn).not.toHaveBeenCalled()
  })
  it.each(['no assertions', 'exception', 'timeout', 'cancelled'] as const)('replaces an earlier PASS when the same command later reports %s', async kind => {
    await run('core_check.py', 'PASS core\n')
    const tool = buildChildScriptRunnerTool(id, { resolvePython: async () => 'C:/Python313/python.exe', spawn: async () => {
      if (kind === 'timeout' || kind === 'cancelled') throw new DriverExecutionError(kind, 'stopped')
      return { code: kind === 'exception' ? 1 : 0, stdout: '', stderr: 'no business assertions' }
    } })
    const outcome = await tool.execute({ script: 'core_check.py' }, ctx)
    tool.recordFeedback!(safeToolFeedback(outcome.feedback)!, ctx)
    const facts = tool.collectFeedback!(ctx).filter(f => f.evidence)
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ verification: 'unverified', evidence: { passed: 0 } })
  })
  it('keeps argument values in receipt identity even when their short display labels match', async () => {
    const tool = runner('PASS parameterized\n')
    for (const args of [['--case', 'left'], ['--case', 'right']]) {
      const outcome = await tool.execute({ script: 'core_check.py', args }, ctx)
      tool.recordFeedback!(safeToolFeedback(outcome.feedback)!, ctx)
    }
    const facts = tool.collectFeedback!(ctx).filter(f => f.evidence)
    expect(facts).toHaveLength(2)
    expect(facts[0].evidence!.key).not.toBe(facts[1].evidence!.key)
  })
  it('post-audit permission rejection cannot be stored as a valid successful receipt', async () => {
    const tool = runner('PASS core\n'), outcome = await tool.execute({ script: 'core_check.py' }, ctx)
    tool.recordFeedback!({ ...outcome.feedback!, verification: 'unverified', category: 'permission' }, ctx)
    expect(tool.collectFeedback!(ctx)[0].verification).toBe('unverified')
  })
  it('resource facts survive a bounded handoff full of distinct entry evidence without falsely stopping a completed task', async () => {
    const tool = await run('core_check.py', 'PASS core\n'), facts = tool.collectFeedback!(ctx)
    const resource = facts.at(-1)!
    resource.budget = { ...resource.budget!, used: 12, remaining: 0 }
    const many: ToolFeedback[] = Array.from({ length: 16 }, (_, i) => ({ ...facts[0], evidence: { ...facts[0].evidence!, key: i.toString(16).padStart(64, '0') } }))
    const kept = retainedToolFeedback([...many, resource])
    expect(kept.at(-1)?.budget?.remaining).toBe(0)
    const handoff = buildTaskHandoff({ status: 'completed', turns: 1, finalText: '', toolCalls: [], tool_feedback: kept })
    expect(handoff.recovery).toBe('none')
    expect(handoff.completion).toBe('unverified')
  })
  it.skipIf(spawnSync('python', ['--version'], { windowsHide: true }).status !== 0)('real Python receipts pass through loop hooks and survive a final diagnostic', async () => {
    const tool = buildChildScriptRunnerTool(id)
    let turn = 0
    const result = await runAgentLoop({ projectId: id, sessionId: ctx.sessionId, requestId: ctx.requestId,
      signal: ctx.signal, task: 'run controlled checks', system: '', env: {}, maxTokens: 256, maxTurns: 5, tools: [tool], publish: () => {}, permissionMode: 'allow-all',
      query: async function* () {
        const input = [{ script: 'core_check.py' }, { script: 'test_ui.py' }, { code: 'print("diagnostic only")' }][turn++]
        if (input) {
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'receipt-call-' + turn, name: tool.name, input }] } } as SDKMessage
          yield { type: 'result', subtype: 'success', stop_reason: 'tool_use' } as SDKMessage
        } else {
          yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } as SDKMessage
          yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' } as SDKMessage
        }
      } })
    expect(result.status).toBe('completed')
    expect(result.tool_feedback?.filter(f => f.evidence).map(f => [f.evidence!.entry, f.verification, f.evidence!.freshness]))
      .toEqual([['core_check.py', 'passed', 'current'], ['test_ui.py', 'passed', 'current']])
    expect(result.tool_feedback?.find(f => f.scope === 'execution_resources')?.budget?.remaining).toBe(9)
  })
})

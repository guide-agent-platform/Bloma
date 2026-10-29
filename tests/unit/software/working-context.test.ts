import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { saveSoftwareRunState, readSoftwareRunState } from '../../../main/software/run-state'
import { softwareStatusView } from '../../../main/software/state-view'
import { softwareWorkingContext, renderSoftwareWorkingContext } from '../../../main/software/working-context'
import { buildProductionContextTool } from '../../../main/desktop/production-context'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { leanBudget } from '../../../main/desktop/lean-budget'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-working-state-')); process.env.PROMA_HOME = home; project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
it('clears stale errors on a new run but retains redacted history and never calls an ended turn delivered', () => {
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'old', status: 'blocked', error: 'api_key=PRIVATE_KEY' })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'running' })
  const state = readSoftwareRunState(project.project_id)!
  expect(state.error).toBeUndefined(); expect(state.last_failure?.run_id).toBe('old'); expect(state.last_failure?.error).not.toContain('PRIVATE_KEY')
  const checking = saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'verifying', error: 'historical warning from caller' })
  expect(checking.error).toBeUndefined(); expect(checking.last_failure?.error).toContain('historical warning')
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ execution: { status: 'interrupted' }, goal: { status: 'not_delivered' } })
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'verified' })
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ execution: { status: 'ended' }, goal: { status: 'not_delivered' } })
  updateProject(project.project_id, { current_stage: 'completed', desktop_phase: 'delivered', status: 'completed' })
  expect(softwareStatusView(project.project_id, false).goal.status).toBe('delivered')
})
it('labels a valid old verification as history and refuses a corrupt receipt', () => {
  const result = { status: 'passed', summary: 'old version' }, dir = join(home, 'software-verification'); mkdirSync(dir)
  const receipt = { state: 'complete', at: Date.now(), result, result_hash: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
  writeFileSync(join(dir, project.project_id + '.json'), JSON.stringify(receipt))
  expect(softwareStatusView(project.project_id, false)).toMatchObject({ verification: { status: 'last_passed' }, goal: { status: 'not_delivered' } })
  expect(softwareStatusView(project.project_id,false).verification.scope_note).toContain('历史记录未分层')
  const layered={...result,core:{acceptance_evidence:{version:1,coverage:'registered_case_references',registered_checks:'passed',implementation:'not_assessed',external_model_effects:'unverified',complete_requirements:'not_assessed'}}}
  writeFileSync(join(dir,project.project_id+'.json'),JSON.stringify({...receipt,result:layered,result_hash:createHash('sha256').update(JSON.stringify(layered)).digest('hex')}))
  expect(softwareStatusView(project.project_id,false).verification.scope_note).toContain('真实供应商连通和模型效果尚未验证')
  writeFileSync(join(dir, project.project_id + '.json'), JSON.stringify({ ...receipt, result_hash: 'corrupt' }))
  expect(softwareStatusView(project.project_id, false).verification.status).toBe('unavailable')
})
it('restores current version and bounded tool facts without including credentials or replaying commands', () => {
  saveSoftwareRunState({ projectId: project.project_id, sessionId: 's', runId: 'new', status: 'running' })
  mkdirSync(join(home, 'agent-sessions'), { recursive: true })
  writeFileSync(join(home, 'agent-sessions/s.jsonl'), [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'one', name: 'run_command', input: { command: ['secret-command-argument'] } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'one', is_error: true, content: '{"code":"COMMAND_TIMEOUT","stderr":"api_key=PRIVATE_KEY"}' }] },
  ].map(x => JSON.stringify(x)).join('\n') + '\n')
  const before = softwareWorkingContext(project.project_id)
  expect(before.recent.tools).toContainEqual(expect.objectContaining({ tool: 'run_command', status: 'failed', failure: 'COMMAND_TIMEOUT' }))
  expect(JSON.stringify(before)).not.toContain('PRIVATE_KEY'); expect(JSON.stringify(before)).not.toContain('secret-command-argument')
  writeFileSync(join(project.root_path, 'changed.js'), 'console.log("changed")')
  expect(softwareWorkingContext(project.project_id).current_source).not.toBe(before.current_source)
  const live = leanBudget(project.project_id, 'desktop-implement').snapshot(); mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(live.file, JSON.stringify({ version: 1, requests: 9, output: 5000, phases: { 'desktop-implement': 9 } }))
  expect(softwareWorkingContext(project.project_id).budget).toMatchObject({ requests: 9, output: 5000, accounting_available: true })
  const rendered = renderSoftwareWorkingContext(project.project_id)
  expect(rendered.length).toBeLessThan(8000); expect(() => JSON.parse(rendered.split('\n').slice(1).join('\n'))).not.toThrow()
})
it('discovers metadata first and serves only the requested capability protocol', async () => {
  const tool = buildProductionContextTool(project.project_id), ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', state: createToolState(), signal: new AbortController().signal }
  const catalog = await tool.execute({ topic: 'capabilities' }, ctx)
  expect(JSON.parse(catalog.output).catalog.some((x: { topic: string }) => x.topic === 'execution')).toBe(true)
  expect(catalog.output).not.toContain('from speech_runtime import SpeechEngine')
  const command = await tool.execute({ topic: 'execution' }, ctx)
  expect(command.output).toContain('yield_ms'); expect(command.output).not.toContain('speech_runtime')
  expect((await tool.execute({ topic: 'capabilities' }, { ...ctx, projectId: 'foreign' })).isError).toBe(true)
})

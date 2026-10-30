import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { createProductionBudget } from '../../../main/desktop/production-budget'
import { persistTerminalMessage } from '../../../main/orchestration/stages/persistence'
import { buildLeanCliTool } from '../../../main/desktop/lean-cli-check'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-continuity-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function setup() {
  const project = createProject({ request_id: 'c', mode: 'longterm' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const deps: DesktopRouteDeps = { publish: vi.fn(), persistAssistant: vi.fn(), persistSystem: vi.fn(), complete: vi.fn() }
  const input = { projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成原任务', maxTokens: 4096, signal: AbortSignal.timeout(150000) }
  return { project, input, deps }
}
it('runs real Pi tools beyond both old 96-turn and 160-request cutoffs, then verifies and delivers within one unchanged shared allowance', async () => {
  const { project, input, deps } = setup(); let calls = 0
  const use = (name: string, args: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `${calls}-${name}`, name, input: args })
  const query: SDKQuery = async function* () {
    ++calls
    const content = calls === 1 ? [use('write_file', { path: 'app.cjs', content: 'console.log(5)' }),
      // Distinct ids for the two writes, as required by the real tool runtime.
      { ...use('write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }) }), id: 'launch' },
      use('register_cli_check', { expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] })]
      : calls < 164 ? [use('write_file', { path: `parts/step-${calls}.txt`, content: `completed ${calls}` })]
      : [{ type: 'text' as const, text: '当前版本可以执行正式宿主验收。' }]
    yield { type: 'assistant', message: { role: 'assistant', content } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine(input, withEmptyQualityReview(query), {}, deps)
  expect(calls, JSON.stringify(findProject(project.project_id).desktop_blocked)).toBe(164)
  expect(findProject(project.project_id)).toMatchObject({status:'active',longterm_summary:{status:'awaiting_confirmation'}})
  await enterDesktopLine({...input,requestId:'user-confirm',content:'确认本阶段'},withEmptyQualityReview(query),{},deps)
  expect(calls).toBe(164)
  expect(findProject(project.project_id).status).toBe('completed')
  expect(readFileSync(join(project.root_path, 'parts/step-163.txt'), 'utf8')).toBe('completed 163')
  expect(leanBudget(project.project_id, 'desktop-implement').snapshot()).toMatchObject({ requests: 167, limits: { requests: 256, phaseRequests: 256 } })
  expect(deps.complete).toHaveBeenLastCalledWith('s', project.project_id)
}, 180000)
it('rejects an exhausted continuation before a model call, preserves its counters and persists the real incomplete reason', async () => {
  const { project, input, deps } = setup(), budget = leanBudget(project.project_id, 'desktop-implement')
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(budget.snapshot().file, JSON.stringify({ version: 1, requests: 256, output: 12000, phases: { 'desktop-implement': 253, prepare: 3 }, runtimeMs: 99 }))
  const query = vi.fn(async function* () { throw Error('must-not-call-provider') })
  deps.complete = (sid, pid, outcome) => persistTerminalMessage(sid, outcome === 'incomplete' ? 'incomplete' : 'completed', { message: findProject(pid).desktop_blocked?.note })
  await enterDesktopLine({ ...input, content: '继续' }, withEmptyQualityReview(query), {}, deps)
  expect(query).not.toHaveBeenCalled()
  expect(budget.snapshot()).toMatchObject({ requests: 256, output: 12000, phases: { 'desktop-implement': 253, prepare: 3 } })
  expect(deps.persistAssistant).toHaveBeenCalledWith('s', expect.stringContaining('累计请求 256/256'))
  const history = readFileSync(join(home, 'agent-sessions/s.jsonl'), 'utf8')
  expect(history).toContain('status=incomplete'); expect(history).toContain('HARNESS_REQUEST_BUDGET_EXHAUSTED'); expect(history).not.toContain('status=completed')
})
it('retains the legacy phase cap and the software shared output guard', () => {
  const legacy = createProductionBudget('legacy', 'v', 'desktop-implement')
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(legacy.snapshot().file, JSON.stringify({ version: 1, requests: 160, output: 1000, phases: { 'desktop-implement': 160 } }))
  expect(legacy.admission()).toMatchObject({ allowed: false, reason: 'HARNESS_REQUEST_BUDGET_EXHAUSTED' })
  const { project } = setup(), software = leanBudget(project.project_id, 'desktop-implement')
  writeFileSync(software.snapshot().file, JSON.stringify({ version: 1, requests: 160, output: 262144, phases: { 'desktop-implement': 160 } }))
  expect(software.admission()).toMatchObject({ allowed: false, reason: 'HARNESS_OUTPUT_BUDGET_EXHAUSTED' })
})
it.each([5, 999])('checks already registered behavior after a fully exhausted continuation without another model request (actual=%s)', async actual => {
  const { project, input, deps } = setup(), budget = leanBudget(project.project_id, 'desktop-implement')
  writeFileSync(join(project.root_path, 'app.cjs'), `console.log(${actual})`)
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  const registered = await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] },
    { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: input.signal, state: createToolState() })
  expect(registered.isError, registered.output).not.toBe(true)
  mkdirSync(join(home, 'harness-budgets'), { recursive: true })
  writeFileSync(budget.snapshot().file, JSON.stringify({ version: 1, requests: 256, output: 12000, phases: { 'desktop-implement': 253, prepare: 3 }, runtimeMs: 99 }))
  const query = vi.fn(async function* () { throw Error('must-not-call-provider') })
  await enterDesktopLine({ ...input, content: '继续' }, withEmptyQualityReview(query), {}, deps)
  expect(query).not.toHaveBeenCalled()
  if(actual===5) expect(findProject(project.project_id).desktop_blocked?.note).toContain('QUALITY_REVIEW_REQUIRED')
  expect(query).not.toHaveBeenCalled()
  expect(findProject(project.project_id).status === 'completed').toBe(false)
  expect(budget.snapshot()).toMatchObject({ requests: 256, output: 12000 })
}, 90000)

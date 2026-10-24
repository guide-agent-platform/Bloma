import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { parseGuiSuite, guiSuitePath } from '../../../main/desktop/gui-acceptance'
import { buildProductionContextTool } from '../../../main/desktop/production-context'
import { createToolState, runAgentLoop, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/stages/orchestration-contracts'
import { validateToolInput } from '../../../main/agent/loop/tool-input-validation'
import { guiStepsSchema } from '../../../main/desktop/gui-tool-contract'
const fixture = JSON.parse(readFileSync(resolve('tests/fixtures/gui-tool-contract/calculator-failed-inputs.json'), 'utf8'))
const requirements = [{ description: '输入数字与基本运算符并显示算式', expected: '界面上能看到输入的数字和运算符' },
  { description: '执行加减乘除计算并显示结果', expected: '按下等号后显示正确的计算结果' }, { description: '清除当前输入与结果', expected: '按下清除后显示归零或空白状态' }]
let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, ctx: ToolContext
beforeEach(() => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-gui-contract-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '计算器', ui: 'required', delivery: 'desktop', requirements }),
    { projectId: project.project_id, sessionId: 's', source: '计算器', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, hash = prdScopeFingerprint(brief)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: hash, design_hash: hash, html_hash: null } })
  ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() }
})
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('replays actual failed calculator calls with actionable field paths before any observation or sealed suite', async () => {
  const tool = buildLeanGuiTool(project.project_id)
  for (const sample of fixture.samples) {
    const schema = sample.tool === 'register_gui_check' ? tool.input_schema : { type: 'object', properties: { steps: guiStepsSchema(32) } }
    expect(validateToolInput(sample.tool, sample.input, schema)).toMatch(/steps\[0\]\.kind|steps\[0\]\.id/)
    if (sample.tool === 'register_gui_check') {
      const result = await tool.execute(sample.input, ctx)
      expect(result.isError).toBe(true); expect(result.feedback).toMatchObject({ execution: 'not_run', category: 'invalid_input', recovery: 'correct_input' })
      expect(result.output).toContain('example'); expect(result.output).toContain('后续字段未必已校验')
    }
  }
  expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
})
function repairRecordedSteps() {
  const recorded = fixture.samples.find((sample: { source_line: number }) => sample.source_line === 111).input
  return { acceptance_refs: recorded.acceptance_refs, steps: recorded.steps.filter((step: { action: string }) => step.action !== 'restart').map((step: { action: string; id: string; selector: string; text?: string }) =>
    ({ id: step.id, kind: step.action, selector: step.selector, ...(step.action === 'expect' ? { equals: step.text } : {}) })) }
}
it('corrected real-history input registers without copying expectations; source intent, coverage and frozen assertions remain enforced', async () => {
  const tool = buildLeanGuiTool(project.project_id), corrected = repairRecordedSteps()
  expect(tool.input_schema.required).not.toContain('expectations')
  expect(validateToolInput(tool.name, corrected, tool.input_schema)).toBeUndefined()
  expect((await tool.execute(corrected, ctx)).isError).not.toBe(true)
  const saved = JSON.parse(readFileSync(guiSuitePath(project.project_id), 'utf8'))
  expect(saved.expectations).toEqual(Object.fromEntries(requirements.map((row, i) => [`F-00${i + 1}`, row.expected])))
  const wrong = structuredClone(corrected); wrong.steps.find((step: { kind: string }) => step.kind === 'expect').equals = '999'
  expect((await tool.execute(wrong, ctx)).output).toContain('GUI_EXISTING_EXPECTATIONS_CHANGED')
  expect((await tool.execute({ ...corrected, acceptance_refs: { 's-result': ['F-002'] } }, ctx)).output).toContain('GUI_EXPECT_OBSERVATIONS_REQUIRED')
  expect((await tool.execute({ ...corrected, expectations: { 'F-001': 'weakened' } }, ctx)).output).toContain('authoritative_expectations')
})
it('on-demand guidance exposes the same schema, mapping example and actual host expectations', async () => {
  const result = await buildProductionContextTool(project.project_id).execute({ topic: 'verification-gui' }, ctx), view = JSON.parse(result.output)
  expect(view.gui_step_schema).toEqual((buildLeanGuiTool(project.project_id).input_schema.properties as any).steps)
  expect(view.example.steps[1]).toMatchObject({ id: 'answer', kind: 'expect', equals: '5' })
  expect(Object.keys(view.authoritative_expectations)).toEqual(['F-001', 'F-002', 'F-003'])
})
it('parser identifies assertion field and restart-segment failures precisely', () => {
  const base = { version: 1, scope_hash: 'a'.repeat(64), covers: ['F-001'] }
  expect(() => parseGuiSuite({ ...base, steps: [{ id: 'e', kind: 'expect', selector: '#result', expected: '5' }] })).toThrow('steps[0]')
  expect(() => parseGuiSuite({ ...base, steps: [{ id: 'e', kind: 'expect', selector: '#result', equals: '5' }, { id: 'r', kind: 'restart' }] })).toThrow('第2段')
})
it('real Pi receives the public contract, reports the actual historical bad call, then accepts corrected registration without a copied expectation map', async () => {
  const tool = buildLeanGuiTool(project.project_id), requests: SDKQueryOptions[] = []
  const query: SDKQuery = async function* (_prompt, options) {
    requests.push(options)
    const schema = options.tools!.find(row => row.name === tool.name)!.input_schema as any
    expect(schema.properties.steps.items.properties.kind.enum).toContain('expect')
    expect(schema.properties.steps.items.properties.equals.type).toBe('string')
    expect(schema.required).not.toContain('expectations')
    if (requests.length === 2) {
      expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
      expect(JSON.stringify(options.messages)).toContain('kind')
    }
    const content = requests.length <= 2 ? [{ type: 'tool_use' as const, id: `register-${requests.length}`, name: tool.name,
      input: requests.length === 1 ? fixture.samples.find((sample: { source_line: number }) => sample.source_line === 111).input : repairRecordedSteps() }]
      : [{ type: 'text' as const, text: '已登记，业务通过仍由宿主操作判定。' }]
    yield { type: 'assistant', message: { role: 'assistant', content } }; yield { type: 'result', subtype: 'success', usage: { output_tokens: 10 } }
  }
  const result = await runAgentLoop({ runtime: 'pi', runtimeScope: 'gui-contract-regression', projectId: project.project_id, sessionId: 's', requestId: 'r',
    tools: [tool], system: '按公开工具契约登记已确认计算器场景。', task: '登记GUI', env: {}, query, maxTokens: 1024, maxTurns: 5,
    permissionMode: 'allow-all', signal: AbortSignal.timeout(60000), publish: () => {} })
  expect(result.status).toBe('completed'); expect(requests).toHaveLength(3)
  expect(result.toolCalls).toMatchObject([{ name: tool.name, status: 'error' }, { name: tool.name, status: 'ok' }])
  expect(existsSync(guiSuitePath(project.project_id))).toBe(true)
}, 90000)

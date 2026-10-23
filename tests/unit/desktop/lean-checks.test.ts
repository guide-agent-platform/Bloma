import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { buildLeanCliTool, runLeanCliCheck, cliSuitePath } from '../../../main/desktop/lean-cli-check'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { runLaunchSmoke } from '../../../main/desktop/launch-smoke'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { getDocumentsDir } from '../../../storage/config-paths'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-check-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) })
function setup(ui: 'none' | 'required') {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'lean-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '加法', ui, requirements: [{ description: '计算加法', expected: '2加3得到5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '2加3得到5', previous: readPrdBackplane(project.project_id) })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', session_id: 's', project_id: project.project_id, checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!
  const ctx: ToolContext = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() }
  return { project, brief, ctx }
}
it('runs the actual CLI entry with fixed arguments; an incorrect expected output fails, and same-scope weakening is rejected', async () => {
  const { project, ctx } = setup('none')
  writeFileSync(join(project.root_path, 'app.py'), 'import sys\nprint(int(sys.argv[1]) + int(sys.argv[2]))\n')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' }))
  const payload = { expectations: { 'F-001': '2加3得到5' }, cases: [{ name: '加法', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] }
  const tool = buildLeanCliTool(project.project_id)
  expect((await tool.execute(payload, ctx)).isError).not.toBe(true)
  expect((await runLeanCliCheck(project.project_id, project.root_path)).status).toBe('passed')
  const wrong = structuredClone(payload); wrong.cases[0].stdout = '999'
  expect((await tool.execute(wrong, ctx)).isError).toBe(true)
  const saved = JSON.parse(readFileSync(cliSuitePath(project.project_id), 'utf8')); saved.cases[0].stdout = '999'
  writeFileSync(cliSuitePath(project.project_id), JSON.stringify(saved))
  const result = await runLeanCliCheck(project.project_id, project.root_path)
  expect(result.status).toBe('failed'); expect(result.cases[0].actual.trim()).toBe('5')
})
it('GUI registration requires real observations and frozen intent, and cannot replace old expected values', async () => {
  const { project, brief, ctx } = setup('required')
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: prdScopeFingerprint(brief), design_hash: 'a'.repeat(64), html_hash: 'a'.repeat(64) } })
  const tool = buildLeanGuiTool(project.project_id)
  const payload = { expectations: { 'F-001': '2加3得到5' }, steps: [{ id: 'run', kind: 'click', selector: '#calculate' },
    { id: 'answer', kind: 'expect', selector: '#result', equals: '5' }], acceptance_refs: { answer: ['F-001'] } }
  expect((await tool.execute(payload, ctx)).isError).not.toBe(true)
  const changed = structuredClone(payload); changed.steps[1].equals = '999'
  expect((await tool.execute(changed, ctx)).output).toContain('GUI_EXISTING_EXPECTATIONS_CHANGED')
  expect((await tool.execute({ ...payload, acceptance_refs: { run: ['F-001'] } }, ctx)).isError).toBe(true)
  expect((await tool.execute({ ...payload, expectations: { 'F-001': '窗口存在就行' } }, ctx)).isError).toBe(true)
})
it('one-shot startup can succeed only on the explicit non-UI path; the legacy desktop contract still rejects immediate exit', async () => {
  const { project } = setup('none')
  writeFileSync(join(project.root_path, 'app.py'), 'print(5)\n')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' }))
  expect((await runLaunchSmoke(project.root_path, { allowCleanExit: true })).passed).toBe(true)
  expect((await runLaunchSmoke(project.root_path)).passed).toBe(false)
})
it('lean AI entry uses real local HTTP/error probes; a fixed network_error cannot pass', async () => {
  const { project, ctx } = setup('none')
  const previousBrief = readPrdBackplane(project.project_id)
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: 'AI客户端', ui: 'none', requirements: [{ description: 'AI增强文本', expected: '有配置时发送真实请求并显示结果，无配置时提示设置' }] }),
    { projectId: project.project_id, sessionId: 's', source: 'AI客户端', previous: previousBrief })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'ai', session_id: 's', project_id: project.project_id, checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, id = brief.requirements[0].id
  writeFileSync(join(project.root_path, 'llm_client.py'), readFileSync(resolve('main/templates/tools/llm_client.py'), 'utf8'))
  const product = 'from llm_client import LlmClient\nclass Logic:\n    def enhance(self, request):\n        return LlmClient().generate(request)\nif __name__ == "__main__":\n    print(Logic().enhance({"prompt":"hello"})["kind"])\n'
  writeFileSync(join(project.root_path, 'app.py'), product)
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' }))
  writeFileSync(join(project.root_path, 'CORE_CHECK.json'), JSON.stringify({ llm: { module: 'app', factory: 'Logic', method: 'enhance', covers: [id] } }))
  expect((await buildLeanCliTool(project.project_id).execute({ expectations: { [id]: brief.acceptance[id] }, cases: [{ name: 'unconfigured', covers: [id], args: [], stdout: 'unconfigured', exit_code: 0 }] }, ctx)).isError).not.toBe(true)
  const positive = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path })
  expect(positive.status, JSON.stringify(positive)).toBe('passed')
  expect(positive.llm).toMatchObject({ status: 'passed', request_count: 5 })
  writeFileSync(join(project.root_path, 'app.py'), product.replace('LlmClient().generate(request)', '{"ok":False,"kind":"network_error"} if request.get("config",{}).get("api_key") else {"ok":False,"kind":"unconfigured"}'))
  const negative = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path })
  expect(negative.host_cli?.status).toBe('passed')
  expect(negative.status).toBe('failed')
  writeFileSync(resolve('run-artifacts/lean-ai-probe.json'), JSON.stringify({ paid_requests: 0, positive, fixed_network_error_negative: negative }, null, 2))
})
it('a late unreadable goal cannot leave a completed behavior check marked PASS', async () => {
  const { project, ctx } = setup('none')
  writeFileSync(join(project.root_path, 'app.py'), 'print(5)\n')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' }))
  await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '2加3得到5' }, cases: [{ name: 'answer', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] }, ctx)
  const result = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path, capabilityVerifiers: [{ id: 'simulate-late-goal-corruption', run: async () => {
    writeFileSync(join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json'), 'broken'); return undefined
  } }] })
  expect(result.status).toBe('unverified')
  expect(result.requirements?.[0].verification).toBe('unverified')
})

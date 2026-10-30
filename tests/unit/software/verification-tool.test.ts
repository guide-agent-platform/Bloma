import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../../../storage/json-store', async original => {
  const actual = await original<typeof import('../../../storage/json-store')>()
  return { ...actual, writeTextFileAtomic: vi.fn(actual.writeTextFileAtomic) }
})
import { writeTextFileAtomic } from '../../../storage/json-store'
import { createProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { buildLeanCliTool } from '../../../main/desktop/lean-cli-check'
import { buildSoftwareVerifyTool } from '../../../main/software/verification-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { recentSoftwareVerification, verifySoftwareCandidate } from '../../../main/software/verification'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { frozenGuiFixtureVersion, sealGuiFixtures } from '../../../main/desktop/gui-fixtures'
import { installGuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'

let home: string, old: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-verify-action-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('invalidates old PASS on cancellation, corrupted receipts and receipt write failure', async () => {
  await setup()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  const file = join(home, 'software-verification', project.project_id+'.json'), bytes = readFileSync(file, 'utf8')
  writeFileSync(file, bytes.replace('"result_hash":"', '"result_hash":"bad'))
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  writeFileSync(file, bytes)
  const controller = new AbortController(); controller.abort()
  await expect(verifySoftwareCandidate(project.project_id, 'r', controller.signal, true)).rejects.toThrow()
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  writeFileSync(file, bytes)
  const actual = await vi.importActual<typeof import('../../../storage/json-store')>('../../../storage/json-store')
  vi.mocked(writeTextFileAtomic).mockImplementation((...args) => { if (args[0] === file) throw Error('fixture disk full'); actual.writeTextFileAtomic(...args) })
  try { await expect(verifySoftwareCandidate(project.project_id, 'r', undefined, true)).rejects.toThrow('fixture disk full') }
  finally { vi.mocked(writeTextFileAtomic).mockImplementation(actual.writeTextFileAtomic) }
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 60000)
const ctx = () => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(90000), state: createToolState() })
async function setup() {
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const source = `require('fs').appendFileSync(${JSON.stringify(join(home, 'executions.txt'))},${JSON.stringify('run\n')});console.log(5)`
  writeFileSync(join(project.root_path, 'app.cjs'), source); writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  expect((await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] }, ctx())).isError).not.toBe(true)
  return source
}
it('runs real checks from a parent action and reuses them at final delivery only for unchanged inputs in the same request', async () => {
  await setup(); const tool = buildSoftwareVerifyTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's'))
  const first = await tool.execute({}, ctx()); expect(first.isError, first.output).not.toBe(true)
  const count = () => readFileSync(join(home, 'executions.txt'), 'utf8').split('run\n').length - 1
  expect(count()).toBe(2); expect(JSON.parse((await tool.execute({}, ctx())).output).reused).toBe(true); expect(count()).toBe(2)
  expect(await recentSoftwareVerification(project.project_id, 'another-request')).toBeUndefined()
  const cached = await recentSoftwareVerification(project.project_id, 'r'); expect(cached?.core?.reused).toBe(true)
  const query: SDKQuery = async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '当前版本已验证，请交付。' }] } }; yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } } }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成原任务', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(findProject(project.project_id).status).toBe('completed'); expect(count()).toBe(2)
}, 120000)
it('invalidates source changes and never revives an older PASS when a failed version is restored', async () => {
  const source = await setup(); expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'app.cjs'), source.replace('console.log(5)', 'console.log(999)'))
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('failed')
  writeFileSync(join(project.root_path, 'app.cjs'), source)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 60000)
it('binds actual frozen fixture bytes and rejects tampering before a cached PASS can be consumed', async () => {
  await setup(); writeFileSync(join(project.root_path, 'input.txt'), 'owned fixture')
  const suite = sealGuiFixtures(project.project_id, project.root_path, { version: 1, scope_hash: prdScopeFingerprint(readPrdBackplane(project.project_id)), covers: ['F-001'], fixtures: [{ path: 'input/file.txt', source: 'input.txt' }], steps: [{ id: 'text', kind: 'expect', selector: 'body', nonempty: true }] })
  installGuiAcceptanceSuite(project.project_id, suite)
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  const file = join(home, 'gui-acceptance-fixtures', project.project_id, suite.scope_hash, `${suite.fixtures![0].sha256}.bin`)
  writeFileSync(file, 'corrupted fixture')
  expect(() => frozenGuiFixtureVersion(project.project_id, suite)).toThrow('FROZEN_BYTES_CHANGED')
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).not.toBe('passed')
}, 60000)
it('invalidates an earlier tool PASS when final delivery checks fail, even after the source is restored', async () => {
  const source = await setup()
  expect((await verifySoftwareCandidate(project.project_id, 'r')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'app.cjs'), source.replace('console.log(5)', 'console.log(999)'))
  let queries = 0
  const query: SDKQuery = async function* () {
    if (++queries > 1) throw Error('fixture-stop-after-observed-failure')
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '请执行实际收口检查。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '完成原任务', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(queries).toBe(2)
  expect(findProject(project.project_id).status).not.toBe('completed')
  const receipt = JSON.parse(readFileSync(join(home, 'software-verification', `${project.project_id}.json`), 'utf8'))
  expect(receipt.result.status).toBe('failed')
  writeFileSync(join(project.root_path, 'app.cjs'), source)
  expect(await recentSoftwareVerification(project.project_id, 'r')).toBeUndefined()
}, 120000)

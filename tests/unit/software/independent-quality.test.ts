import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createProject, updateProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint, requirementEvidenceHash } from '../../../main/project/requirement-contract'
import { prepareIndependentDesign, readIndependentDesign, type IndependentDesignPolicy } from '../../../main/software/independent-design'
import { assessIndependentCases, parseIndependentCases, type IndependentCases, type IndependentStep, type IndependentCase } from '../../../main/software/independent-semantics'
import { configureIndependentPolicy } from '../../../main/software/independent-policy'
import { verifySoftwareCandidate, recentSoftwareVerification } from '../../../main/software/verification'
import { createQualityReview, readQualityLedger } from '../../../main/software/quality-review'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { closeAllDebugSessions } from '../../../main/software/debug-sessions'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import { recordIndependentFindings } from '../../../main/software/independent-quality'
import { qualityIdentity, saveQualityLedger, type QualityFinding } from '../../../main/software/quality-ledger'
import { independentDesignVersion } from '../../../main/software/independent-design'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, contract: IndependentCases, policy: IndependentDesignPolicy, calls: number
const expected = '两条记录分别保存输入内容；修改A时B保持；取消放弃未保存编辑；空名称显示错误；重开保留；初始显示未填写'
const ctx = () => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', state: createToolState(), signal: AbortSignal.timeout(150000) })
const fill = (subject: string, value: string): IndependentStep => ({ kind: 'fill', control: `name${subject}`, subject, value })
const click = (control: string, subject = 'A', intent: 'submit' | 'cancel' = 'submit'): IndependentStep => ({ kind: 'click', control, subject, intent })
const echo = (subject: string, equals: string, step: number): IndependentStep => ({ kind: 'expect', control: `value${subject}`, subject, equals, oracle: { kind: 'input', step } })
function propose(): IndependentCases {
  const brief = readPrdBackplane(project.project_id), basis = { requirement_hash: requirementEvidenceHash(brief, brief.requirements[0]), expected_source: expected }
  const item = (id: string, coverage: IndependentCase['coverage'], steps: IndependentStep[]): IndependentCase => ({ id, feature: 'F-001', basis, coverage, steps })
  return { cases: [
    item('normal', ['normal'], [fill('A', 'Alpha'), click('saveA'), echo('A', 'Alpha', 0)]),
    item('identity', ['multi_object'], [fill('A', 'Alpha'), click('saveA'), fill('B', 'Beta'), click('saveB', 'B'), fill('A', 'Gamma'), click('saveA'), echo('A', 'Gamma', 4), echo('B', 'Beta', 2)]),
    item('cancel', ['cancel'], [fill('A', 'Alpha'), click('saveA'), fill('A', 'Draft'), click('cancelA', 'A', 'cancel'), echo('A', 'Alpha', 0)]),
    item('invalid', ['exception'], [click('cancelA', 'A', 'cancel'), { kind: 'expect', control: 'valueA', subject: 'A', equals: '未填写', oracle: { kind: 'literal', quote: '未填写' } }, fill('A', ''), click('saveA'), { kind: 'expect', control: 'error', equals: '错误', oracle: { kind: 'literal', quote: '错误' } }]),
    item('reopen', ['reopen'], [fill('A', 'Durable'), click('saveA'), { kind: 'restart' }, echo('A', 'Durable', 0)])
  ] }
}
const html = (broken: boolean) => `<html><head><title>双记录</title></head><body><input id="nameA"><button id="saveA" onclick="save('A')">保存A</button><button id="cancelA" onclick="cancelA()">取消A</button><p id="valueA"></p><input id="nameB"><button id="saveB" onclick="save('B')">保存B</button><p id="valueB"></p><p id="error"></p><script>
function el(id){return document.getElementById(id)}function render(){for(const x of ['A','B'])el('value'+x).textContent=localStorage.getItem(x)||'未填写'}
function save(x){const value=el('name'+x).value;if(!value.trim()){el('error').textContent='错误';return}localStorage.setItem(x,value);${broken ? "if(x==='A')localStorage.setItem('B',value);" : ''}el('error').textContent='';render()}
function cancelA(){el('nameA').value=localStorage.getItem('A')||'';render()}render()</script></body></html>`
beforeEach(async () => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-b-quality-')); process.env.PROMA_HOME = home; calls = 0
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '双记录编辑保存', ui: 'required', delivery: 'browser', requirements: [{ description: '独立维护两条记录及取消、异常、重开', expected }] }), { projectId: project.project_id, sessionId: 's', source: '双记录', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture'); parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ project_id: project.project_id, session_id: 's', request_id: 'sync', checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
  contract = propose()
  const money = join(home, 'money.json'), auth = join(home, 'authorization.json')
  writeFileSync(money, JSON.stringify({ version: 1, models: [{ host: 'b.invalid', model: 'model-b', cap_rmb: 1, context_tokens: 2048, input_rmb_per_million: 1, output_rmb_per_million: 1, cache_rmb_per_million: 0 }] }))
  const policyHash = createHash('sha256').update(readFileSync(money)).digest('hex')
  writeFileSync(money+'.state.json',JSON.stringify({version:1,policy_hash:policyHash,entries:[]}))
  writeFileSync(auth, JSON.stringify({ source: 'direct_user_confirmation', project_id: project.project_id, operation_id: findProject(project.project_id).lean_operation_id ?? 'initial', host: 'b.invalid', model: 'model-b', cap_rmb: 1, policy_sha256: policyHash }))
  policy = { version: 1, enabled: true, channel_id: 'b', model: 'model-b', monetary_policy_path: money, authorization_path: auth, timeout_ms: 3000, max_tokens: 4096 }
  configureIndependentPolicy(project.project_id, policy)
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done)); const port = (probe.address() as { port: number }).port; await new Promise<void>(done => probe.close(() => done()))
  writeFileSync(join(project.root_path, 'index.html'), html(true))
  writeFileSync(join(project.root_path, 'server.cjs'), `require('node:http').createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end(require('node:fs').readFileSync('index.html'))}).listen(${port},'127.0.0.1')`)
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs'], url: `http://127.0.0.1:${port}` }))
  const registered = await buildLeanGuiTool(project.project_id).execute({ steps: [{ id: 'fill', kind: 'fill', selector: '#nameA', value: 'Alpha' }, { id: 'save', kind: 'click', selector: '#saveA' }, { id: 'value', kind: 'expect', selector: '#valueA', equals: 'Alpha' }], acceptance_refs: { value: ['F-001'] } }, ctx())
  expect(registered.isError, registered.output).not.toBe(true)
})
afterEach(async () => { await closeAllDebugSessions(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function freeze() {
  const query: SDKQuery = async function* (prompt, options) {
    calls++; expect(prompt).not.toContain('localStorage'); expect(options.tools).toBeUndefined()
    options.requestGuard?.({ url: 'https://b.invalid/v1/messages', body: JSON.stringify({ model: 'model-b' }) })
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(contract) }] } }; yield { type: 'result', subtype: 'success', usage: { input_tokens: 100, output_tokens: 100 } }
  }
  const design = await prepareIndependentDesign({ projectId: project.project_id, sessionId: 's', query, primaryEnv: { ANTHROPIC_MODEL: 'model-a' }, signal: ctx().signal,
    resolveRoute: () => ({ channel_id: 'b', model: 'model-b', env: { ANTHROPIC_MODEL: 'model-b', ANTHROPIC_BASE_URL: 'https://b.invalid' } }) })
  expect(design.status, design.reason).toBe('frozen')
  const controls = Object.fromEntries(['nameA', 'nameB', 'saveA', 'saveB', 'cancelA', 'valueA', 'valueB', 'error'].map(control => [control, `#${control}`]))
  writeFileSync(join(project.root_path, 'INDEPENDENT_ADAPTER.json'), JSON.stringify({ version: 1, design_digest: design.digest, controls: Object.fromEntries(Object.entries(controls).filter(([control]) => contract.cases.some(c => c.steps.some(s => 'control' in s && s.control === control)))) }))
  return design
}
it('actual isolated B cases expose cross-object corruption, preserve cancel/error/reopen evidence and close through the existing finding tool only after a same-contract host retest', async () => {
  const design = await freeze(), before = readFileSync(join(home, 'software-independent-design', project.project_id, 'current.json'))
  expect(assessIndependentCases(readPrdBackplane(project.project_id), contract).ready).toBe(true)
  const failed = await verifySoftwareCandidate(project.project_id, 'r', ctx().signal, true)
  expect(failed.status, failed.summary).toBe('failed'); expect(failed.core?.status).toBe('passed')
  expect(failed.independent?.case_results?.map(c => c.status)).toEqual(['passed', 'failed', 'passed', 'passed', 'passed'])
  const finding = readQualityLedger(project.project_id).findings.find(f => f.independent?.case_id === 'identity')!
  expect(finding.disposition).toBe('confirmed'); expect(finding.checks[0].outcome).toBe('failed')
  const artifacts = join(process.cwd(), 'run-artifacts', 'q3-independent'); mkdirSync(artifacts, { recursive: true }); writeFileSync(join(artifacts, 'failed.json'), JSON.stringify(failed.independent, null, 2))
  writeFileSync(join(artifacts,'before.png'),readFileSync(join(dirname(failed.independent!.report_path!),'1/evidence/gui-0-failed.png')))
  writeFileSync(join(project.root_path, 'index.html'), html(false))
  const quality = createQualityReview(project.project_id, 's', createSoftwareCollaborationPolicy(project.project_id, project.root_path, 's')), check = quality.parentTools.find(t => t.name === 'check_quality_finding')!
  await expect(check.execute({ finding_id: finding.id, case_name: 'identity', status: 'closed' }, ctx())).rejects.toThrow('INVALID')
  const checked = await check.execute({ finding_id: finding.id, case_name: 'identity' }, ctx()); expect(checked.isError, checked.output).not.toBe(true)
  const closed = readQualityLedger(project.project_id).findings.find(f => f.id === finding.id)!
  expect(closed.disposition).toBe('closed'); expect(closed.checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(readIndependentDesign(project.project_id)?.digest).toBe(design.digest); expect(readFileSync(join(home, 'software-independent-design', project.project_id, 'current.json')).equals(before)).toBe(true); expect(calls).toBe(1)
  writeFileSync(join(artifacts, 'ledger.json'), JSON.stringify(readQualityLedger(project.project_id), null, 2))
  writeFileSync(join(artifacts,'after.png'),readFileSync(join(dirname(closed.checks.at(-1)!.report!),'1/evidence/gui-0.png')))
  expect(await recentSoftwareVerification(project.project_id,'r',ctx().signal)).toBeDefined()
  const challenge=quality.parentTools.find(t=>t.name==='challenge_independent_case')!
  await expect(challenge.execute({case_id:'identity',reason:'实现者怀疑预期',evidence:'需核对确认资料',status:'resolved'},ctx())).rejects.toThrow('INVALID')
  await challenge.execute({case_id:'identity',reason:'实现者认为案例与实际业务有分歧',evidence:'这是实现者主张，尚未有用户裁决'},ctx())
  expect(await quality.gate()).toContain('INDEPENDENT_SEMANTICS_UNRESOLVED')
  expect(await recentSoftwareVerification(project.project_id,'r',ctx().signal)).toBeUndefined()
  const challenged=await check.execute({finding_id:finding.id,case_name:'identity'},ctx())
  expect(challenged.isError).toBe(true);expect(JSON.parse(challenged.output).status).toBe('unverified')
  const updated=readQualityLedger(project.project_id).findings.find(f=>f.id===finding.id)!,disputed=JSON.parse(readFileSync(updated.checks.at(-1)!.report!,'utf8')).result
  expect(disputed.case_results.find((c:{id:string})=>c.id==='identity')).toMatchObject({status:'not_run',kind:'semantic'})
  expect(readIndependentDesign(project.project_id)?.digest).toBe(design.digest);expect(calls).toBe(1)
  writeFileSync(join(artifacts,'challenge.json'),JSON.stringify({finding:updated,result:disputed,tool_is_error:challenged.isError},null,2))
}, 180000)
it('wrong or unknown business expectations remain disputes, are not executed and stop normal production before A or a new B request', async () => {
  contract.cases = [contract.cases[0]]; contract.cases[0].basis!.expected_source = '未确认的新需求：新增自动备份'
  contract.coverage_notes = (['multi_object', 'exception', 'cancel', 'reopen'] as const).map(category => ({ feature: 'F-001', category, disposition: 'unresolved', reason: '需要核对', source: expected }))
  const briefHash = prdScopeFingerprint(readPrdBackplane(project.project_id)); await freeze(); writeFileSync(join(project.root_path, 'index.html'), html(false))
  const result = await verifySoftwareCandidate(project.project_id, 'r', ctx().signal, true)
  expect(result.status).toBe('unverified'); expect(result.failure?.code).toBe('INDEPENDENT_SEMANTICS_UNRESOLVED')
  expect(result.independent?.case_results?.[0]).toMatchObject({ status: 'not_run', kind: 'semantic', steps: [] })
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('disputed')
  const model = vi.fn(async function* () { throw Error('A must not implement disputed expectations') })
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'new', content: '继续', maxTokens: 4096, signal: ctx().signal }, model, { ANTHROPIC_MODEL: 'model-a' }, { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(model).not.toHaveBeenCalled(); expect(calls).toBe(1); expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
  expect(prdScopeFingerprint(readPrdBackplane(project.project_id))).toBe(briefHash)
}, 90000)
it('missing static adapter controls are unverified harness findings, not reproduced product defects', async () => {
  await freeze(); writeFileSync(join(project.root_path, 'index.html'), html(false))
  const file = join(project.root_path, 'INDEPENDENT_ADAPTER.json'), adapter = JSON.parse(readFileSync(file, 'utf8')); delete adapter.controls.nameA; writeFileSync(file, JSON.stringify(adapter))
  const result = await verifySoftwareCandidate(project.project_id, 'r', ctx().signal, true)
  expect(result.status).toBe('unverified'); expect(result.independent?.case_results?.[0].kind).toBe('adapter')
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('suspected')
  expect(readQualityLedger(project.project_id).findings[0].checks.some(c => c.outcome === 'failed')).toBe(false)
}, 90000)
it('rejects cross-object input oracles, invented literal values, cosmetic coverage labels and terminal restarts without changing frozen proposals', () => {
  const brief = readPrdBackplane(project.project_id)
  const omitted=structuredClone(contract);omitted.cases=[omitted.cases[0]];omitted.coverage_notes=(['multi_object','exception','cancel','reopen'] as const).map(category=>({feature:'F-001',category,disposition:'not_applicable',reason:'B声称不适用',source:expected}));expect(assessIndependentCases(brief,omitted).ready).toBe(false)
  for (const mutate of [
    (c: IndependentCases) => { const s = c.cases[1].steps[7]; if (s.kind === 'expect') s.oracle = { kind: 'input', step: 0 } },
    (c: IndependentCases) => { const s = c.cases[3].steps[4]; if (s.kind === 'expect') s.oracle = { kind: 'literal', quote: '新增未知规则' } },
    (c: IndependentCases) => { c.cases[0].coverage = ['multi_object'] },
    (c: IndependentCases) => { c.cases[4].steps.push({ kind: 'restart' }) },
    (c: IndependentCases) => { c.cases[2].steps = c.cases[0].steps }
    ,(c: IndependentCases) => { const s=c.cases[0].steps[2];if(s.kind==='expect')s.oracle={kind:'unresolved',question:'确认资料未规定这一规则'} }
  ]) { const proposed = structuredClone(contract); mutate(proposed); const bytes = JSON.stringify(proposed); expect(assessIndependentCases(brief, parseIndependentCases(bytes, ['F-001'])).ready).toBe(false); expect(JSON.stringify(proposed)).toBe(bytes) }
})
it('a changed B design cannot discharge an old reproduced defect while its confirmed business expectation is unchanged', async()=>{
  const identity=await qualityIdentity(project.project_id)
  const prior:QualityFinding={id:'prior',review:'old-B',identity,requirement:'F-001',expected_source:expected,category:'independent_behavior',severity:'high',location:'B:old',trigger:'旧冻结案例',evidence:'受控宿主失败凭据',reproduction:'old',unknowns:'',disposition:'confirmed',independent:{design_version:'older',design_digest:'older',case_id:'old'},checks:[{at:new Date().toISOString(),identity,case_name:'old',rules:'older',outcome:'failed',observation:'controlled transition test'}]}
  saveQualityLedger(project.project_id,{version:1,reviews:[],findings:[prior]})
  await recordIndependentFindings(project.project_id,{source:{digest:identity.source}} as never,{status:'passed',case_results:[],design_version:independentDesignVersion(project.project_id),design_digest:'new'},true)
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('confirmed')
})

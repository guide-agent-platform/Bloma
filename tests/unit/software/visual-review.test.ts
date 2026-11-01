import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createQualityReview, readQualityLedger } from '../../../main/software/quality-review'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { registerParentLoopContext, disposeParentDelegationState, findDelegation, settleParentDelegationRuns } from '../../../main/agent/delegation/agent-collaboration'
import { closeAllDebugSessions } from '../../../main/software/debug-sessions'
import { anthropicMessagesQueryViaProviders } from '../../../main/platform/upstream/providers/loop-query'
import { resolvePastedImagePath } from '../../../main/platform/shell/pasted-images'
import { readVisualMaterial, assertVisualRequest, visualHash } from '../../../main/software/visual-review-material'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, quality: ReturnType<typeof createQualityReview>, policy: ReturnType<typeof createSoftwareCollaborationPolicy>
const parent = 'visual-parent', expected = '点击增加后总数显示4件，不能保留多余静态零'
const ctx = (sessionId = parent): ToolContext => ({ projectId: project.project_id, sessionId, requestId: 'visual-r', state: createToolState(), signal: AbortSignal.timeout(90000) })
let rejectImages = false, reportFinding = true, wireBodies: string[] = []
const model = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk
  wireBodies.push(body)
  const parsed = JSON.parse(body), hasImage = JSON.stringify(parsed.messages).includes('"type":"image"')
  if (hasImage && rejectImages) { response.writeHead(400, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'image vision input unsupported' } })); return }
  const visual = readQualityLedger(project.project_id).reviews.filter(r => r.kind === 'visual').at(-1)!
  const alreadySubmitted = JSON.stringify(parsed.messages).includes('"name":"submit_quality_findings"')
  const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use', name, input, id: `v-${wireBodies.length}-${name}` })
  if (!hasImage) send(response, [use('read_quality_review', {}), use('view_quality_image', {})])
  else if (!alreadySubmitted) send(response, [use('submit_quality_findings', {
    visual_observations: [{ image_sha256: visual.visual!.image_hash, region: '总数右侧', observed: reportFinding ? '数字3旁仍显示00件，存在静态零残留' : '总数数字旁只显示件，无静态零残留' }],
    findings: reportFinding ? [{ requirement: 'F-001', expected_source: expected, category: 'visual', severity: 'high', location: '#total右侧单位', trigger: '点击增加', evidence: '图片中数值旁显示静态00件', reproduction: '点击增加并核对整个total文本', unknowns: '', kind: 'suspected' }] : []
  })])
  else send(response, [{ type: 'text', text: '具体可见观察与疑点已提交，未声称业务通过。' }])
})
function send(response: ServerResponse, blocks: Array<Record<string, unknown>>) {
  const events: unknown[] = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }]
  blocks.forEach((block, index) => {
    events.push({ type: 'content_block_start', index, content_block: block.type === 'text' ? { type: 'text', text: '' } : { type: 'tool_use', id: block.id, name: block.name, input: {} } },
      { type: 'content_block_delta', index, delta: block.type === 'text' ? { type: 'text_delta', text: block.text } : { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }, { type: 'content_block_stop', index })
  })
  events.push({ type: 'message_delta', delta: { stop_reason: blocks.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' })
  response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
}
const html = (broken: boolean) => `<html><head><title>器材计数</title><link rel="stylesheet" href="theme.css"></head><body><h1>器材小站</h1><p id="total"><strong id="value">3</strong><span>${broken ? '00' : ''}件</span></p><button id="inc" onclick="document.getElementById('value').textContent='4'">增加</button></body></html>`
beforeEach(async () => {
  previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-visual-review-')); process.env.PROMA_HOME = home
  rejectImages = false; reportFinding = true; wireBodies = []
  await new Promise<void>(done => model.listen(0, '127.0.0.1', done))
  project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '显示器材件数', ui: 'required', delivery: 'browser', requirements: [{ description: '点击增加更新件数', expected }] }),
    { projectId: project.project_id, sessionId: parent, source: '器材数量', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: parent, checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
  // Find a free app port; the actual app is then started by the existing observer.
  const probe = createServer(); await new Promise<void>(done => probe.listen(0, '127.0.0.1', done))
  const port = (probe.address() as { port: number }).port; await new Promise<void>(done => probe.close(() => done()))
  writeFileSync(join(project.root_path, 'index.html'), html(true))
  writeFileSync(join(project.root_path,'theme.css'),'p { color: #111; padding: 4px; }')
  writeFileSync(join(project.root_path, 'server.cjs'), `const http=require('node:http'),fs=require('node:fs');http.createServer((q,s)=>{s.setHeader('content-type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'))}).listen(${port},'127.0.0.1')`)
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: ['node', 'server.cjs'], ui: 'browser', url: `http://127.0.0.1:${port}` }))
  const registered = await buildLeanGuiTool(project.project_id).execute({ steps: [{ id: 'inc', kind: 'click', selector: '#inc' }, { id: 'total', kind: 'expect', selector: '#total', equals: '4件' }], acceptance_refs: { total: ['F-001'] } }, ctx())
  expect(registered.isError, registered.output).not.toBe(true)
  policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, parent); quality = createQualityReview(project.project_id, parent, policy)
  register()
})
afterEach(async () => {
  disposeParentDelegationState(parent); await settleParentDelegationRuns(parent, 20000); await closeAllDebugSessions()
  await new Promise<void>(done => model.close(() => done()))
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function register(override?: SDKQuery) {
  const seen = new Set<string>()
  const route: SDKQuery = async function* (prompt, options) {
    if (JSON.stringify(options.messages?.filter(m => m.role === 'system')).includes('独立视觉/交互审阅V')) { yield* (override ?? anthropicMessagesQueryViaProviders)(prompt, options); return }
    const first = !seen.has(options.sessionId); seen.add(options.sessionId)
    yield { type: 'assistant', message: { role: 'assistant', content: first ? [
      { type: 'tool_use', id: 'read', name: 'read_quality_review', input: {} }, { type: 'tool_use', id: 'source', name: 'read_file', input: { path: 'index.html' } }, { type: 'tool_use', id: 'submit', name: 'submit_quality_findings', input: { findings: [] } }
    ] : [{ type: 'text', text: '受控C已提交，未评定视觉效果。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  const env = { PATH: process.env.PATH!, ANTHROPIC_AUTH_TOKEN: 'local-fixture-never-provider', ANTHROPIC_MODEL: 'fixture-vision', ANTHROPIC_BASE_URL: `http://127.0.0.1:${(model.address() as { port: number }).port}` }
  registerParentLoopContext(parent, { query: quality.wrapQuery(route), env,
    maxTokens: 4096, maxTurns: 5, delegationMaxTurns: 5, permissionMode: 'allow-all', temperature: .1, system: 'A_SUCCESS_STORY', editFormat: 'diff',
    maxConcurrentDelegations: 2, allowChannelOverrides: false, prepareDelegation: quality.prepare, childSystemBuilder: (_role, child) => quality.system(child)!, childMaterialsBuilder: () => undefined,
    childToolsBuilder: (id, role, _format, child) => quality.reviewTools(buildSoftwareAgentTools(id, role, policy), child), publish: () => {} })
  return { route, env }
}
async function review(kind: 'code' | 'visual') {
  const child = await quality.begin(ctx(), kind); await findDelegation(parent, child.delegation_id)!.completion; await settleParentDelegationRuns(parent)
  return child
}
it('sends actual candidate PNG through Pi/native HTTP, records V findings in the shared ledger, reproduces residual zeros and closes only after real GUI repair/retest', async () => {
  await review('code'); expect(await quality.gate()).toContain('VISUAL_REVIEW_REQUIRED')
  await review('visual')
  let ledger = readQualityLedger(project.project_id), visual = ledger.reviews.at(-1)!
  expect(visual.status, JSON.stringify(ledger)).toBe('complete')
  expect(visual.visual_delivery?.image_hash).toBe(visual.visual?.image_hash)
  expect(wireBodies.map(body => visualHash(body))).toContain(visual.visual_delivery?.request_hash)
  expect(wireBodies.some(body => body.includes('"type":"image"'))).toBe(true)
  const imageBody = wireBodies.find(body => body.includes('"type":"image"'))!
  expect(assertVisualRequest(imageBody, visual.visual!.image_hash)).toMatch(/^[a-f0-9]{64}$/)
  const finding = ledger.findings[0]; expect(finding.review_kind).toBe('visual'); expect(finding.disposition).toBe('suspected')
  const artifacts = join(process.cwd(), 'run-artifacts', 'q2-visual'); mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'before.png'), readVisualMaterial(visual.visual!, visual.visual!.candidate).bytes)
  const check = quality.parentTools.find(t => t.name === 'check_quality_finding')!
  await check.execute({ finding_id: finding.id, case_name: 'total' }, ctx())
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('confirmed')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  writeFileSync(join(project.root_path, 'index.html'), html(false))
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
  await check.execute({ finding_id: finding.id, case_name: 'total' }, ctx())
  expect(readQualityLedger(project.project_id).findings[0].checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('closed')
  reportFinding = false; await review('code'); await review('visual'); expect(await quality.gate()).toBeUndefined()
  ledger = readQualityLedger(project.project_id); visual = ledger.reviews.at(-1)!
  writeFileSync(join(artifacts, 'after.png'), readVisualMaterial(visual.visual!, visual.visual!.candidate).bytes)
  writeFileSync(join(artifacts, 'ledger.json'), JSON.stringify(ledger, null, 2))
  writeFileSync(join(artifacts, 'wire-summary.json'), JSON.stringify({ scope: 'local_fixture_not_supplier', requests: wireBodies.map(body => ({ request_hash: visualHash(body), bytes: Buffer.byteLength(body), contains_image_bytes: body.includes('"type":"image"') })) }, null, 2))
}, 150000)
it('rejects foreign ownership, parent debug IDs, missing image delivery, swapped bytes, expired materials and stale source', async () => {
  register(async function* () { await new Promise(() => {}) })
  const child = await quality.begin(ctx(), 'visual'), visual = readQualityLedger(project.project_id).reviews.at(-1)!
  const viewer = quality.childProtocol.find(t => t.name === 'view_quality_image')!
  await expect(viewer.execute({}, ctx())).rejects.toThrow('NOT_OWNED')
  await expect(viewer.execute({}, ctx('foreign'))).rejects.toThrow('NOT_OWNED')
  await expect(viewer.execute({ debug_session_id: visual.visual!.review }, ctx(child.child_session_id))).rejects.toThrow('NOT_OWNED')
  await quality.childProtocol[0].execute({}, ctx(child.child_session_id)); await viewer.execute({}, ctx(child.child_session_id))
  await expect(quality.childProtocol[1].execute({ findings: [], visual_observations: [{ image_sha256: visual.visual!.image_hash, region: 'total', observed: '00件' }] }, ctx(child.child_session_id))).rejects.toThrow('NOT_DELIVERED')
  expect(quality.reviewTools(buildSoftwareAgentTools(project.project_id, 'review', policy), child.child_session_id).some(t => ['read_file', 'view_image', 'inspect_app', 'run_command'].includes(t.name))).toBe(false)
  const png = resolvePastedImagePath(visual.image!.imageId), bytes = readFileSync(png); writeFileSync(png, 'swapped')
  await expect(viewer.execute({}, ctx(child.child_session_id))).rejects.toThrow('CHANGED')
  writeFileSync(png, bytes)
  const sealed = join(home, 'software-quality-materials', project.project_id, visual.id, 'manifest.json'), metadata = readFileSync(sealed)
  writeFileSync(sealed, Buffer.concat([metadata, Buffer.from('\n')]))
  await expect(viewer.execute({}, ctx(child.child_session_id))).rejects.toThrow('CHANGED')
  writeFileSync(sealed, metadata)
  expect(() => readVisualMaterial({ ...visual.visual!, expires: Date.now() - 1 }, visual.visual!.candidate)).toThrow('EXPIRED')
  writeFileSync(join(project.root_path, 'index.html'), html(false))
  await expect(viewer.execute({}, ctx(child.child_session_id))).rejects.toThrow('STALE')
}, 90000)
it('an actual native HTTP image rejection leaves V unverified and cannot become a text-only visual pass', async () => {
  rejectImages = true; await review('code'); await review('visual')
  const visual = readQualityLedger(project.project_id).reviews.at(-1)!
  expect(visual.status).toBe('interrupted'); expect(visual.visual_delivery).toBeUndefined()
  expect(await quality.gate()).toContain('VISUAL_MODEL_UNSUPPORTED')
  expect(wireBodies.some(body => body.includes('"type":"image"'))).toBe(true)
}, 90000)
it('wire validation rejects OCR/name-only substitutes and changed images in either provider protocol', () => {
  const data = Buffer.from('pixels'), hash = visualHash(data)
  expect(() => assertVisualRequest(JSON.stringify({ messages: [{ content: [{ type: 'text', text: 'screen.png OCR: all good' }] }] }), hash)).toThrow('MISSING')
  expect(assertVisualRequest(JSON.stringify({ messages: [{ content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${data.toString('base64')}` } }] }] }), hash)).toMatch(/^[a-f0-9]{64}$/)
  expect(() => assertVisualRequest(JSON.stringify({ messages: [{ content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from('different').toString('base64') } }] }] }), hash)).toThrow('CHANGED')
})
it('normal production automatically runs C/V, repairs a V finding and reviews the repaired GUI candidate before delivery', async () => {
  const { enterDesktopLine } = await import('../../../main/desktop/desktop-route')
  const { findProject } = await import('../../../main/project/project-service')
  const { route, env } = register()
  let step = 0
  const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `a-${step}-${name}`, name, input })
  const query: SDKQuery = async function* (prompt, options) {
    if (options.sessionId !== parent) { yield* route(prompt, options); return }
    const finding = readQualityLedger(project.project_id).findings.find(f => f.review_kind === 'visual')
    let content
    switch (step++) {
      case 2: content = [use('check_quality_finding', { finding_id: finding!.id, case_name: 'total' })]; break
      case 3: reportFinding = false; content = [use('read_file', { path: 'index.html' }), use('write_file', { path: 'index.html', content: html(false) })]; break
      case 4: content = [use('check_quality_finding', { finding_id: finding!.id, case_name: 'total' })]; break
      default: content = [{ type: 'text' as const, text: '当前候选已保留，请按当前图像和台账核对。' }]
    }
    yield { type: 'assistant', message: { role: 'assistant', content } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: parent, requestId: 'visual-r', content: '完成已确认器材件数界面', maxTokens: 4096, signal: AbortSignal.timeout(150000) }, query, env,
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  const ledger = readQualityLedger(project.project_id)
  expect(findProject(project.project_id).desktop_blocked, JSON.stringify({ step, ledger })).toBeUndefined()
  expect(findProject(project.project_id).status).toBe('completed')
  expect(ledger.reviews.filter(r => r.status === 'complete').map(r => r.kind)).toEqual(['code', 'visual', 'code', 'visual'])
  expect(ledger.findings[0].checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(leanBudget(project.project_id, 'desktop-implement').snapshot().requests).toBe(step + wireBodies.length + 4)
  const artifacts = join(process.cwd(), 'run-artifacts', 'q2-visual'); mkdirSync(artifacts, { recursive: true })
  writeFileSync(join(artifacts, 'production-ledger.json'), JSON.stringify(ledger, null, 2))
  // A real verified baseline, not selector fixture metadata: only cosmetic CSS
  // changes select V, then an unchanged candidate selects no automatic agents.
  let styleCalls=0
  const beforeWire=wireBodies.length,beforeReviews=ledger.reviews.length
  const styleQuery:SDKQuery=async function*(prompt,options){
    if(options.sessionId!==parent){yield*route(prompt,options);return}
    const call=styleCalls++
    const content=call===0?[use('read_file',{path:'theme.css'}),use('write_file',{path:'theme.css',content:'p { color: #236; padding: 8px; }'})]
      :call===1?[use('check_quality_finding',{finding_id:ledger.findings[0].id,case_name:'total'})]:[{type:'text' as const,text:'样式已调整，旧缺陷已由宿主复测，请按当前候选选择协作。'}]
    yield{type:'assistant',message:{role:'assistant',content}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  }
  await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'style',content:'只调整现有颜色和间距',maxTokens:4096,signal:AbortSignal.timeout(120000)},styleQuery,env,{publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  const styled=readQualityLedger(project.project_id)
  expect(findProject(project.project_id).status,JSON.stringify(findProject(project.project_id).desktop_blocked)).toBe('completed')
  expect(styled.reviews.slice(beforeReviews).map(r=>r.kind)).toEqual(['visual'])
  expect(styled.collaboration?.at(-1)).toMatchObject({risk:'visual_only',required:['visual']})
  expect((await activeSoftwareRelease(project.project_id))?.verified?.collaboration_id).toBe(styled.collaboration?.at(-1)?.id)
  expect(leanBudget(project.project_id,'desktop-implement').snapshot().requests).toBe(styleCalls+wireBodies.length-beforeWire)
  const stableWire=wireBodies.length,stableReviews=styled.reviews.length;let unchangedCalls=0
  const unchanged:SDKQuery=async function*(_prompt,options){unchangedCalls++;expect(options.sessionId).toBe(parent);yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'保留当前实现，只核对宿主结果。'}]}};yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}}
  await enterDesktopLine({projectId:project.project_id,sessionId:parent,requestId:'unchanged',content:'重新核对当前实现，不修改',maxTokens:4096,signal:AbortSignal.timeout(90000)},unchanged,env,{publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}})
  const stable=readQualityLedger(project.project_id)
  expect(findProject(project.project_id).status,JSON.stringify(findProject(project.project_id).desktop_blocked)).toBe('completed')
  expect(stable.collaboration?.at(-1)).toMatchObject({risk:'unchanged',required:[]})
  expect(unchangedCalls).toBe(1);expect(wireBodies.length).toBe(stableWire);expect(stable.reviews.length).toBe(stableReviews)
  const evidence=join(process.cwd(),'run-artifacts','q4-selection');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'production-ledger.json'),JSON.stringify(stable,null,2))

}, 180000)
it('production stops on the first actual image rejection without retrying V or changing route', async () => {
  const { enterDesktopLine } = await import('../../../main/desktop/desktop-route')
  const { findProject } = await import('../../../main/project/project-service')
  rejectImages = true
  const { route, env } = register(); let parentCalls = 0
  const query: SDKQuery = async function* (prompt, options) {
    if (options.sessionId !== parent) { yield* route(prompt, options); return }
    parentCalls++
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '稳定候选请按宿主质量门核对。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: parent, requestId: 'visual-r', content: '核对已确认界面', maxTokens: 4096, signal: AbortSignal.timeout(60000) }, query, env,
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(parentCalls).toBe(2)
  expect(wireBodies).toHaveLength(2)
  expect(leanBudget(project.project_id, 'desktop-implement').snapshot().requests).toBe(6)
  expect(readQualityLedger(project.project_id).reviews.filter(r => r.kind === 'visual')).toHaveLength(1)
  expect(findProject(project.project_id).desktop_blocked?.note).toContain('QUALITY_VISUAL_MODEL_UNSUPPORTED')
  expect(findProject(project.project_id).status).toBe('active')
}, 90000)

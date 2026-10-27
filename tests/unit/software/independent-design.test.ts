import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createProject, updateProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { prepareIndependentDesign, readIndependentDesign, type IndependentDesignPolicy, parseIndependentCases } from '../../../main/software/independent-design'
import { independentSuite, verifyIndependentDesign } from '../../../main/software/independent-verification'
import { prepareSoftwareRelease } from '../../../main/software/release-store'
import { leanBudget } from '../../../main/desktop/lean-budget'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'

let home:string,old:string|undefined,project:ReturnType<typeof createProject>,policy:IndependentDesignPolicy,calls:number
const contract={cases:[{id:'save',feature:'F-001',steps:[{kind:'fill',control:'name',value:'Alice'},{kind:'click',control:'save'},{kind:'expect',control:'result',equals:'Alice'}]}]}
const route=()=>({channel_id:'b',model:'model-b',env:{ANTHROPIC_BASE_URL:'https://b.invalid',ANTHROPIC_MODEL:'model-b'}})
const query:SDKQuery=async function*(prompt,options){calls++;expect(prompt).not.toContain('IMPLEMENTATION_SENTINEL');expect(options.env.ANTHROPIC_MODEL).toBe('model-b');expect(options.tools).toBeUndefined()
  expect(options.accounting?.role).toBe('acceptance_designer')
  options.requestGuard?.({url:'https://b.invalid/v1/messages',body:JSON.stringify({model:'model-b',max_tokens:1024})})
  yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(contract)}]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:100,output_tokens:100}}
}
function input(q=query){return{projectId:project.project_id,sessionId:'s',query:q,primaryEnv:{ANTHROPIC_MODEL:'model-a'},signal:new AbortController().signal,resolveRoute:route}}
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-independent-'));process.env.PROMA_HOME=home;calls=0
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'保存姓名',ui:'required',delivery:'browser',requirements:[{description:'保存姓名',expected:'保存Alice显示Alice'}]}),{projectId:project.project_id,sessionId:'s',source:'姓名',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip';syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const brief=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(brief);updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  mkdirSync(join(home,'software-independent-design'),{recursive:true})
  const money=join(home,'money.json');writeFileSync(money,JSON.stringify({version:1,models:[{host:'b.invalid',model:'model-b',cap_rmb:1,context_tokens:2048,input_rmb_per_million:1,output_rmb_per_million:1,cache_rmb_per_million:0}]}))
  const hash=createHash('sha256').update(readFileSync(money)).digest('hex');writeFileSync(money+'.state.json',JSON.stringify({version:1,policy_hash:hash,entries:[]}))
  const auth=join(home,'authorization.json');writeFileSync(auth,JSON.stringify({source:'direct_user_confirmation',project_id:project.project_id,operation_id:findProject(project.project_id).lean_operation_id??'initial',host:'b.invalid',model:'model-b',cap_rmb:1,policy_sha256:hash}))
  policy={version:1,enabled:true,channel_id:'b',model:'model-b',monetary_policy_path:money,authorization_path:auth,max_tokens:1024,timeout_ms:2000}
  writeFileSync(join(project.root_path,'implementation.cjs'),'IMPLEMENTATION_SENTINEL')
})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
function enable(){writeFileSync(join(home,'software-independent-design/policy.json'),JSON.stringify(policy))}
it('defaults to explicit single-model mode with zero calls',async()=>{expect((await prepareIndependentDesign(input())).status).toBe('disabled');expect(calls).toBe(0);expect(readIndependentDesign(project.project_id)).toBeUndefined()})
it('blocks the real production entry before implementer calls when required B capability is missing',async()=>{
  enable();const model=vi.fn(async function*(){throw Error('must not call implementer')})
  await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'r',content:'按已确认目标制作',maxTokens:1024,signal:AbortSignal.timeout(30000)},model,{ANTHROPIC_MODEL:'model-a'},
    {publish:vi.fn(),persistAssistant:vi.fn(),persistSystem:vi.fn(),complete:vi.fn()})
  expect(model).not.toHaveBeenCalled();expect(findProject(project.project_id).desktop_blocked?.note).toContain('INDEPENDENT_CAPABILITY_MISSING')
})
it('routes one bounded no-tools design before implementation, freezes business values and reuses them without another model call',async()=>{
  enable();const first=await prepareIndependentDesign(input());expect(first.status,first.reason).toBe('frozen');expect(first.contract).toEqual(contract)
  expect((await prepareIndependentDesign(input())).digest).toBe(first.digest);expect(calls).toBe(1)
  expect(leanBudget(project.project_id,'acceptance-design').snapshot()).toMatchObject({requests:1,phases:{'acceptance-design':1}})
  writeFileSync(join(project.root_path,'INDEPENDENT_ADAPTER.json'),JSON.stringify({version:1,design_digest:first.digest,controls:{name:'#name',save:'#save',result:'#result'}}))
  expect(independentSuite(project.project_id,project.root_path).steps.at(-1)).toMatchObject({kind:'expect',equals:'Alice'})
  writeFileSync(join(project.root_path,'INDEPENDENT_ADAPTER.json'),JSON.stringify({version:1,design_digest:first.digest,controls:{name:'#name',save:'#save',result:'#result'},equals:'Wrong'}))
  expect(()=>independentSuite(project.project_id,project.root_path)).toThrow('ADAPTER_INVALID')
})
it.each(['missing-route','same-model','missing-budget','wrong-route'] as const)('blocks %s before any provider request',async kind=>{
  enable();const value=input()
  if(kind==='missing-route')value.resolveRoute=()=>{throw Error('INDEPENDENT_CAPABILITY_MISSING')}
  if(kind==='same-model')value.primaryEnv.ANTHROPIC_MODEL='model-b'
  if(kind==='missing-budget')rmSync(policy.authorization_path)
  if(kind==='wrong-route')value.resolveRoute=()=>({...route(),channel_id:'a'})
  expect((await prepareIndependentDesign(value)).status).toBe('blocked');expect(calls).toBe(0)
})
it('bounds timeouts and never silently retries an interrupted design under the same authorization',async()=>{
  policy.timeout_ms=100;enable();const never=vi.fn(async function*(){calls++;await new Promise<void>(()=>{})}) as SDKQuery
  const result=await prepareIndependentDesign(input(never));expect(result.status).toBe('blocked');expect(result.reason).toContain('TIMEOUT')
  expect((await prepareIndependentDesign(input())).reason).toContain('NEW_AUTHORIZATION');expect(calls).toBe(1)
})
it('blocks a nominal remainder which cannot fund the complete input reserve before calling B',async()=>{
  const file=policy.monetary_policy_path,money=JSON.parse(readFileSync(file,'utf8'));money.models[0].cap_rmb=.001
  writeFileSync(file,JSON.stringify(money));const hash=createHash('sha256').update(readFileSync(file)).digest('hex')
  writeFileSync(file+'.state.json',JSON.stringify({version:1,policy_hash:hash,entries:[]}))
  const proof=JSON.parse(readFileSync(policy.authorization_path,'utf8'));proof.policy_sha256=hash;proof.cap_rmb=.001;writeFileSync(policy.authorization_path,JSON.stringify(proof));enable()
  expect((await prepareIndependentDesign(input())).reason).toContain('COMPLETE_INPUT_RESERVE');expect(calls).toBe(0)
})
it('reads the confirmed UX relative to the project without exposing implementation files',async()=>{
  const brief=readPrdBackplane(project.project_id);delete brief.lean_brief!.preview
  syncDocuments({request_id:'ux',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},brief)
  const confirmed=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(confirmed),html='<h1>ConfirmedPage</h1>',hash=createHash('sha256').update(html).digest('hex')
  mkdirSync(join(project.root_path,'00_UX'),{recursive:true});writeFileSync(join(project.root_path,'00_UX/confirmed.html'),html)
  writeFileSync(join(project.root_path,'00_UX/confirmed.json'),JSON.stringify({version:2,mode:'lean',scope_hash:scope,html_hash:hash}))
  updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:hash,html_hash:hash}});enable()
  const captured:SDKQuery=async function*(prompt,options){expect(prompt).toContain('ConfirmedPage');yield* query(prompt,options)}
  const result=await prepareIndependentDesign(input(captured));expect(result.status,result.reason).toBe('frozen')
})
it('rejects model-written PASS, missing assertions, unknown features and executable/changed step parameters',()=>{
  for(const value of [{status:'passed'},{cases:[{id:'a',feature:'F-099',steps:contract.cases[0].steps}]},{cases:[{id:'a',feature:'F-001',steps:[{kind:'click',control:'save'}]}]},
    {cases:[{...contract.cases[0],steps:[...contract.cases[0].steps,{kind:'evaluate',script:'PASS'}]}]}])expect(()=>parseIndependentCases(JSON.stringify(value),['F-001'])).toThrow()
})
it('rejects cancelled preparation and damaged frozen design without resurrecting a frozen result',async()=>{
  enable();const value=input();const controller=new AbortController();controller.abort();value.signal=controller.signal
  expect((await prepareIndependentDesign(value)).status).toBe('blocked');expect(calls).toBe(0)
  const frozen=await prepareIndependentDesign(input());expect(frozen.status,frozen.reason).toBe('frozen')
  const file=join(home,'software-independent-design',project.project_id,'current.json'),record=JSON.parse(readFileSync(file,'utf8'))
  record.contract.cases[0].steps[2].equals='Wrong';writeFileSync(file,JSON.stringify(record))
  expect((await prepareIndependentDesign(input())).status).toBe('blocked');expect(()=>readIndependentDesign(project.project_id)).toThrow('FROZEN_BYTES_CHANGED')
})
it('executes frozen B business values through an actual browser and rejects a product defect without accepting revised adapter expectations',async()=>{
  enable();const design=await prepareIndependentDesign(input());expect(design.status).toBe('frozen')
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port');await new Promise<void>(done=>server.close(()=>done()))
  const root=project.root_path
  writeFileSync(join(root,'server.cjs'),`require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(require('fs').readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1')`)
  const html=`<input id="name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button><output id="result"></output>`
  writeFileSync(join(root,'index.html'),html);writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs',String(address.port)],url:`http://127.0.0.1:${address.port}`}))
  writeFileSync(join(root,'INDEPENDENT_ADAPTER.json'),JSON.stringify({version:1,design_digest:design.digest,controls:{name:'#name',save:'#save',result:'#result'}}))
  const positive=await verifyIndependentDesign(project.project_id,await prepareSoftwareRelease(project.project_id,root),AbortSignal.timeout(45000));expect(positive.status,JSON.stringify(positive)).toBe('passed')
  writeFileSync(join(root,'index.html'),html.replace('.value"',`.value+'Wrong'"`))
  expect((await verifyIndependentDesign(project.project_id,await prepareSoftwareRelease(project.project_id,root),AbortSignal.timeout(45000))).status).toBe('failed')
},90000)

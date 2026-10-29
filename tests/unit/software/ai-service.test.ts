import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs'
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {runHostLlmProbe} from '../../../main/desktop/llm-verification'
import {prepareSoftwareRelease,validateSoftwareRelease} from '../../../main/software/release-store'
const require=createRequire(import.meta.url),{AIService}=require('../../../main/templates/tools/ai_service.cjs')
const {createSecretStore}=require('../../../main/templates/tools/ai_secrets.cjs')
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-ai-service-'));process.env.PROMA_HOME=home;project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const ctx=()=>({projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(45000),state:createToolState()})
const tools=()=>buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
async function prepare(){const result=await tools().find(t=>t.name==='prepare_software_capability')!.execute({capability:'ai'},ctx());expect(result.isError,result.output).not.toBe(true);return JSON.parse(result.output)}
it('materializes a reusable service, preserves editable public routes and blocks secrets in route files without overwriting them',async()=>{
 const first=await prepare();expect(first).toMatchObject({status:'prepared',external_effects:'unverified',runtime:{settings:{routes:[{configured:false}]}}})
 const file=join(project.root_path,'AI_SERVICE.template.json'),routes=JSON.parse(readFileSync(file,'utf8'));routes.routes.default.endpoint='https://api.example.test/v1';routes.routes.default.model='chosen-model';writeFileSync(file,JSON.stringify(routes))
 expect((await prepare()).runtime.settings.routes[0].configured).toBe(true);expect(JSON.parse(readFileSync(file,'utf8')).routes.default.model).toBe('chosen-model')
 routes.routes.default.api_key='PRIVATE_ROUTE_SECRET';writeFileSync(file,JSON.stringify(routes))
 const bad=await tools().find(t=>t.name==='prepare_software_capability')!.execute({capability:'ai'},ctx());expect(bad.isError).toBe(true);expect(bad.output).not.toContain('PRIVATE_ROUTE_SECRET');expect(readFileSync(file,'utf8')).toContain('PRIVATE_ROUTE_SECRET')
})
it.each([{protocol:'openai-chat',vision:false},{protocol:'openai-chat',vision:true},{protocol:'anthropic-messages',vision:false},{protocol:'anthropic-messages',vision:true}] as const)('uses actual frozen product entry for $protocol (vision=$vision) and verifies protocol identity',async({protocol,vision})=>{
 await prepare();writeFileSync(join(project.root_path,'app.cjs'),'console.log("AI service fixture")');writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}))
 const candidate=await prepareSoftwareRelease(project.project_id,project.root_path)
 const report=await runHostLlmProbe(candidate.root,{runtime:'node',module:'ai_service.cjs',factory:'AIService',method:'generate',protocol,...(vision?{input:'vision' as const}:{}),covers:['F-001']},undefined,ctx().signal,project.project_id)
 expect(report.status,JSON.stringify(report)).toBe('passed');expect(report.protocol).toBe(protocol);expect(report.request_count).toBe(vision?6:5);await validateSoftwareRelease(project.project_id,candidate)
},45000)
it('routes through product settings and runtime keys, supports key rotation/reopen, and rejects invalid settings rather than using a stale route',async()=>{
 const calls:any[]=[],server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls.push({path:req.url,auth:req.headers.authorization,key:req.headers['x-api-key'],version:req.headers['anthropic-version'],body});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url?.endsWith('/messages')?{content:[{type:'text',text:'anthropic local answer'}]}:{choices:[{message:{content:'openai local answer'}}]}))})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port')
 const data=join(home,'app-data');mkdirSync(data)
 const route=(protocol:string,key:string)=>({protocol,endpoint:`http://127.0.0.1:${address.port}/v1`,model:protocol+'-model',api_key_env:key,network:'loopback',timeout:2,max_tokens:512})
 const config={version:1,default_route:'text',routes:{text:route('openai-chat','APP_TEXT_KEY'),image:route('anthropic-messages','APP_IMAGE_KEY')}}
 const file=join(data,'ai-service.json');writeFileSync(file,JSON.stringify(config))
 const keys:Record<string,string>={APP_TEXT_KEY:'product-first-key',APP_IMAGE_KEY:'product-image-key'},client=new AIService({resolveKey:(name:string)=>keys[name]})
 try{
  expect(await client.generate({prompt:'中文问题',dataDir:data})).toMatchObject({ok:true,text:'openai local answer'})
  keys.APP_TEXT_KEY='product-rotated-key';expect((await new AIService({resolveKey:(name:string)=>keys[name]}).generate({prompt:'重开',dataDir:data})).ok).toBe(true)
  expect(await client.generate({route:'image',prompt:'协议测试',system:'产品系统说明',dataDir:data})).toMatchObject({ok:true,text:'anthropic local answer'})
  expect(calls.map(row=>row.path)).toEqual(['/v1/chat/completions','/v1/chat/completions','/v1/messages']);expect(calls[1].auth).toBe('Bearer product-rotated-key');expect(calls[2].key).toBe('product-image-key');expect(calls[2].body.system).toBe('产品系统说明')
  expect(JSON.stringify(client.settings(data))).not.toContain('product-rotated-key');expect(readFileSync(file,'utf8')).not.toContain('product-first-key')
  expect(await client.generate({route:'missing',prompt:'x',dataDir:data})).toMatchObject({ok:false,kind:'unconfigured'})
  expect(await client.generate({route:'constructor',prompt:'x',dataDir:data})).toMatchObject({ok:false,kind:'unconfigured'})
  expect(await client.generate({prompt:'x',config:{...config.routes.text,api_key:'local-key',provider:'mock'}})).toMatchObject({ok:false,diagnostic_code:'AI_PROVIDER_UNSUPPORTED'})
  writeFileSync(file,JSON.stringify({...config,routes:{...config.routes,text:{...config.routes.text,api_key:'PRIVATE_INLINE_KEY'}}}));expect((await client.generate({prompt:'x',dataDir:data})).ok).toBe(false)
  expect(calls).toHaveLength(3)
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
})
it('saves public settings atomically with a revision and keeps caller-encrypted product keys separate across reopen',()=>{
 const data=join(home,'settings');mkdirSync(data)
 const service=new AIService(),before=service.settings(data),config={version:1,default_route:'default',routes:{default:{protocol:'openai-chat',endpoint:'https://api.example.test/v1',model:'configured-model',api_key_env:'APP_AI_API_KEY'}}}
 const saved=service.saveSettings(data,config,before.revision);expect(saved.revision).not.toBe(before.revision)
 expect(()=>service.saveSettings(data,{...config,default_route:'default'},before.revision)).toThrow('STALE')
 expect(service.settings(data).revision).toBe(saved.revision);expect(existsSync(join(data,'.ai-settings.lock'))).toBe(false)
 expect(()=>createSecretStore({dataDir:data})).toThrow('CODEC_REQUIRED')
 const encryptionKey=randomBytes(32)
 const codec={dataDir:data,encrypt:(plain:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',encryptionKey,iv),encrypted=Buffer.concat([cipher.update(plain,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),encrypted])},decrypt:(bytes:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',encryptionKey,bytes.subarray(0,12));cipher.setAuthTag(bytes.subarray(12,28));return Buffer.concat([cipher.update(bytes.subarray(28)),cipher.final()]).toString('utf8')}}
 const store=createSecretStore(codec);store.set('APP_AI_API_KEY','PRODUCT_SECRET_VALUE_7263');expect(createSecretStore(codec).get('APP_AI_API_KEY')).toBe('PRODUCT_SECRET_VALUE_7263')
 expect(readFileSync(join(data,'.ai-secrets/APP_AI_API_KEY.bin')).includes(Buffer.from('PRODUCT_SECRET_VALUE_7263'))).toBe(false)
 expect(readFileSync(join(data,'ai-service.json'),'utf8')).not.toContain('PRODUCT_SECRET_VALUE_7263');expect(JSON.stringify(service.settings(data))).not.toContain('PRODUCT_SECRET_VALUE_7263')
 const invalid=createSecretStore({...codec,encrypt:(plain:string)=>Buffer.from(plain)})
 expect(()=>invalid.set('APP_AI_API_KEY','replacement-secret')).toThrow('ENCODE_FAILED');expect(store.get('APP_AI_API_KEY')).toBe('PRODUCT_SECRET_VALUE_7263')
})

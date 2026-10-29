import {createRequire} from 'node:module'
import {mkdtempSync,readFileSync,writeFileSync,rmSync,readdirSync,copyFileSync,mkdirSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {randomBytes,createCipheriv,createDecipheriv} from 'node:crypto'
import {createServer} from 'node:http'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {componentContracts,componentSource,SETTINGS_FILES} from '../../../main/software/component-contracts'
import {inspectIntegrationCapability,prepareIntegrationCapability,INTEGRATION_COMPONENTS} from '../../../main/software/integration-capabilities'
import {prepareDocumentCapability} from '../../../main/software/document-capability'
import {createProject} from '../../../main/project/project-service'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
const require=createRequire(import.meta.url)
let root:string,data:string,backend:any,codec:any
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'product-settings-'));data=join(root,'data');mkdirSync(data)
 for(const file of INTEGRATION_COMPONENTS['product-settings'])copyFileSync(componentSource(file),join(root,file))
 const key=randomBytes(32)
 codec={isEncryptionAvailable:()=>true,encryptString:(value:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(value,'utf8'),cipher.final(),cipher.getAuthTag()])},decryptString:(value:Buffer)=>{const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(-16));return Buffer.concat([decipher.update(value.subarray(12,-16)),decipher.final()]).toString('utf8')}}
 backend=require(join(root,'product_settings.cjs')).createProductSettings({dataDir:data,safeStorage:codec})
})
afterEach(()=>rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}))
function config(endpoint='https://api.example.test/v1',network='public') {return{version:1,default_route:'default',routes:{default:{protocol:'openai-chat',endpoint,model:'model',api_key_env:'APP_AI_API_KEY',network}}}}
it('prepares and inspects settings through the actual Agent tool, preserves public configuration and refuses edited code',async()=>{
 const previous=process.env.PROMA_HOME;process.env.PROMA_HOME=join(root,'home')
 try{
  const project=createProject({request_id:'settings',mode:'quick'},{workflowVersion:'software-v1'})
  const tools=buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
  const ctx={projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(30000),state:createToolState()}
  const prepare=()=>tools.find(t=>t.name==='prepare_software_capability')!.execute({capability:'product-settings'},ctx)
  const first=await prepare();expect(first.isError,first.output).not.toBe(true)
  expect(JSON.parse(first.output)).toMatchObject({status:'prepared',contract:{id:'product-settings',contract_version:1},product_verification:'unverified'})
  const file=join(project.root_path,'AI_SERVICE.template.json');writeFileSync(file,JSON.stringify(config()))
  expect((await prepare()).isError).not.toBe(true);expect(JSON.parse(readFileSync(file,'utf8')).routes.default.model).toBe('model')
  const inspected=await tools.find(t=>t.name==='inspect_software_capabilities')!.execute({capability:'product-settings'},ctx)
  expect(JSON.parse(inspected.output).contract.files).toHaveLength(11)
  writeFileSync(join(project.root_path,'product_settings_ui.js'),'user UI')
  expect((await prepare()).isError).toBe(true);expect(readFileSync(join(project.root_path,'product_settings_ui.js'),'utf8')).toBe('user UI')
 }finally{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous}
})
it('discovers consistent content-bound contracts and preserves config / rejects code conflicts for AI, HTTP and documents',async()=>{
 for(const item of componentContracts()){
  expect(item?.source_revision).toMatch(/^[a-f0-9]{64}$/);expect(item?.files.every(file=>file.sha256.length===64)).toBe(true)
  expect(item?.verification.external).toBe('unverified')
 }
 const signal=AbortSignal.timeout(30000)
 // Inspect a missing project without executing anything.
 const empty=join(root,'empty');mkdirSync(empty)
 for(const kind of ['ai','http'] as const){const report=await inspectIntegrationCapability('unused',empty,kind,signal);expect(report.contract?.id).toBe(kind);expect(report.ready).toBe(false)
  writeFileSync(join(empty,INTEGRATION_COMPONENTS[kind][0]),'user code')
  await expect(prepareIntegrationCapability('unused',empty,kind,signal)).rejects.toThrow('CONFLICT');expect(readFileSync(join(empty,INTEGRATION_COMPONENTS[kind][0]),'utf8')).toBe('user code')
 }
 writeFileSync(join(empty,'document_runtime.cjs'),'user document code')
 await expect(prepareDocumentCapability('unused',empty,signal)).rejects.toThrow('CONFLICT')
 expect(SETTINGS_FILES.length).toBe(6)
})
it('saves and reopens public routes and encrypted keys without returning keys; stale form cannot rotate keys',async()=>{
 const initial=backend.read(),saved=backend.save({config:config(),revision:initial.settings.revision,keys:{default:'private-product-key'}})
 expect(saved.routes).toEqual([{name:'default',key_available:true}]);expect(saved.connection.kind).toBe('not_checked')
 expect(JSON.stringify(saved)).not.toContain('private-product-key')
 const reopened=require(join(root,'product_settings.cjs')).createProductSettings({dataDir:data,safeStorage:codec})
 expect(reopened.read().settings.revision).toBe(saved.settings.revision)
 expect(()=>backend.save({config:config(),revision:initial.settings.revision,keys:{default:'replacement'}})).toThrow('STALE')
 const files=readdirSync(join(data,'.ai-secrets'));expect(files).toHaveLength(1)
 expect(readFileSync(join(data,'.ai-secrets',files[0])).includes(Buffer.from('private-product-key'))).toBe(false)
 expect(JSON.stringify(reopened.read())).not.toContain('private-product-key')
})
it('rolls back staged credentials on public write failure, keeps the old pair and maps errors without leaking inputs',async()=>{
 const saved=backend.save({config:config(),revision:backend.read().settings.revision,keys:{default:'old-secret'}})
 writeFileSync(join(data,'.ai-settings.lock'),'other owner')
 const {dispatchSettings}=require(join(root,'product_settings.cjs'))
 const result=await dispatchSettings(backend,'save',{config:config(),revision:saved.settings.revision,keys:{default:'new-secret'}})
 expect(result).toEqual({ok:false,code:'SETTINGS_OPERATION_FAILED'});expect(readdirSync(join(data,'.ai-secrets'))).toHaveLength(1)
 expect(backend.read().settings.revision).toBe(saved.settings.revision)
 expect(await dispatchSettings(backend,'ai',{})).toMatchObject({ok:false})
})
it('refuses plaintext/basic_text or missing OS encryption and validates settings before writing any key',()=>{
 for(const safeStorage of [undefined,{...codec,isEncryptionAvailable:()=>false},{...codec,getSelectedStorageBackend:()=> 'basic_text'}]){
  const service=require(join(root,'product_settings.cjs')).createProductSettings({dataDir:data,safeStorage})
  expect(service.read().encryption).toBe('unavailable')
  expect(()=>service.save({config:config(),revision:service.read().settings.revision,keys:{default:'never-write'}})).toThrow('ENCRYPTION_UNAVAILABLE')
 }
 expect(readdirSync(data)).toEqual([])
 expect(()=>backend.save({config:{...config(),api_key:'hidden'},revision:backend.read().settings.revision,keys:{default:'never-write'}})).toThrow('INVALID')
 expect(readdirSync(join(data,'.ai-secrets'))).toEqual([])
})
it('requires explicit consent, checks only saved route, cancels in-flight calls and never returns model text',async()=>{
 let calls=0,started:()=>void=()=>{},slow=false
 const server=createServer(async(req,res)=>{for await(const _ of req){}calls++;started();res.setHeader('Content-Type','application/json');if(!slow)res.end(JSON.stringify({choices:[{message:{content:'PRIVATE_MODEL_BODY'}}]}))})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address() as {port:number}
 try{
  const saved=backend.save({config:config(`http://127.0.0.1:${address.port}/v1`,'loopback'),revision:backend.read().settings.revision,keys:{default:'local-test-key'}})
  await expect(backend.check({revision:saved.settings.revision,route:'default'})).rejects.toThrow('CONSENT');expect(calls).toBe(0)
  expect(await backend.check({revision:saved.settings.revision,route:'default',consent:true})).toMatchObject({kind:'connected',scope:'connection_only'})
  expect(JSON.stringify(backend.read())).not.toContain('PRIVATE_MODEL_BODY')
  slow=true;const observed=new Promise<void>(done=>{started=done}),pending=backend.check({revision:saved.settings.revision,route:'default',consent:true})
  await observed;backend.cancel();expect((await pending).kind).toBe('cancelled');expect(calls).toBe(2)
  const changed=config();changed.routes.default.model='changed'
  backend.save({config:changed,revision:saved.settings.revision});expect(backend.read().connection.kind).toBe('not_checked')
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
})

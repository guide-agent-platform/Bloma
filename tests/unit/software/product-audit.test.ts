import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readdirSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createCipheriv,createDecipheriv,randomBytes,createHash} from 'node:crypto'
import {createServer,type Server} from 'node:http'
import {spawn} from 'node:child_process'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
const require=createRequire(import.meta.url),fs=require('node:fs')
let root:string,server:Server|undefined,queue:any,workbench:any
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'bloma-product-audit-'))
 for(const folder of readdirSync(resolve('main/templates/components')))for(const file of readdirSync(resolve('main/templates/components',folder)))copyFileSync(resolve('main/templates/components',folder,file),join(root,file))
 for(const name of ['AI_SERVICE.template.json','ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','http_connector.cjs','webhook_inbox.cjs'])copyFileSync(resolve('main/templates/tools',name),join(root,name))
})
afterEach(async()=>{vi.restoreAllMocks();if(queue)await queue.close({timeoutMs:100});queue=undefined;if(workbench)await workbench.close();workbench=undefined;if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));server=undefined}rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
async function until(fn:()=>boolean){const end=Date.now()+3000;while(!fn()){if(Date.now()>end)throw Error('WAIT_TIMEOUT');await new Promise(done=>setTimeout(done,5))}}
function codec(){const key=randomBytes(32);return{isEncryptionAvailable:()=>true,encryptString:(text:string)=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);return Buffer.concat([iv,cipher.update(text),cipher.final(),cipher.getAuthTag()])},decryptString:(data:Buffer)=>{const cipher=createDecipheriv('aes-256-gcm',key,data.subarray(0,12));cipher.setAuthTag(data.subarray(-16));return Buffer.concat([cipher.update(data.subarray(12,-16)),cipher.final()]).toString('utf8')}}}
const config=(baseUrl:string)=>({name:'audit',baseUrl,network:'loopback',readPath:'items',writePath:'items',writeMethod:'POST',itemsPath:'items',nextPath:'next',cursorParam:'cursor',idPath:'id',versionPath:'version',mapping:{title:'title'}})
async function service(handler:(req:any,res:any)=>void){server=createServer(handler);await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));return`http://127.0.0.1:${(server.address() as {port:number}).port}/`}
it.each(['ai','connection'])('retains the newly referenced %s secret when public commit succeeds but lock cleanup fails',async kind=>{
 const storage=codec(),data=join(root,'data');mkdirSync(data)
 const original=fs.unlinkSync
 vi.spyOn(fs,'unlinkSync').mockImplementation((file:any)=>{if(String(file).endsWith(kind==='ai'?'.ai-settings.lock':'connections.json.lock'))throw Object.assign(Error('INJECTED_CLEANUP_FAILURE'),{code:'EACCES'});return original(file)})
 let secretName:string
 if(kind==='ai'){
  const {createProductSettings}=require(join(root,'product_settings.cjs')),backend=createProductSettings({dataDir:data,safeStorage:storage}),before=backend.read()
  try{backend.save({revision:before.settings.revision,config:{version:1,default_route:'default',routes:{default:{protocol:'openai-chat',endpoint:'https://example.test/v1',model:'model',api_key_env:'APP_KEY'}}},keys:{default:'NEW_PRODUCT_AUDIT_KEY'}})}catch{}
  secretName=backend.read().settings.routes[0].api_key_env
 }else{
  workbench=require(join(root,'product_workbench.cjs')).createWorkbench({dataDir:data,safeStorage:storage,dialog:{},nativeImage:{}})
  await workbench.dispatch('saveConnection',{id:'audit',revision:0,entityRevision:0,config:config('http://127.0.0.1:9/'),key:'NEW_PRODUCT_AUDIT_KEY'})
  secretName=(await workbench.dispatch('status')).value.connections.records.audit.data.secret_name
 }
 const secrets=require(join(root,'ai_secrets.cjs')).createSecretStore({dataDir:data,encrypt:storage.encryptString,decrypt:storage.decryptString})
 expect(secrets.get(secretName)).toBe('NEW_PRODUCT_AUDIT_KEY')
})
it('bounds close for a noncooperative handler, keeps ownership until drained and rejects late writes',async()=>{
 let finish:()=>void=()=>{},context:any
 queue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers:{hold:async(_:any,ctx:any)=>{context=ctx;await new Promise<void>(done=>finish=done);ctx.progress(.9);return 'late'}}})
 const job=queue.enqueue({type:'hold',dedupeKey:'hold'});await until(()=>queue.list()[0].state==='running')
 const closing=queue.close({timeoutMs:30}),result=await Promise.race([closing,new Promise<any>(done=>setTimeout(()=>done({test_timeout:true}),150))])
 expect(fs.existsSync(join(root,'.jobs-owner.lock'))).toBe(true)
 finish();await closing
 expect(result.test_timeout).not.toBe(true);expect(result).toMatchObject({closed:false})
 expect(context.progress(.7)).toBe(false);expect(queue.list()[0]).toMatchObject({id:job.id,state:'interrupted',needs_review:true})
})
it('does not strand an active slot if persisting the running transition fails',async()=>{
 queue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers:{read:async()=> 'never'}})
 const original=fs.renameSync
 vi.spyOn(fs,'renameSync').mockImplementation((from:any,to:any)=>{if(String(to).endsWith('jobs.json')&&JSON.parse(readFileSync(from,'utf8')).records&&Object.values(JSON.parse(readFileSync(from,'utf8')).records).some((row:any)=>row.data.state==='running'))throw Object.assign(Error('INJECTED_WRITE_FAILURE'),{code:'EACCES'});return original(from,to)})
 queue.enqueue({type:'read',dedupeKey:'read'});await new Promise(done=>setTimeout(done,30))
 const closing=queue.close({timeoutMs:30}),result=await Promise.race([closing,new Promise<any>(done=>setTimeout(()=>done({test_timeout:true}),150))])
 vi.restoreAllMocks()
 // Let the old baseline's cleanup finish so the regression never leaves a hung test process.
 if(result.test_timeout){queue=undefined;throw Error('CLOSE_STRANDED_ACTIVE_SLOT')}
 expect(result).toMatchObject({closed:true})
})
it('does not reuse a successful old destination receipt after the connector write target changes',async()=>{
 const paths:string[]=[];const url=await service(async(req,res)=>{for await(const _ of req){}paths.push(req.url);res.setHeader('Content-Type','application/json');res.end('{"id":"ok"}')})
 const http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root});http.saveConnection({id:'api',revision:0,config:config(url)})
 const input={connectionId:'api',recordId:'source',sourceRevision:1,fields:{title:'A'}}
 expect((await http.submit(input)).ok).toBe(true)
 const before=http.settings();http.saveConnection({id:'api',revision:before.revision,entityRevision:before.records.api.revision,config:{...config(url),writePath:'new-items'}})
 expect((await http.submit(input)).ok).toBe(true);expect(paths).toEqual(['/items','/new-items'])
})
it('allows an explicit retry after a lost write is reconciled as definitely not applied',async()=>{
 let calls=0;const url=await service(async(req,res)=>{for await(const _ of req){}calls++;if(calls===1){req.socket.destroy();return}res.setHeader('Content-Type','application/json');res.end('{"id":"ok"}')})
 const http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root});http.saveConnection({id:'api',revision:0,config:config(url)})
 const input={connectionId:'api',recordId:'source',sourceRevision:1,fields:{title:'A'}},first=await http.submit(input)
 expect(first.kind).toBe('unknown');http.reconcile({operationId:first.operationId,revision:http.read().revision,state:'not_applied',remoteId:'operator checked destination'})
 expect(await http.submit(input)).toMatchObject({ok:true,kind:'done'});expect(calls).toBe(2)
 expect((await http.submit(input)).ok).toBe(true);expect(calls).toBe(2)
})
it('does not treat object key ordering as a conflicting same-version remote record',async()=>{
 let flipped=false;const url=await service((_,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({items:[{id:'a',version:1,title:flipped?{right:2,left:1}:{left:1,right:2}}],next:null}))})
 const http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root});http.saveConnection({id:'api',revision:0,config:config(url)})
 expect((await http.pull({connectionId:'api'})).ok).toBe(true);flipped=true;expect((await http.pull({connectionId:'api'})).ok).toBe(true)
})
it('fails closed on an unknown comparison variant instead of crashing or inventing a pair',()=>{
 const {analyzeEfficiency}=require(join(root,'product_efficiency.cjs')),protocol={version:1,status:'preregistered',scope:'real_services',tasks:[{id:'x',input_sha256:'a'.repeat(64),required_cases:['x']}],variants:{baseline:'v1',templates:'v2'},environment:'e',design:'d',model:'m',channel:'c',account_scope:'a',budget_rmb:10},protocol_id=createHash('sha256').update(JSON.stringify(protocol)).digest('hex')
 writeFileSync(join(root,'proof.txt'),'proof');const sample={protocol_id,task_id:'x',input_sha256:'a'.repeat(64),environment:'e',design:'d',model:'m',channel:'c',account_scope:'a',service_scope:'real',outcome:'delivered',independent_verification:true,cases:{x:'passed'},elapsed_ms:1,cost_rmb:1,physical_requests:1,user_interventions:0,failures:[],evidence:[{path:'proof.txt',sha256:createHash('sha256').update('proof').digest('hex')}]}
 const result=analyzeEfficiency(protocol,[{...sample,variant:'baseline',version:'v1'},{...sample,variant:'unknown'}],{evidenceRoot:root});expect(result.eligible).toBe(false);expect(result.pairs).toEqual([])
})
it('preserves old data when a migration replacement fails after the pre-migration backup is written',()=>{
 const {createDataStore}=require(join(root,'product_store.cjs')),one=createDataStore({dataDir:root});one.commit(0,[{id:'a',type:'note',expectedRevision:0,data:{value:1}}]);const before=readFileSync(join(root,'records.json'))
 const original=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((from:any,to:any)=>{if(String(to)===join(root,'records.json'))throw Object.assign(Error('INJECTED_DISK_FAILURE'),{code:'ENOSPC'});return original(from,to)})
 const two=createDataStore({dataDir:root,schemaVersion:2});expect(()=>two.migrate({fromVersion:1,expectedRevision:1,transform:(value:any)=>({...value,schema_version:2})})).toThrow('INJECTED_DISK_FAILURE');expect(readFileSync(join(root,'records.json'))).toEqual(before);expect(readdirSync(root).some(name=>name.startsWith('records-before-migration-'))).toBe(true)
})
it('allows only one stale-snapshot winner across two real writer processes',async()=>{
 const script=join(root,'writer.cjs');writeFileSync(script,`const fs=require('fs'),{createDataStore}=require('./product_store.cjs');const id=process.argv[2],store=createDataStore({dataDir:__dirname}),before=store.read();fs.writeFileSync(id+'.ready','ready');const timer=setInterval(()=>{if(!fs.existsSync('go'))return;clearInterval(timer);try{store.commit(before.revision,[{id,type:'note',expectedRevision:0,data:{writer:id}}]);console.log('winner')}catch{console.log('rejected')}},5)`)
 const children=['left','right'].map(id=>spawn(process.execPath,[script,id],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']})),outcomes=children.map(child=>new Promise<string>((done,fail)=>{let text='';child.stdout!.on('data',bytes=>text+=bytes);child.once('error',fail);child.once('exit',()=>done(text.trim()))}))
 try{await until(()=>fs.existsSync(join(root,'left.ready'))&&fs.existsSync(join(root,'right.ready')));writeFileSync(join(root,'go'),'go');const results=await Promise.all(outcomes);expect(results.filter(result=>result==='winner')).toHaveLength(1);expect(results.filter(result=>result==='rejected')).toHaveLength(1);const snapshot=require(join(root,'product_store.cjs')).createDataStore({dataDir:root}).read();expect(snapshot.revision).toBe(1);expect(Object.keys(snapshot.records)).toHaveLength(1)}finally{for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill()}
})
it('archives complete history to free capacity without losing deduplication across reopen',async()=>{
 const {createJobQueue}=require(join(root,'product_jobs.cjs'));let calls=0
 const options={dataDir:root,limit:1,handlers:{read:async()=>{calls++;return{answer:'kept'}}}}
 queue=createJobQueue(options);const first=queue.enqueue({type:'read',dedupeKey:'first',input:{left:1,right:2}});await until(()=>queue.list()[0].state==='succeeded')
 expect(()=>queue.enqueue({type:'read',dedupeKey:'second'})).toThrow('JOBS_LIMIT');expect(queue.archive([first.id])).toMatchObject({archived:1})
 expect(queue.history()[0]).toMatchObject({input:{left:1,right:2},result:{answer:'kept'}})
 expect(queue.enqueue({type:'read',dedupeKey:'first',input:{right:2,left:1}})).toMatchObject({archived:true,id:first.id});expect(calls).toBe(1)
 queue.enqueue({type:'read',dedupeKey:'second'});await until(()=>queue.list()[0].state==='succeeded');expect(calls).toBe(2)
 await queue.close();queue=createJobQueue(options);expect(queue.enqueue({type:'read',dedupeKey:'first',input:{left:1,right:2}}).archived).toBe(true);expect(calls).toBe(2)
})
it('refuses archiving an unresolved side effect',async()=>{
 let finish:()=>void=()=>{}
 queue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers:{write:async(_:any,ctx:any)=>{ctx.beginEffect();await new Promise<void>(done=>finish=done)}}})
 const job=queue.enqueue({type:'write',dedupeKey:'effect'});await until(()=>queue.list()[0].state==='running');expect(()=>queue.archive([job.id])).toThrow('REVIEW_REQUIRED');finish();await until(()=>queue.list()[0].state==='interrupted');expect(()=>queue.archive([job.id])).toThrow('REVIEW_REQUIRED')
})
it('rejects a connection revision changed while resolving its credential before sending any write',async()=>{
 let finish:(key:string)=>void=()=>{},resolving=false,calls=0;const url=await service((_,res)=>{calls++;res.end('{}')})
 const http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root,resolveKey:()=>{resolving=true;return new Promise(done=>finish=done)}})
 http.saveConnection({id:'api',revision:0,config:{...config(url),secret_name:'APP_API_KEY'}})
 const pending=http.submit({connectionId:'api',recordId:'source',sourceRevision:1,fields:{title:'A'}});await until(()=>resolving)
 const before=http.settings();http.saveConnection({id:'api',revision:before.revision,entityRevision:before.records.api.revision,config:{...config(url),writePath:'changed'}});finish('local-only-key')
 await expect(pending).rejects.toThrow('CONNECTION_STALE');expect(calls).toBe(0);expect(http.read().revision).toBe(0)
})
it('keeps an old unscoped receipt blocked until explicit destination review',async()=>{
 let calls=0;const url=await service((_,res)=>{calls++;res.setHeader('Content-Type','application/json');res.end('{}')})
 const http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root});http.saveConnection({id:'api',revision:0,config:config(url)})
 const sync=require(join(root,'product_store.cjs')).createDataStore({dataDir:root,name:'sync'});sync.commit(0,[{id:'legacy',type:'outbound',expectedRevision:0,data:{connectionId:'api',sourceId:'source',sourceRevision:1,fields:{title:'A'},status:'done'}}])
 const input={connectionId:'api',recordId:'source',sourceRevision:1,fields:{title:'A'}};expect(await http.submit(input)).toMatchObject({ok:false,kind:'scope_unverified'});expect(calls).toBe(0)
 http.reconcile({operationId:'legacy',revision:http.read().revision,state:'done',remoteId:'verified-this-destination'});expect(await http.submit(input)).toMatchObject({ok:true,kind:'done'});expect(calls).toBe(0)
})
it('does not confuse JSON evidence with recorded samples, preserves old layouts and rejects malformed samples',()=>{
 const {createEfficiencyRecorder,analyzeEfficiency}=require(join(root,'product_efficiency.cjs')),protocol={version:1,status:'preregistered',scope:'real_services',tasks:[{id:'x',input_sha256:'a'.repeat(64),required_cases:['x']}],variants:{baseline:'v1',templates:'v2'},environment:'e',design:'d',model:'m',channel:'c',account_scope:'a',budget_rmb:10},directory=join(root,'measurements'),recorder=createEfficiencyRecorder(directory,protocol),proof='{"host_check":"fixture only"}'
 writeFileSync(join(directory,'proof.json'),proof)
 for(const variant of ['baseline','templates'])recorder.record({sample_id:variant,variant,version:variant==='baseline'?'v1':'v2',protocol_id:recorder.id,task_id:'x',input_sha256:'a'.repeat(64),environment:'e',design:'d',model:'m',channel:'c',account_scope:'a',service_scope:'real',outcome:'delivered',independent_verification:true,cases:{x:'passed'},elapsed_ms:1,cost_rmb:1,physical_requests:1,user_interventions:0,failures:[],evidence:[{path:'proof.json',sha256:createHash('sha256').update(proof).digest('hex')}]})
 expect(recorder.analyze().eligible).toBe(true)
 expect(analyzeEfficiency(protocol,[null,{}],{evidenceRoot:directory}).eligible).toBe(false)
 const legacy=join(root,'legacy-measurements');mkdirSync(legacy);const original=JSON.stringify({id:recorder.id,protocol});writeFileSync(join(legacy,'protocol.json'),original);expect(()=>createEfficiencyRecorder(legacy,protocol)).toThrow('LAYOUT_MIGRATION_REQUIRED');expect(readFileSync(join(legacy,'protocol.json'),'utf8')).toBe(original)
})
it('retains staged ciphertext if the current public references cannot be read',()=>{
 const {cleanupStagedSecrets}=require(join(root,'ai_secrets.cjs')),remove=vi.fn();expect(cleanupStagedSecrets({remove},['APP_NEW'],()=>{throw Error('READ_FAILED')})).toMatchObject({uncertain:true,retained:['APP_NEW']});expect(remove).not.toHaveBeenCalled()
})
it('does not expose an arbitrary raw uppercase handler error as a public diagnostic code',async()=>{
 queue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers:{fail:async()=>{throw Error('PRIVATE_PRODUCT_KEY_MUST_NOT_BE_EXPOSED')}}})
 queue.enqueue({type:'fail',dedupeKey:'raw-error'});await until(()=>queue.list()[0].state==='failed')
 const job=queue.list()[0];expect(job.error).toBe('TASK_FAILED');expect(JSON.stringify(job)).not.toContain('PRIVATE_PRODUCT_KEY_MUST_NOT_BE_EXPOSED');expect(job.cause_sha256).toMatch(/^[a-f0-9]{64}$/)
})

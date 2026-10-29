import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer,type Server,type RequestListener} from 'node:http'
import {createHmac} from 'node:crypto'
import {beforeEach,afterEach,it,expect} from 'vitest'
const require=createRequire(import.meta.url)
let root:string,store:any,files:any,http:any,queue:any,server:Server|undefined
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'bloma-product-workflows-'));for(const [folder,names]of Object.entries({'data-store':['product_store.cjs'],jobs:['product_jobs.cjs'],'file-io':['product_files.cjs','product_document_worker.cjs'],multimodal:['product_media.cjs'],'http-workflow':['product_http.cjs'],'query-list':['product_query.cjs']}))for(const name of names)copyFileSync(resolve('main/templates/components',folder,name),join(root,name));for(const file of ['http_connector.cjs','webhook_inbox.cjs','document_runtime.cjs','ai_service.cjs','ai_routes.cjs','AI_SERVICE.template.json'])copyFileSync(resolve('main/templates/tools',file),join(root,file));store=require(join(root,'product_store.cjs')).createDataStore({dataDir:root});files=require(join(root,'product_files.cjs')).createFileWorkflow({dataDir:root,store})})
afterEach(async()=>{if(queue)await queue.close();queue=undefined;if(server){server.closeAllConnections();await new Promise<void>(done=>server!.close(()=>done()));server=undefined}rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
async function serve(handler:RequestListener){server=createServer(handler);await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));return`http://127.0.0.1:${(server.address() as {port:number}).port}/`}
const connection=(baseUrl:string)=>({name:'本地连接',baseUrl,network:'loopback',readPath:'items',writePath:'items',writeMethod:'POST',itemsPath:'items',nextPath:'next',checkpointPath:'checkpoint',cursorParam:'cursor',idPath:'id',versionPath:'version',mapping:{title:'title'},webhook_secret_name:'APP_WEBHOOK_KEY'})
async function until(fn:()=>boolean){const limit=Date.now()+5000;while(!fn()){if(Date.now()>limit)throw Error('WAIT_TIMEOUT');await new Promise(done=>setTimeout(done,10))}}
it('commits overlapped pages and cursor atomically; failed pages, 401 and 429 never advance committed state',async()=>{
 let mode='ok'
 const url=await serve((req,res)=>{res.setHeader('Content-Type','application/json');const next=req.url?.includes('cursor=page2');if(mode==='auth'){res.writeHead(401);res.end('{}');return}if(mode==='limit'){res.writeHead(429);res.end('{}');return}if(next&&mode==='fail'){res.end('bad-json');return}res.end(JSON.stringify(next?{items:[{id:'a',version:1,title:'A'},{id:'b',version:2,title:'B'}],next:null,checkpoint:'after-all'}:{items:[{id:'a',version:1,title:'A'}],next:'page2',checkpoint:'not-committed-yet'}))})
 http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root});http.saveConnection({id:'local',revision:0,config:connection(url)})
 mode='fail';expect(await http.pull({connectionId:'local'})).toMatchObject({ok:false,cursor_committed:false});expect(http.read().revision).toBe(0)
 mode='ok';expect(await http.pull({connectionId:'local'})).toMatchObject({ok:true,count:2,pages:2,cursor_committed:true});const saved=http.read()
 expect(Object.values(saved.records).filter((row:any)=>row.type==='remote')).toHaveLength(2);expect(Object.values(saved.records).find((row:any)=>row.type==='cursor')).toMatchObject({data:{cursor:'after-all'}})
 for(const state of ['auth','limit']){mode=state;expect((await http.pull({connectionId:'local'})).ok).toBe(false);expect(http.read()).toEqual(saved)}
})
it('verifies actual signed bytes, rejects event-id conflicts and prevents older versions overwriting a newer record',async()=>{
 const secret='local-webhook-test-secret',url=await serve((_,res)=>res.end('{}'))
 http=require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root,resolveKey:async()=>secret});http.saveConnection({id:'local',revision:0,config:connection(url)})
 const send=(event_id:string,version:number,title:string,wrong=false)=>{const rawBody=Buffer.from(JSON.stringify({event_id,record:{id:'a',version,title}})),timestamp=String(Math.floor(Date.now()/1000)),signature='sha256='+createHmac('sha256',wrong?'wrong-secret':secret).update(timestamp+'.').update(rawBody).digest('hex');return http.receive({connectionId:'local',rawBody,timestamp,signature})}
 expect(await send('e2',2,'NEW',true)).toMatchObject({ok:false,kind:'invalid_signature'})
 expect(await send('e2',2,'NEW')).toMatchObject({ok:true,kind:'applied'});expect(await send('e2',2,'NEW')).toMatchObject({ok:false,kind:'duplicate_done'})
 expect(await send('e2',2,'DIFFERENT')).toMatchObject({ok:false,kind:'event_id_conflict'})
 expect(await send('e1',1,'OLD')).toMatchObject({ok:true,kind:'ignored_old_version'})
 expect(Object.values(http.read().records).find((row:any)=>row.type==='remote')).toMatchObject({data:{version:2,fields:{title:'NEW'}}})
})
it('records a lost write receipt as unknown, blocks resubmission after reopen and requires explicit reconciliation',async()=>{
 let calls=0
 const url=await serve(async(req,res)=>{for await(const _ of req){}calls++;req.socket.destroy()})
 const create=()=>require(join(root,'product_http.cjs')).createHttpWorkflow({dataDir:root})
 http=create();http.saveConnection({id:'local',revision:0,config:connection(url)})
 const input={connectionId:'local',recordId:'analysis-a',sourceRevision:1,fields:{title:'A'}}
 const first=await http.submit(input);expect(first).toMatchObject({ok:false,kind:'unknown'});expect(calls).toBe(1)
 http=create();expect(await http.submit(input)).toMatchObject({kind:'unknown'});expect(calls).toBe(1)
 await expect(http.submit({...input,sourceRevision:2})).rejects.toThrow('RECONCILIATION_REQUIRED')
 http.reconcile({operationId:first.operationId,revision:http.read().revision,state:'done',remoteId:'verified-remote-a'})
 expect(await http.submit(input)).toMatchObject({ok:true,kind:'done'});expect(calls).toBe(1)
})
it('previews real mixed files, keeps same-name sources distinct, preserves preview after failed commit and exports readback',async()=>{
 mkdirSync(join(root,'a'));mkdirSync(join(root,'b'));writeFileSync(join(root,'a','same.txt'),'甲资料：连续函数');writeFileSync(join(root,'b','same.txt'),'乙资料：积分')
 writeFileSync(join(root,'bad.pdf'),'broken')
 const a=files.importFile(join(root,'a','same.txt')),b=files.importFile(join(root,'b','same.txt')),bad=files.importFile(join(root,'bad.pdf'))
 expect(a.id).not.toBe(b.id);expect(files.importFile(join(root,'a','same.txt'),{dedupe:true}).id).toBe(a.id)
 const preview=await files.preview([a.id,b.id,bad.id]);expect(preview.rows.filter((row:any)=>row.ok)).toHaveLength(2)
 const before=store.read(),previewRow=before.records[preview.id];writeFileSync(join(root,'records.json.lock'),'busy')
 expect(()=>files.commitPreview(preview.id,{expectedRevision:previewRow.revision})).toThrow();rmSync(join(root,'records.json.lock'))
 expect(store.read().records[preview.id].data.state).toBe('ready')
 const committed=files.commitPreview(preview.id,{expectedRevision:previewRow.revision});expect(committed.committed).toHaveLength(2);expect(committed.failed).toHaveLength(1)
 expect(await files.writeExport(join(root,'export.json'))).toMatchObject({records:Object.keys(store.read().records).length})
 expect(JSON.parse(readFileSync(join(root,'export.json'),'utf8')).backup.checksum).toBe(store.backup().checksum)
 const archive=files.exportArchive(),restored=join(root,'restored');mkdirSync(restored);const targetStore=require(join(root,'product_store.cjs')).createDataStore({dataDir:restored}),targetFiles=require(join(root,'product_files.cjs')).createFileWorkflow({dataDir:restored,store:targetStore});targetFiles.restoreArchive(0,archive);expect(targetFiles.asset(a.id).data.sha256).toBe(a.data.sha256);expect(()=>targetFiles.restoreArchive(1,{...archive,checksum:'corrupt'})).toThrow('ARCHIVE_INVALID')
 const cancelled=new AbortController();cancelled.abort();await expect(files.preview([a.id],{signal:cancelled.signal})).rejects.toThrow()
})
it('binds real distinct image request bytes to individual results; corrected content survives and cancelled late work cannot commit',async()=>{
 const requests:any[]=[]
 const url=await serve(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks).toString()));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'controlled image '+requests.length}}]}))})
 const {AIService}=require(join(root,'ai_service.cjs')),ai=new AIService();writeFileSync(join(root,'ai-service.json'),JSON.stringify({version:1,default_route:'default',routes:{default:{protocol:'openai-chat',endpoint:url,model:'test-model',api_key_env:'APP_TEST_KEY',network:'loopback'}}}));ai.resolveKey=async()=> 'local-key'
 const first=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),second=Buffer.concat([first,Buffer.from('different-source')])
 writeFileSync(join(root,'a.png'),first);writeFileSync(join(root,'b.png'),second)
 const a=files.importFile(join(root,'a.png'),{kind:'image'}),b=files.importFile(join(root,'b.png'),{kind:'image'}),handlers:any={}
 queue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers});const media=require(join(root,'product_media.cjs')).createMediaWorkflow({dataDir:root,store,files,queue,ai});Object.assign(handlers,media.handlers)
 const ja=media.submit({assetId:a.id,mode:'vision',prompt:'A'}),jb=media.submit({assetId:b.id,mode:'vision',prompt:'B'})
 await until(()=>queue.list().filter((row:any)=>row.state==='succeeded').length===2)
 const ra=store.read().records[queue.list().find((row:any)=>row.id===ja.id).result.resultId],rb=store.read().records[queue.list().find((row:any)=>row.id===jb.id).result.resultId]
 expect(ra.data.assetId).toBe(a.id);expect(rb.data.assetId).toBe(b.id);expect(requests[0].messages[0].content[1]).not.toEqual(requests[1].messages[0].content[1])
 const originalA=ra.data.originalText
 media.correct({resultId:ra.id,expectedRevision:ra.revision,text:'人工修正甲'});expect(store.read().records[ra.id].data).toMatchObject({text:'人工修正甲',originalText:originalA,corrected:true})
 await queue.close();queue=undefined
 const delayedHandlers:any={},cancelQueue=require(join(root,'product_jobs.cjs')).createJobQueue({dataDir:root,handlers:delayedHandlers});queue=cancelQueue
 let done:(value:any)=>void=()=>{}
 const slowMedia=require(join(root,'product_media.cjs')).createMediaWorkflow({dataDir:root,store,files,queue:cancelQueue,ai:{generate:()=>new Promise(resolve=>done=resolve)}});Object.assign(delayedHandlers,slowMedia.handlers)
 const late=slowMedia.submit({assetId:a.id,mode:'vision',prompt:'late'});await until(()=>cancelQueue.list().find((row:any)=>row.id===late.id)?.state==='running');cancelQueue.cancel(late.id);done({ok:true,text:'late',input_images:[{sha256:a.data.sha256}]});await until(()=>cancelQueue.list().find((row:any)=>row.id===late.id)?.state==='cancelled')
 expect(Object.values(store.read().records).filter((row:any)=>row.type==='analysis')).toHaveLength(2)
})
it('keeps query counts/page/selection consistent, discards out-of-order responses and retains partial batch errors',async()=>{
 const {queryRecords,createQueryController,batchById}=require(join(root,'product_query.cjs'))
 store.commit(0,[{id:'a',type:'note',expectedRevision:0,data:{name:'乙'}},{id:'b',type:'note',expectedRevision:0,data:{name:'甲'}}])
 expect(queryRecords(store.read(),{query:'不存在',page:8,selected:['a']})).toMatchObject({total:0,page:1,pages:1,selected:[],rows:[]})
 const all=queryRecords(store.read(),{sort:'name',selected:['a']});expect(all.rows[0].id).toBe('b');expect(all.selected).toEqual(['a'])
 const ctl=createQueryController();let release:(value:any)=>void=()=>{};const old=ctl.run(()=>new Promise(resolve=>release=resolve),{}),newer=await ctl.run(async()=> 'B',{});release('A');expect(newer.accepted).toBe(true);expect((await old).accepted).toBe(false)
 expect(await batchById(['a','b'],async(id:string)=>{if(id==='b')throw Error('STORE_RECORD_INVALID');return id})).toMatchObject([{id:'a',ok:true},{id:'b',ok:false,code:'STORE_RECORD_INVALID'}])
})

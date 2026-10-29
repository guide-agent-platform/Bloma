const {randomUUID,createHash}=require('node:crypto')
const {createDataStore,canonicalJSON}=require('./product_store.cjs')
const inputHash=input=>createHash('sha256').update(canonicalJSON(input)).digest('hex')
const jobErrors=new Set(('JOBS_PROGRESS_INVALID MEDIA_INPUT_INVALID MEDIA_SOURCE_STALE MEDIA_SOURCE_MISMATCH MEDIA_AI_UNAVAILABLE MEDIA_OCR_UNAVAILABLE MEDIA_AUDIO_UNAVAILABLE MEDIA_UNCONFIGURED MEDIA_AUTH_ERROR MEDIA_RATE_LIMITED MEDIA_INVALID_RESPONSE MEDIA_CANCELLED MEDIA_TIMEOUT MEDIA_MODEL_ERROR MEDIA_RESULT_INVALID MEDIA_RESULT_STALE FILES_BATCH_INVALID FILES_SOURCE_CHANGED FILES_CANCELLED FILES_TIMEOUT FILES_PARSE_FAILED FILES_OUTPUT_LIMIT FILES_DOCUMENT_REQUIRED FILES_WORKER_UNAVAILABLE STORE_STALE STORE_ENTITY_STALE STORE_RECORD_INVALID STORE_SCHEMA_INVALID STORE_JSON_INVALID CONNECTION_STALE CONNECTION_MISSING CONNECTION_KEY_MISSING CONNECTION_ENCRYPTION_UNAVAILABLE SYNC_RECONCILIATION_REQUIRED SYNC_WRITE_REJECTED SYNC_FIELD_MISSING SYNC_VERSION_CONFLICT SYNC_AUTH_ERROR SYNC_RATE_LIMITED SYNC_INVALID_RESPONSE SYNC_NETWORK_ERROR SYNC_NETWORK_BLOCKED SYNC_HTTP_ERROR SYNC_TIMEOUT SYNC_CANCELLED SYNC_CURSOR_INVALID SYNC_ITEMS_INVALID SYNC_PAGE_LIMIT SYNC_RETRY_LIMIT').split(' '))
function createJobQueue({dataDir,handlers,concurrency=2,limit=1000}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8||!Number.isInteger(limit)||limit<1||limit>10000)throw Error('JOBS_OPTIONS_INVALID')
 const store=createDataStore({dataDir,name:'jobs'}),active=new Map(),listeners=new Set();let closed=false,closePromise,fdClosed=false,released=false,closeFinalized=false
 const rows=()=>Object.values(store.read().records).filter(row=>row.type==='job').map(row=>({...row.data,id:row.id,revision:row.revision}))
 function write(id,mutate){const snapshot=store.read(),row=snapshot.records[id];if(!row)throw Error('JOBS_MISSING');return store.commit(snapshot.revision,[{id,type:'job',expectedRevision:row.revision,data:mutate(structuredClone(row.data))}])}
 const emit=()=>{for(const fn of listeners){try{fn(rows())}catch{}}}
 // Acquiring the queue is exclusive for its lifetime; never steal another process's running tasks.
 const fs=require('node:fs'),path=require('node:path'),owner=path.join(fs.realpathSync(dataDir),'.jobs-owner.lock')
 const ownerToken=randomUUID(),fd=fs.openSync(owner,'wx',0o600)
 function releaseIfDrained(){
  if(released||!closed||!closeFinalized||active.size)return released
  if(!fdClosed){fs.closeSync(fd);fdClosed=true}
  try{const row=JSON.parse(fs.readFileSync(owner,'utf8'));if(row.token!==ownerToken)return false;fs.unlinkSync(owner);released=true}catch(error){if(error.code==='ENOENT')released=true}
  return released
 }
 try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:ownerToken,at:new Date().toISOString()}));fs.fsyncSync(fd); for(const row of rows())if(['running','cancelling'].includes(row.state))write(row.id,data=>({...data,state:'interrupted',needs_review:!!data.effect_pending,run_token:null,error:'PROCESS_INTERRUPTED'}))}
 catch(error){fs.closeSync(fd);fs.unlinkSync(owner);throw error}
 function enqueue({type,input={},dedupeKey}){
  if(closed||typeof handlers[type]!=='function'||typeof dedupeKey!=='string'||!dedupeKey||dedupeKey.length>200)throw Error('JOBS_INPUT_INVALID')
  const digest=inputHash(input),before=rows(),receipt=Object.values(store.read().records).find(row=>row.type==='job_receipt'&&row.data.dedupe_key===dedupeKey)
  if(receipt){if(receipt.data.type!==type||receipt.data.input_sha256!==digest)throw Error('JOBS_DEDUPE_CONFLICT');return{...receipt.data,id:receipt.id,archived:true}}
  const prior=before.find(row=>row.dedupe_key===dedupeKey)
  if(prior){if(prior.type!==type||inputHash(prior.input)!==digest)throw Error('JOBS_DEDUPE_CONFLICT');return prior}
  if(before.length>=limit)throw Error('JOBS_LIMIT')
  const snapshot=store.read(),id=randomUUID();store.commit(snapshot.revision,[{id,type:'job',expectedRevision:0,data:{type,input,dedupe_key:dedupeKey,state:'queued',progress:0,checkpoint:null,effect_pending:false,at:new Date().toISOString()}}]);emit();queueMicrotask(pump);return rows().find(row=>row.id===id)
 }
 function cancel(id){const row=rows().find(row=>row.id===id);if(!row)throw Error('JOBS_MISSING')
  if(row.state==='queued')write(id,data=>({...data,state:'cancelled'}))
  else if(row.state==='running'){write(id,data=>({...data,state:'cancelling'}));active.get(id)?.controller.abort()}
  emit();return rows().find(row=>row.id===id)
 }
 async function run(row){
  const token=randomUUID(),controller=new AbortController();active.set(row.id,{token,controller})
  const update=fn=>{if(closed||controller.signal.aborted||active.get(row.id)?.token!==token)return false;write(row.id,data=>data.run_token===token?fn(data):data);emit();return true}
  try{
   write(row.id,data=>({...data,state:'running',run_token:token}));emit()
   const result=await handlers[row.type](structuredClone(row.input),{signal:controller.signal,checkpoint:row.checkpoint,progress:value=>{if(!Number.isFinite(value)||value<0||value>1)throw Error('JOBS_PROGRESS_INVALID');return update(data=>({...data,progress:value}))},saveCheckpoint:value=>update(data=>({...data,checkpoint:value})),beginEffect:()=>update(data=>({...data,effect_pending:true})),finishEffect:()=>update(data=>({...data,effect_pending:false}))})
   if(!closed)write(row.id,data=>({...data,state:data.effect_pending?'interrupted':controller.signal.aborted?'cancelled':'succeeded',needs_review:!!data.effect_pending,result:controller.signal.aborted?null:result??null,progress:controller.signal.aborted||data.effect_pending?data.progress:1,run_token:null}))
  }catch(error){const raw=String(error?.message??''),known=jobErrors.has(raw);if(!closed)write(row.id,data=>({...data,state:data.effect_pending?'interrupted':controller.signal.aborted?'cancelled':'failed',needs_review:!!data.effect_pending,error:known?raw:'TASK_FAILED',error_basis:known?'component_code':'unknown',cause_sha256:createHash('sha256').update(raw).digest('hex'),run_token:null}))}
  finally{active.delete(row.id);releaseIfDrained();emit();if(!closed)queueMicrotask(pump)}
 }
 function pump(){if(closed)return;for(const row of rows().filter(row=>row.state==='queued')){if(active.size>=concurrency)break;run(row).catch(()=>{closed=true;for(const item of active.values())item.controller.abort();if(!closePromise)closeFinalized=true;releaseIfDrained()})}}
 function resume(id,{reviewed=false}={}){
  if(closed)throw Error('JOBS_CLOSED')
  const row=rows().find(row=>row.id===id)
  if(!row||!['interrupted','failed','cancelled'].includes(row.state)||row.needs_review&&!reviewed)throw Error('JOBS_REVIEW_REQUIRED')
  write(id,data=>({...data,state:'queued',needs_review:false,effect_pending:false,error:null}));emit();queueMicrotask(pump)
 }
 function archive(ids){
  if(!Array.isArray(ids)||!ids.length||ids.length>1000||new Set(ids).size!==ids.length)throw Error('JOBS_ARCHIVE_INVALID')
  const before=store.read(),changes=ids.map(id=>{
   const row=before.records[id],data=row?.data
   if(row?.type!=='job'||active.has(id)||!['succeeded','failed','cancelled'].includes(data.state)||data.needs_review||data.effect_pending)throw Error('JOBS_ARCHIVE_REVIEW_REQUIRED')
   return{id,type:'job_receipt',expectedRevision:row.revision,data:{...data,input_sha256:inputHash(data.input),archived_at:new Date().toISOString()}}
  })
  store.commit(before.revision,changes);emit();return{archived:ids.length,receipt_policy:'dedupe_retained_no_automatic_replay'}
 }
 function close({timeoutMs=5000}={}){
  if(!Number.isInteger(timeoutMs)||timeoutMs<0||timeoutMs>30000)return Promise.reject(Error('JOBS_CLOSE_TIMEOUT_INVALID'))
  if(closePromise)return closePromise
  closePromise=(async()=>{
   closed=true;const stopping=[...active.keys()];for(const item of active.values())item.controller.abort()
   const deadline=Date.now()+timeoutMs
   while(active.size&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,Math.min(10,Math.max(1,deadline-Date.now()))))
   let persistence='confirmed'
   for(const id of stopping)try{write(id,data=>({...data,state:'interrupted',needs_review:active.has(id)||!!data.effect_pending,run_token:null,error:active.has(id)?'JOBS_CLOSE_TIMEOUT':'QUEUE_CLOSED'}))}catch{persistence='unconfirmed'}
   closeFinalized=true;releaseIfDrained()
   return{closed:active.size===0,active:[...active.keys()],lock_released:released,persistence}
  })()
  return closePromise
 }
 queueMicrotask(pump)
 return{enqueue,cancel,resume,archive,list:rows,history:()=>Object.values(store.read().records).filter(row=>row.type==='job_receipt').map(row=>({...row.data,id:row.id,archived:true})),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},close}
}
// After a crash the lock is intentionally retained. An explicit operator recovery
// must establish the prior process is stopped; no PID reattachment or auto replay.
function recoverJobLock(dataDir){return require('./product_store.cjs').recoverDeadLock(dataDir,'.jobs-owner.lock')}
module.exports={createJobQueue,recoverJobLock}

const {randomUUID}=require('node:crypto')
const {createDataStore}=require('./product_store.cjs')
function createJobQueue({dataDir,handlers,concurrency=2,limit=1000}){
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8||!Number.isInteger(limit)||limit<1||limit>10000)throw Error('JOBS_OPTIONS_INVALID')
 const store=createDataStore({dataDir,name:'jobs'}),active=new Map(),listeners=new Set();let closed=false
 const rows=()=>Object.values(store.read().records).map(row=>({...row.data,id:row.id,revision:row.revision}))
 function write(id,mutate){const snapshot=store.read(),row=snapshot.records[id];if(!row)throw Error('JOBS_MISSING');return store.commit(snapshot.revision,[{id,type:'job',expectedRevision:row.revision,data:mutate(structuredClone(row.data))}])}
 const emit=()=>{for(const fn of listeners){try{fn(rows())}catch{}}}
 // Acquiring the queue is exclusive for its lifetime; never steal another process's running tasks.
 const fs=require('node:fs'),path=require('node:path'),owner=path.join(fs.realpathSync(dataDir),'.jobs-owner.lock')
 const fd=fs.openSync(owner,'wx',0o600);fs.writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));fs.fsyncSync(fd)
 try{for(const row of rows())if(['running','cancelling'].includes(row.state))write(row.id,data=>({...data,state:'interrupted',needs_review:!!data.effect_pending,run_token:null,error:'PROCESS_INTERRUPTED'}))}
 catch(error){fs.closeSync(fd);fs.unlinkSync(owner);throw error}
 function enqueue({type,input={},dedupeKey}){
  if(closed||typeof handlers[type]!=='function'||typeof dedupeKey!=='string'||!dedupeKey||dedupeKey.length>200)throw Error('JOBS_INPUT_INVALID')
  const before=rows(),prior=before.find(row=>row.dedupe_key===dedupeKey)
  if(prior){if(prior.type!==type||JSON.stringify(prior.input)!==JSON.stringify(input))throw Error('JOBS_DEDUPE_CONFLICT');return prior}
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
  write(row.id,data=>({...data,state:'running',run_token:token}));emit()
  const update=fn=>{if(closed||controller.signal.aborted||active.get(row.id)?.token!==token)return false;write(row.id,data=>data.run_token===token?fn(data):data);emit();return true}
  try{
   const result=await handlers[row.type](structuredClone(row.input),{signal:controller.signal,checkpoint:row.checkpoint,progress:value=>{if(!Number.isFinite(value)||value<0||value>1)throw Error('JOBS_PROGRESS_INVALID');return update(data=>({...data,progress:value}))},saveCheckpoint:value=>update(data=>({...data,checkpoint:value})),beginEffect:()=>update(data=>({...data,effect_pending:true})),finishEffect:()=>update(data=>({...data,effect_pending:false}))})
   if(!closed)write(row.id,data=>({...data,state:data.effect_pending?'interrupted':controller.signal.aborted?'cancelled':'succeeded',needs_review:!!data.effect_pending,result:controller.signal.aborted?null:result??null,progress:controller.signal.aborted||data.effect_pending?data.progress:1,run_token:null}))
  }catch(error){if(!closed)write(row.id,data=>({...data,state:data.effect_pending?'interrupted':controller.signal.aborted?'cancelled':'failed',needs_review:!!data.effect_pending,error:/^[A-Z][A-Z0-9_]{1,100}$/.test(error?.message)?error.message:'TASK_FAILED',run_token:null}))}
  finally{active.delete(row.id);emit();if(!closed)queueMicrotask(pump)}
 }
 function pump(){if(closed)return;for(const row of rows().filter(row=>row.state==='queued')){if(active.size>=concurrency)break;run(row).catch(()=>{closed=true;for(const item of active.values())item.controller.abort()})}}
 function resume(id,{reviewed=false}={}){
  const row=rows().find(row=>row.id===id)
  if(!row||!['interrupted','failed','cancelled'].includes(row.state)||row.needs_review&&!reviewed)throw Error('JOBS_REVIEW_REQUIRED')
  write(id,data=>({...data,state:'queued',needs_review:false,effect_pending:false,error:null}));emit();queueMicrotask(pump)
 }
 async function close(){closed=true;for(const item of active.values())item.controller.abort();while(active.size)await new Promise(resolve=>setTimeout(resolve,10));fs.closeSync(fd);fs.unlinkSync(owner)}
 queueMicrotask(pump)
 return{enqueue,cancel,resume,list:rows,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},close}
}
// After a crash the lock is intentionally retained. An explicit operator recovery
// must establish the prior process is stopped; no PID reattachment or auto replay.
function recoverJobLock(dataDir){return require('./product_store.cjs').recoverDeadLock(dataDir,'.jobs-owner.lock')}
module.exports={createJobQueue,recoverJobLock}

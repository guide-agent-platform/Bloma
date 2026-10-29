const {createHash}=require('node:crypto')
const {createDataStore,validId}=require('./product_store.cjs')
const {createHttpConnector,verifyWebhook}=require('./http_connector.cjs')
const {createWebhookInbox}=require('./webhook_inbox.cjs')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function at(value,key){if(typeof key!=='string'||key.length>200)throw Error('SYNC_FIELD_INVALID');for(const part of key.split('.')){if(!part||['__proto__','constructor','prototype'].includes(part)||!value||!Object.hasOwn(value,part))throw Error('SYNC_FIELD_MISSING');value=value[part]}return value}
function validateConnection(value){
 const allowed=['name','baseUrl','network','readPath','writePath','writeMethod','itemsPath','nextPath','checkpointPath','cursorParam','idPath','versionPath','mapping','secret_name','webhook_secret_name','authHeader','authPrefix']
 if(!value||Object.keys(value).some(key=>!allowed.includes(key))||typeof value.name!=='string'||value.name.length>120||!['POST','PUT','PATCH'].includes(value.writeMethod)||typeof value.readPath!=='string'||typeof value.writePath!=='string'||!value.mapping||Array.isArray(value.mapping)||!Object.keys(value.mapping).length||Object.keys(value.mapping).length>30)throw Error('CONNECTION_INVALID')
 for(const key of ['itemsPath','nextPath','idPath','versionPath','cursorParam'])if(typeof value[key]!=='string'||!value[key]||value[key].length>100)throw Error('CONNECTION_INVALID')
 for(const [key,source]of Object.entries(value.mapping))if(!validId(key)||typeof source!=='string'||!source||source.length>100)throw Error('CONNECTION_MAPPING_INVALID')
 for(const key of ['secret_name','webhook_secret_name'])if(value[key]!==undefined&&!/^APP_[A-Z0-9_]{1,80}$/.test(value[key]))throw Error('CONNECTION_SECRET_NAME_INVALID')
 const api=createHttpConnector({baseUrl:value.baseUrl,network:value.network,methods:['GET',value.writeMethod]})
 for(const field of ['readPath','writePath']){const url=new URL(value[field],value.baseUrl);if(url.origin!==new URL(value.baseUrl).origin||url.username||url.password||url.hash)throw Error('CONNECTION_PATH_INVALID')}
 if(value.authHeader!==undefined&&(!/^[A-Za-z0-9-]{1,80}$/.test(value.authHeader)||['host','content-length','connection','transfer-encoding'].includes(value.authHeader.toLowerCase())))throw Error('CONNECTION_INVALID')
 if(value.authPrefix!==undefined&&(typeof value.authPrefix!=='string'||value.authPrefix.length>80||/[\r\n]/.test(value.authPrefix)))throw Error('CONNECTION_INVALID')
 return api
}
function createHttpWorkflow({dataDir,resolveKey=async()=>undefined}){
 const configs=createDataStore({dataDir,name:'connections'}),state=createDataStore({dataDir,name:'sync'}),inbox=createWebhookInbox(dataDir),active=new Set()
 function settings(){return configs.read()}
 function saveConnection({id,revision,entityRevision=0,config}){validateConnection(config);return configs.commit(revision,[{id,type:'connection',expectedRevision:entityRevision,data:config}])}
 function connection(id){const row=configs.read().records[id];if(row?.type!=='connection')throw Error('CONNECTION_MISSING');validateConnection(row.data);return row}
 async function client(row,headers={}){const key=row.data.secret_name?await resolveKey(row.data.secret_name):undefined;if(row.data.secret_name&&!key)throw Error('CONNECTION_KEY_MISSING');return createHttpConnector({baseUrl:row.data.baseUrl,network:row.data.network,methods:['GET',row.data.writeMethod],headers,...(key?{auth:{header:row.data.authHeader??'Authorization',value:(row.data.authPrefix??'Bearer ')+key}}:{})})}
 function record(config,item){const id=at(item,config.idPath),version=at(item,config.versionPath),fields={};if(typeof id!=='string'||!id||id.length>200||!Number.isSafeInteger(version)||version<0)throw Error('SYNC_RECORD_INVALID');for(const [name,source]of Object.entries(config.mapping))fields[name]=at(item,source);return{id,version,fields}}
 const recordId=(conn,id)=>'remote_'+hash([conn,id])
 const change=(old,id,type,data,refs=[])=>({id,type,expectedRevision:old?.revision??0,data,refs})
 function newer(old,next){if(!old)return true;if(next.version===old.version&&hash(next.fields)!==hash(old.fields))throw Error('SYNC_VERSION_CONFLICT');return next.version>old.version}
 async function pull({connectionId,signal}){
  if(active.has(connectionId))throw Error('SYNC_BUSY');active.add(connectionId)
  try{
   const conn=connection(connectionId),config=conn.data,api=await client(conn),before=state.read(),cursorId='cursor_'+hash(connectionId),collected=new Map(),seen=new Set()
   let cursor=before.records[cursorId]?.data.cursor??null,checkpoint=null,pages=0
   while(true){
    signal?.throwIfAborted();if(++pages>100)throw Error('SYNC_PAGE_LIMIT')
    const url=new URL(config.readPath,config.baseUrl);if(cursor!==null)url.searchParams.set(config.cursorParam,String(cursor))
    const result=await api.request(url.href,{signal});if(!result.ok)return{ok:false,kind:result.kind,cursor_committed:false,pages}
    const items=at(result.data,config.itemsPath);if(!Array.isArray(items))throw Error('SYNC_ITEMS_INVALID')
    for(const item of items){const mapped=record(config,item),previous=collected.get(mapped.id);if(newer(previous,mapped))collected.set(mapped.id,mapped);if(collected.size>10000)throw Error('SYNC_RECORD_LIMIT')}
    const next=at(result.data,config.nextPath)
    if(config.checkpointPath)checkpoint=at(result.data,config.checkpointPath)
    if(next===null||next==='')break
    if(!['string','number'].includes(typeof next)||String(next).length>1024||seen.has(String(next)))throw Error('SYNC_CURSOR_INVALID')
    seen.add(String(next));cursor=next
   }
   if(checkpoint!==null&&(typeof checkpoint!=='string'||checkpoint.length>1024))throw Error('SYNC_CHECKPOINT_INVALID')
   signal?.throwIfAborted();if(connection(connectionId).revision!==conn.revision)throw Error('CONNECTION_STALE')
   const changes=[]
   for(const row of collected.values()){const id=recordId(connectionId,row.id),old=before.records[id];if(newer(old?.data,row))changes.push(change(old,id,'remote',{...row,connectionId}))}
   changes.push(change(before.records[cursorId],cursorId,'cursor',{connectionId,cursor:checkpoint,pages,at:new Date().toISOString()}))
   const committed=state.commit(before.revision,changes)
   return{ok:true,count:collected.size,pages,revision:committed.revision,cursor_committed:true}
  }finally{active.delete(connectionId)}
 }
 async function receive({connectionId,rawBody,timestamp,signature}){
  const conn=connection(connectionId),secret=await resolveKey(conn.data.webhook_secret_name)
  const verified=verifyWebhook({secret,rawBody,timestamp,signature});if(!verified.valid)return{ok:false,kind:verified.kind}
  let event;try{event=JSON.parse(new TextDecoder('utf8',{fatal:true}).decode(rawBody))}catch{throw Error('SYNC_EVENT_INVALID')}
  if(typeof event?.event_id!=='string'||!event.event_id||event.event_id.length>200)throw Error('SYNC_EVENT_INVALID')
  const row=record(conn.data,event.record),eventId='event_'+hash([connectionId,event.event_id]),before=state.read(),prior=before.records[eventId]
  const accepted=inbox.accept({secret,rawBody,timestamp,signature,eventId:connectionId+':'+event.event_id})
  if(!accepted.accepted){
   if(accepted.kind==='duplicate_pending'&&prior?.data.digest===hash(rawBody.toString('base64'))){inbox.markDone(prior.data.receipt);return{ok:true,kind:'reconciled'}}
   return{ok:false,kind:accepted.kind}
  }
  const id=recordId(connectionId,row.id),old=before.records[id],apply=newer(old?.data,row),changes=[]
  if(apply)changes.push(change(old,id,'remote',{...row,connectionId}))
  changes.push(change(undefined,eventId,'event',{connectionId,digest:hash(rawBody.toString('base64')),receipt:accepted.receipt,applied:apply},[id]))
  state.commit(before.revision,changes);inbox.markDone(accepted.receipt)
  return{ok:true,kind:apply?'applied':'ignored_old_version'}
 }
 async function submit({connectionId,recordId:sourceId,sourceRevision,fields,signal}){
  const conn=connection(connectionId),before=state.read(),id='outbound_'+hash([connectionId,sourceId,sourceRevision,fields]),old=before.records[id]
  if(old)return{ok:old.data.status==='done',kind:old.data.status,operationId:id}
  if(Object.values(before.records).some(row=>row.type==='outbound'&&row.data.connectionId===connectionId&&row.data.sourceId===sourceId&&['pending','unknown'].includes(row.data.status)))throw Error('SYNC_RECONCILIATION_REQUIRED')
  if(typeof sourceId!=='string'||!sourceId||!Number.isSafeInteger(sourceRevision)||sourceRevision<1||!fields||Array.isArray(fields)||typeof fields!=='object')throw Error('SYNC_SUBMIT_INVALID')
  const api=await client(conn,{'Idempotency-Key':id});signal?.throwIfAborted()
  const data={connectionId,sourceId,sourceRevision,fields,status:'pending',at:new Date().toISOString()}
  state.commit(before.revision,[change(undefined,id,'outbound',data)])
  let result;try{result=await api.request(conn.data.writePath,{method:conn.data.writeMethod,body:{source_id:sourceId,source_revision:sourceRevision,fields},signal})}catch{result={ok:false,kind:'unknown'}}
  const after=state.read(),current=after.records[id],status=result.ok?'done':['auth_error','rate_limited'].includes(result.kind)?'rejected':'unknown'
  state.commit(after.revision,[change(current,id,'outbound',{...current.data,status,error:result.ok?null:result.kind})])
  return{ok:result.ok,kind:status,operationId:id}
 }
 function reconcile({operationId,revision,state:result,remoteId}){const before=state.read(),row=before.records[operationId];if(!row||row.type!=='outbound'||!['pending','unknown'].includes(row.data.status)||!['done','not_applied'].includes(result)||typeof remoteId!=='string'||remoteId.length>200)throw Error('SYNC_RECONCILIATION_INVALID');return state.commit(revision,[change(row,operationId,'outbound',{...row.data,status:result,remoteId,reviewed_at:new Date().toISOString()})])}
 return{settings,saveConnection,pull,receive,submit,reconcile,read:()=>state.read()}
}
module.exports={createHttpWorkflow,validateConnection,at}

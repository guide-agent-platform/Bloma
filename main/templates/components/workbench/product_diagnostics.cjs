const {randomUUID,createHash}=require('node:crypto')
const {createDataStore}=require('./product_store.cjs')
const next={STORE:'重新载入数据，核对修订、引用和数据目录权限',JOBS:'核对任务终态、检查点和外部副作用；待核对任务不可自动重发',SYNC:'核对连接设置、字段协议、分页与待核对外部记录',CONNECTION:'核对本产品连接地址及凭据状态',FILES:'核对原始文件、来源摘要和读写权限',MEDIA:'核对所选来源、服务设置和处理模式',QUERY:'重新载入查询及稳定选择ID'}
const safeCodes=new Set('STORE_STALE STORE_ENTITY_STALE STORE_SCHEMA_INVALID STORE_RECORD_INVALID STORE_MISSING STORE_JSON_INVALID JOBS_INPUT_INVALID JOBS_REVIEW_REQUIRED JOBS_LIMIT JOBS_DEDUPE_CONFLICT SYNC_RECONCILIATION_REQUIRED SYNC_CONSENT_REQUIRED SYNC_WRITE_REJECTED SYNC_FIELD_MISSING SYNC_EVENT_INVALID SYNC_PAGE_LIMIT SYNC_CURSOR_INVALID SYNC_VERSION_CONFLICT SYNC_AUTH_ERROR SYNC_RATE_LIMITED CONNECTION_INVALID CONNECTION_MISSING CONNECTION_KEY_MISSING CONNECTION_ENCRYPTION_UNAVAILABLE FILES_INPUT_INVALID FILES_BATCH_INVALID FILES_ASSET_MISSING FILES_SOURCE_CHANGED FILES_PREVIEW_STALE FILES_ARCHIVE_INVALID FILES_ARCHIVE_SOURCE_MISSING FILES_ARCHIVE_LIMIT MEDIA_CONSENT_REQUIRED MEDIA_INPUT_INVALID MEDIA_RESULT_STALE MEDIA_AI_UNAVAILABLE MEDIA_OCR_UNAVAILABLE MEDIA_AUDIO_UNAVAILABLE QUERY_INVALID'.split(' '))
function createProductDiagnostics(dataDir){
 const store=createDataStore({dataDir,name:'diagnostics'})
 async function operation(action,fn){
  const id=randomUUID(),at=new Date().toISOString()
  try{return{ok:true,value:await fn(),operation_id:id}}
  catch(error){
   const raw=String(error?.message??''),prefix=raw.split('_')[0],known=safeCodes.has(raw),code=known?raw:['EACCES','EPERM','ENOSPC','EEXIST','ENOENT'].includes(error?.code)?error.code:'OPERATION_UNKNOWN'
   const fact={action,at,code,classification_basis:known?'explicit_component_error':'unknown_or_filesystem',cause_sha256:createHash('sha256').update(raw).digest('hex'),next:known?next[prefix]:'核对当前状态与日志；结果未知时先核对，不自动重试外部写入'}
   try{const before=store.read();if(Object.keys(before.records).length<2000)store.commit(before.revision,[{id,type:'diagnostic',expectedRevision:0,data:fact}])}catch{}
   return{ok:false,code,operation_id:id,next:fact.next}
  }
 }
 return{operation,read:()=>store.read()}
}
module.exports={createProductDiagnostics}

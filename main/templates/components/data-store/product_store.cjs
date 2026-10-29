const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto')
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,120}$/.test(id)&&!['__proto__','constructor','prototype'].includes(id)
function jsonValue(value,depth=0,seen=new Set()){
 if(depth>40)throw Error('STORE_JSON_INVALID')
 if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return
 if(!value||typeof value!=='object'||seen.has(value)||!Array.isArray(value)&&![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw Error('STORE_JSON_INVALID')
 seen.add(value);for(const item of Object.values(value))jsonValue(item,depth+1,seen);seen.delete(value)
}
function createDataStore({dataDir,name='records',schemaVersion=1,validate=()=>true}){
 if(!validId(name)||!Number.isInteger(schemaVersion)||schemaVersion<1)throw Error('STORE_OPTIONS_INVALID')
 const root=fs.realpathSync(dataDir),file=path.join(root,name+'.json'),lock=file+'.lock'
 function readFile(target){const info=fs.lstatSync(target);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw Error('STORE_FILE_INVALID');return JSON.parse(fs.readFileSync(target,'utf8'))}
 function check(value,version=schemaVersion,business=true){
  jsonValue(value)
  if(!plain(value)||value.schema_version!==version||!Number.isSafeInteger(value.revision)||value.revision<0||!plain(value.records)||Object.keys(value.records).length>20000)throw Error('STORE_SCHEMA_INVALID')
  for(const[id,row]of Object.entries(value.records)){
   if(!validId(id)||!plain(row)||row.id!==id||!validId(row.type)||!Number.isSafeInteger(row.revision)||row.revision<1||!plain(row.data)||!Array.isArray(row.refs)||row.refs.some(ref=>!validId(ref)||!Object.hasOwn(value.records,ref))||business&&validate(row)!==true)throw Error('STORE_RECORD_INVALID')
  }
  if(Buffer.byteLength(JSON.stringify(value))>32*1024*1024)throw Error('STORE_LIMIT')
  return value
 }
 function read(){return structuredClone(check(fs.existsSync(file)?readFile(file):{schema_version:schemaVersion,revision:0,records:{}}))}
 function atomic(target,value){
  if(fs.existsSync(target)){const info=fs.lstatSync(target);if(info.isSymbolicLink()||!info.isFile())throw Error('STORE_FILE_INVALID')}
  const temp=path.join(root,'.store-'+randomUUID()+'.tmp'),fd=fs.openSync(temp,'wx',0o600)
  try{try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,target)}finally{fs.rmSync(temp,{force:true})}
 }
 function exclusive(fn){const fd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid}));fs.fsyncSync(fd);return fn()}finally{fs.closeSync(fd);fs.unlinkSync(lock)}}
 function commit(expectedRevision,changes){return exclusive(()=>{
  const before=read();if(expectedRevision!==before.revision)throw Error('STORE_STALE')
  if(!Array.isArray(changes)||!changes.length||changes.length>20000)throw Error('STORE_CHANGES_INVALID')
  const seen=new Set()
  for(const change of changes){
   if(!plain(change)||!validId(change.id)||seen.has(change.id))throw Error('STORE_CHANGE_INVALID');seen.add(change.id)
   const old=Object.hasOwn(before.records,change.id)?before.records[change.id]:undefined
   if(change.expectedRevision!==(old?.revision??0))throw Error('STORE_ENTITY_STALE')
   if(change.delete===true){if(!old)throw Error('STORE_MISSING');delete before.records[change.id]}
   else before.records[change.id]={id:change.id,type:change.type??old?.type,revision:(old?.revision??0)+1,data:structuredClone(change.data),refs:structuredClone(change.refs??old?.refs??[])}
  }
  before.revision++;check(before);atomic(file,before);return structuredClone(before)
 })}
 function backup(){const payload=read();return{format:'product-store-backup-v1',checksum:digest(payload),payload}}
 function restore(expectedRevision,envelope){return exclusive(()=>{
  const current=read();if(current.revision!==expectedRevision)throw Error('STORE_STALE')
  if(envelope?.format!=='product-store-backup-v1'||envelope.checksum!==digest(envelope.payload))throw Error('STORE_BACKUP_INVALID')
  const next=check(structuredClone(envelope.payload));next.revision=current.revision+1
  atomic(path.join(root,name+'-before-restore-'+randomUUID()+'.json'),{format:'product-store-backup-v1',checksum:digest(current),payload:current})
  atomic(file,next);return structuredClone(next)
 })}
 function migrate({fromVersion,expectedRevision,transform}){return exclusive(()=>{
  if(!Number.isInteger(fromVersion)||fromVersion>=schemaVersion||typeof transform!=='function')throw Error('STORE_MIGRATION_INVALID')
  const before=check(readFile(file),fromVersion,false);if(before.revision!==expectedRevision)throw Error('STORE_STALE')
  // Prepare and validate completely before replacing anything. Keep a durable old-schema backup.
  const next=transform(structuredClone(before));if(next?.then)throw Error('STORE_MIGRATION_SYNC_REQUIRED')
  check(next);next.revision=before.revision+1
  atomic(path.join(root,name+'-before-migration-'+randomUUID()+'.json'),{format:'product-store-backup-v1',checksum:digest(before),payload:before})
  atomic(file,next);return structuredClone(next)
 })}
 return{read,commit,backup,restore,migrate,recoverLock:()=>recoverDeadLock(root,name+'.json.lock')}
}
function recoverDeadLock(dataDir,name){
 if(typeof name!=='string'||name!==path.basename(name))throw Error('STORE_LOCK_INVALID')
 const file=path.join(fs.realpathSync(dataDir),name),info=fs.lstatSync(file)
 if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw Error('STORE_LOCK_INVALID')
 const raw=fs.readFileSync(file,'utf8'),row=JSON.parse(raw)
 if(!Number.isSafeInteger(row.pid)||row.pid<1)throw Error('STORE_LOCK_INVALID')
 try{process.kill(row.pid,0);throw Error('JOBS_OWNER_STILL_RUNNING')}catch(error){if(error.code!=='ESRCH')throw error}
 if(fs.readFileSync(file,'utf8')!==raw)throw Error('STORE_LOCK_CHANGED')
 fs.unlinkSync(file);return{recovered:true,previous_pid:row.pid}
}
module.exports={createDataStore,validId,recoverDeadLock}

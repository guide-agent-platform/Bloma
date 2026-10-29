const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto'),{spawn}=require('node:child_process')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
function inside(root,file){const actual=fs.realpathSync(file),relative=path.relative(fs.realpathSync(root),actual);if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))throw Error('FILES_OUTSIDE_DATA');return actual}
function createFileWorkflow({dataDir,store,validateImage}){
 const root=fs.realpathSync(dataDir),directory=path.join(root,'assets');fs.mkdirSync(directory,{recursive:true});inside(root,directory)
 if(fs.lstatSync(directory).isSymbolicLink())throw Error('FILES_PATH_INVALID')
 function importFile(file,{kind='document',dedupe=false}={}){
  const actual=fs.realpathSync(file),info=fs.statSync(actual),ext=path.extname(actual).toLowerCase()
  const formats={document:['.pdf','.docx','.txt','.md'],image:['.png','.jpg','.jpeg','.webp','.bmp'],audio:['.wav']}
  if(!formats[kind]?.includes(ext)||!info.isFile()||info.size<1||info.size>16*1024*1024)throw Error('FILES_INPUT_INVALID')
  const bytes=fs.readFileSync(actual);if(bytes.length!==info.size||bytes.length>16*1024*1024)throw Error('FILES_CHANGED')
  if(kind==='image'){
   const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP',bmp=bytes.toString('ascii',0,2)==='BM'
   if(!png&&!jpeg&&!webp&&!bmp||validateImage&&validateImage(bytes)!==true)throw Error('FILES_IMAGE_INVALID')
  }
  if(kind==='audio'&&(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE'||!bytes.includes(Buffer.from('data'))))throw Error('FILES_AUDIO_INVALID')
  const sha256=hash(bytes),before=store.read(),existing=Object.values(before.records).find(row=>row.type==='asset'&&row.data.sha256===sha256&&row.data.kind===kind)
  if(dedupe&&existing)return existing
  const target=path.join(directory,sha256+ext)
  if(fs.existsSync(target)){inside(root,target);if(fs.lstatSync(target).isSymbolicLink()||!fs.lstatSync(target).isFile()||hash(fs.readFileSync(target))!==sha256)throw Error('FILES_SNAPSHOT_CONFLICT')}
  else{const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}
  const id=randomUUID(),next=store.commit(before.revision,[{id,type:'asset',expectedRevision:0,data:{name:path.basename(actual),kind,sha256,bytes:bytes.length,path:path.relative(root,target),imported_at:new Date().toISOString()}}])
  return next.records[id]
 }
 function asset(id){const row=store.read().records[id];if(row?.type!=='asset')throw Error('FILES_ASSET_MISSING');const file=inside(root,path.join(root,row.data.path));if(!fs.statSync(file).isFile()||fs.statSync(file).size>16*1024*1024||hash(fs.readFileSync(file))!==row.data.sha256)throw Error('FILES_SOURCE_CHANGED');return{...row,file}}
 function extract(id,{signal,timeoutMs=30000}={}){
  const row=asset(id);if(row.data.kind!=='document')throw Error('FILES_DOCUMENT_REQUIRED')
  if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw Error('FILES_TIMEOUT_INVALID')
  signal?.throwIfAborted()
  return new Promise((resolve,reject)=>{
   const child=spawn(process.execPath,[path.join(__dirname,'product_document_worker.cjs'),row.file,root],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']})
   let text='',failure
   const stop=code=>{failure=Error(code);child.kill()}
   const abort=()=>stop('FILES_CANCELLED'),timer=setTimeout(()=>stop('FILES_TIMEOUT'),timeoutMs)
   signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort()
   child.stdout.on('data',chunk=>{text+=chunk;if(Buffer.byteLength(text)>8*1024*1024)stop('FILES_OUTPUT_LIMIT')})
   child.stderr.resume();child.once('error',error=>{failure=Error('FILES_WORKER_UNAVAILABLE')})
   child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(failure)return reject(failure);try{const result=JSON.parse(text.trim().split(/\r?\n/).at(-1));if(code!==0||!result.ok)throw Error(result.code??'FILES_PARSE_FAILED');asset(id);result.document.name=row.data.name;resolve(result.document)}catch(error){reject(error)}})
  })
 }
 async function preview(ids,{signal}={}){
  if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length)throw Error('FILES_BATCH_INVALID')
  const rows=[]
  for(const id of ids){signal?.throwIfAborted();try{const document=await extract(id,{signal});rows.push({assetId:id,ok:true,document})}catch(error){if(signal?.aborted)throw Error('FILES_CANCELLED');rows.push({assetId:id,ok:false,code:/^[A-Z][A-Z0-9_]+$/.test(error.message)?error.message:'FILES_PARSE_FAILED'})}}
  signal?.throwIfAborted();const before=store.read(),id=randomUUID()
  store.commit(before.revision,[{id,type:'import_preview',expectedRevision:0,data:{state:'ready',rows},refs:ids}]);return{id,rows}
 }
 function commitPreview(id,{expectedRevision,dedupe=false}={}){
  const before=store.read(),row=before.records[id];if(row?.type!=='import_preview'||row.data.state!=='ready'||row.revision!==expectedRevision)throw Error('FILES_PREVIEW_STALE')
  const changes=[],seen=new Set(Object.values(before.records).filter(item=>item.type==='document').map(item=>item.data.document.documentId)),committed=[]
  for(const item of row.data.rows.filter(item=>item.ok)){
   const source=asset(item.assetId);if(source.data.sha256!==item.document.documentId)throw Error('FILES_SOURCE_CHANGED')
   if(dedupe&&seen.has(item.document.documentId))continue
   const recordId=randomUUID();changes.push({id:recordId,type:'document',expectedRevision:0,data:{assetId:item.assetId,document:item.document},refs:[item.assetId]});seen.add(item.document.documentId);committed.push(recordId)
  }
  changes.push({id,type:'import_preview',expectedRevision:row.revision,data:{...row.data,state:'committed',committed},refs:row.refs});store.commit(before.revision,changes);return{committed,failed:row.data.rows.filter(item=>!item.ok)}
 }
 function exportSnapshot(){return store.backup()}
 function exportArchive(){
  const backup=exportSnapshot(),sources=new Map();let bytes=0
  for(const row of Object.values(backup.payload.records).filter(row=>row.type==='asset')){const source=asset(row.id),key=source.data.path;if(sources.has(key))continue;const content=fs.readFileSync(source.file);if((bytes+=content.length)>64*1024*1024)throw Error('FILES_ARCHIVE_LIMIT');sources.set(key,{path:key,sha256:source.data.sha256,base64:content.toString('base64')})}
  const payload={backup,files:[...sources.values()]};return{format:'product-archive-v1',checksum:hash(JSON.stringify(payload)),...payload}
 }
 function restoreArchive(expectedRevision,envelope){
  if(envelope?.format!=='product-archive-v1'||!Array.isArray(envelope.files)||envelope.files.length>20000||envelope.checksum!==hash(JSON.stringify({backup:envelope.backup,files:envelope.files})))throw Error('FILES_ARCHIVE_INVALID')
  const before=store.read();if(before.revision!==expectedRevision)throw Error('STORE_STALE')
  const rows=Object.values(envelope.backup?.payload?.records??{}).filter(row=>row.type==='asset'),staged=[],known=new Map();let bytes=0
  for(const file of envelope.files){
   const normalized=typeof file.path==='string'?file.path.replaceAll('\\','/'):'',match=/^assets\/([a-f0-9]{64})\.(pdf|docx|txt|md|png|jpg|jpeg|webp|bmp|wav)$/.exec(normalized)
   if(!match||match[1]!==file.sha256||typeof file.base64!=='string'||file.base64.length>24*1024*1024||known.has(normalized))throw Error('FILES_ARCHIVE_INVALID')
   const content=Buffer.from(file.base64,'base64');if(content.toString('base64')!==file.base64||content.length>16*1024*1024||(bytes+=content.length)>64*1024*1024||hash(content)!==file.sha256)throw Error('FILES_ARCHIVE_INVALID')
   known.set(normalized,content)
  }
  if(rows.some(row=>!known.has(String(row.data.path).replaceAll('\\','/'))||hash(known.get(String(row.data.path).replaceAll('\\','/')))!==row.data.sha256))throw Error('FILES_ARCHIVE_SOURCE_MISSING')
  try{
   for(const [relative,content]of known){const target=path.join(root,...relative.split('/'));if(fs.existsSync(target)){inside(root,target);if(fs.lstatSync(target).isSymbolicLink()||hash(fs.readFileSync(target))!==hash(content))throw Error('FILES_SNAPSHOT_CONFLICT')}else{const fd=fs.openSync(target,'wx',0o600);staged.push(target);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}}
   return store.restore(expectedRevision,envelope.backup)
  }catch(error){for(const target of staged)fs.rmSync(target,{force:true});throw error}
 }
 async function writeExport(file){const envelope=exportArchive(),target=path.resolve(file),temp=target+'.'+randomUUID()+'.tmp';if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('FILES_EXPORT_INVALID');try{await fsp.writeFile(temp,JSON.stringify(envelope),{flag:'wx',mode:0o600});await fsp.rename(temp,target);const read=JSON.parse(await fsp.readFile(target,'utf8'));if(read.checksum!==envelope.checksum)throw Error('FILES_EXPORT_READBACK_FAILED');return{checksum:read.checksum,records:Object.keys(read.backup.payload.records).length}}finally{await fsp.rm(temp,{force:true})}}
 return{importFile,asset,extract,preview,commitPreview,exportSnapshot,exportArchive,restoreArchive,writeExport}
}
module.exports={createFileWorkflow,inside}

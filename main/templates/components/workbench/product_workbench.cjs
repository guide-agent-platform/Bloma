const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto')
const {createDataStore}=require('./product_store.cjs'),{createJobQueue}=require('./product_jobs.cjs')
const {createFileWorkflow}=require('./product_files.cjs'),{createMediaWorkflow}=require('./product_media.cjs'),{createHttpWorkflow}=require('./product_http.cjs')
const {queryRecords,batchById}=require('./product_query.cjs'),{createProductSettings,dispatchSettings}=require('./product_settings.cjs')
const {createSecretStore}=require('./ai_secrets.cjs'),{createProductDiagnostics}=require('./product_diagnostics.cjs')
function createWorkbench({dataDir,safeStorage,dialog,nativeImage,recognizeImage,transcribeWav}){
 const resources=()=>({audio:!!process.env.BLOMA_SPEECH_PYTHON&&path.isAbsolute(process.env.BLOMA_SPEECH_PYTHON)&&fs.existsSync(process.env.BLOMA_SPEECH_PYTHON)&&!!process.env.BLOMA_SPEECH_MODEL_DIR&&path.isAbsolute(process.env.BLOMA_SPEECH_MODEL_DIR)&&['model.int8.onnx','tokens.txt','silero_vad.onnx'].every(name=>fs.existsSync(path.join(process.env.BLOMA_SPEECH_MODEL_DIR,name)))?'configured_not_verified':'unavailable',ocr:process.platform==='win32'?'windows_engine_not_language_verified':'unavailable'})
 const store=createDataStore({dataDir}),handlers={},queue=createJobQueue({dataDir,handlers}),settings=createProductSettings({dataDir,safeStorage})
 const files=createFileWorkflow({dataDir,store,validateImage:bytes=>!nativeImage.createFromBuffer(bytes).isEmpty()})
 const secrets=()=>{if(!safeStorage.isEncryptionAvailable()||safeStorage.getSelectedStorageBackend?.()==='basic_text')throw Error('CONNECTION_ENCRYPTION_UNAVAILABLE');return createSecretStore({dataDir,encrypt:key=>safeStorage.encryptString(key),decrypt:bytes=>safeStorage.decryptString(bytes)})}
 const http=createHttpWorkflow({dataDir,resolveKey:name=>name?secrets().get(name):undefined}),media=createMediaWorkflow({dataDir,store,files,queue,ai:settings.ai,recognizeImage,transcribeWav:async(file,options)=>{if(resources().audio==='unavailable'||!transcribeWav)throw Error('MEDIA_AUDIO_UNAVAILABLE');return transcribeWav(file,options)}}),diagnostics=createProductDiagnostics(dataDir)
 Object.assign(handlers,media.handlers,{parse:async(input,ctx)=>{ctx.progress(.1);const result=await files.preview(input.ids,{signal:ctx.signal});ctx.progress(1);return{previewId:result.id}},pull:async(input,ctx)=>{const result=await http.pull({...input,signal:ctx.signal});if(!result.ok)throw Error('SYNC_'+result.kind.toUpperCase());return result},sync:async(input,ctx)=>{
  const row=store.read().records[input.resultId];if(row?.type!=='analysis'||row.revision!==input.revision)throw Error('MEDIA_RESULT_STALE')
  const source=files.asset(row.data.assetId);if(source.revision!==row.data.sourceRevision||source.data.sha256!==row.data.sha256)throw Error('MEDIA_SOURCE_STALE')
  ctx.signal.throwIfAborted();ctx.beginEffect()
  const result=await http.submit({connectionId:input.connectionId,recordId:row.id,sourceRevision:row.revision,fields:{text:row.data.text,source_sha256:row.data.sha256},signal:ctx.signal})
  if(result.kind==='done'||result.kind==='rejected')ctx.finishEffect()
  if(!result.ok)throw Error(result.kind==='unknown'?'SYNC_RECONCILIATION_REQUIRED':'SYNC_WRITE_REJECTED')
  return result
 }})
 const methods={
  status:()=>({revision:store.read().revision,jobs:queue.list(),connections:http.settings(),sync:http.read(),resources:resources(),encryption:safeStorage.isEncryptionAvailable()?'available':'unavailable'}),
  query:input=>{const snapshot=store.read(),result=queryRecords({revision:snapshot.revision,records:{...snapshot.records,...http.read().records}},input);result.rows=result.rows.map(row=>({...row,displayName:row.data.name??row.data.document?.name??(row.data.assetId?snapshot.records[row.data.assetId]?.data.name:undefined)??(row.data.sourceId?snapshot.records[snapshot.records[row.data.sourceId]?.data.assetId]?.data.name:undefined)??row.data.fields?.title??({import_preview:'文档导入预览',cursor:'同步进度',event:'已接收通知',outbound:'同步操作'})[row.type]??'未命名记录'}));return result},
  async selectFiles({kind}){
   if(!['document','image','audio'].includes(kind))throw Error('FILES_INPUT_INVALID')
   const picked=await dialog.showOpenDialog({properties:['openFile','multiSelections'],filters:[{name:kind==='document'?'资料':kind==='image'?'图片':'音频',extensions:kind==='document'?['pdf','docx','txt','md']:kind==='image'?['png','jpg','jpeg','webp','bmp']:['wav']}]})
   if(picked.canceled)return{cancelled:true,imported:[],failed:[]}
   if(picked.filePaths.length>20)throw Error('FILES_BATCH_INVALID')
   const result={cancelled:false,imported:[],failed:[]}
   for(const file of picked.filePaths){try{result.imported.push(files.importFile(file,{kind}))}catch(error){result.failed.push({name:path.basename(file),code:'FILES_INPUT_INVALID'})}}
   return result
  },
  inspect({id}){
   const snapshot=store.read(),row=snapshot.records[id]??http.read().records[id];if(!row)throw Error('STORE_MISSING')
   const assetId=row.type==='asset'?id:row.data.assetId,source=assetId?files.asset(assetId):undefined
   const analyses=Object.values(snapshot.records).filter(item=>item.type==='analysis'&&item.data.assetId===assetId)
   const previewRows=row.type==='import_preview'?row.data.rows.map(item=>({name:snapshot.records[item.assetId]?.data.name??'来源文件',ok:item.ok,summary:item.ok?item.document.blocks.map(block=>block.text).join('\n').slice(0,600):'文件未能解析，成功资料仍可提交'})):null
   return{record:row,source:source?{id:source.id,...source.data}:null,analyses,previewRows,image:source?.data.kind==='image'?nativeImage.createFromPath(source.file).resize({width:700}).toDataURL():null}
  },
  parse:({ids})=>{if(!Array.isArray(ids)||ids.length<1||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||id.length>120))throw Error('FILES_BATCH_INVALID');return queue.enqueue({type:'parse',input:{ids},dedupeKey:'parse_'+createHash('sha256').update(JSON.stringify(ids)).digest('hex')})},
  commit:({id,revision,dedupe})=>files.commitPreview(id,{expectedRevision:revision,dedupe:dedupe===true}),
  analyze:input=>{if(input.mode==='vision'&&input.consent!==true)throw Error('MEDIA_CONSENT_REQUIRED');const {consent,...request}=input;return media.submit(request)},
  correct:input=>media.correct(input),
  cancel:({id})=>queue.cancel(id),
  resume:({id,reviewed})=>queue.resume(id,{reviewed:reviewed===true}),
  pull:({connectionId})=>queue.enqueue({type:'pull',input:{connectionId},dedupeKey:'pull_'+randomUUID()}),
  sync:({connectionId,resultId,revision,consent})=>{if(consent!==true)throw Error('SYNC_CONSENT_REQUIRED');return queue.enqueue({type:'sync',input:{connectionId,resultId,revision},dedupeKey:'sync_'+JSON.stringify([connectionId,resultId,revision])})},
  saveConnection({id,revision,entityRevision,config,key,webhookKey}){
   const before=http.settings();if(before.revision!==revision)throw Error('STORE_STALE')
   const staged=[],next=structuredClone(config)
   try{
    for(const[field,value]of [['secret_name',key],['webhook_secret_name',webhookKey]])if(value){const name='APP_HTTP_'+randomUUID().replaceAll('-','').toUpperCase();secrets().set(name,value);staged.push(name);next[field]=name}
    return http.saveConnection({id,revision,entityRevision,config:next})
   }catch(error){for(const name of staged)secrets().remove(name);throw error}
  },
  reconcile:input=>http.reconcile(input),
  async export(){const picked=await dialog.showSaveDialog({defaultPath:'资料归档.json',filters:[{name:'资料备份',extensions:['json']}]});if(picked.canceled||!picked.filePath)return{cancelled:true};return files.writeExport(picked.filePath)},
  async restore({revision}){const picked=await dialog.showOpenDialog({properties:['openFile'],filters:[{name:'资料备份',extensions:['json']}]});if(picked.canceled)return{cancelled:true};const file=picked.filePaths[0];if(!fs.statSync(file).isFile()||fs.statSync(file).size>128*1024*1024)throw Error('FILES_ARCHIVE_LIMIT');return files.restoreArchive(revision,JSON.parse(fs.readFileSync(file,'utf8')))},
  remove:({ids})=>batchById(ids,id=>{const before=store.read(),row=before.records[id];if(!row)throw Error('STORE_MISSING');return store.commit(before.revision,[{id,expectedRevision:row.revision,delete:true}])}),
  diagnostics:()=>diagnostics.read(),
 }
 let webhook
 methods.startWebhook=async({connectionId})=>{
  if(!http.settings().records[connectionId])throw Error('CONNECTION_MISSING')
  if(!webhook){webhook=require('node:http').createServer(async(req,res)=>{
   if(req.method!=='POST'||!req.url?.startsWith('/webhook/')){res.writeHead(404);res.end();return}
   let size=0;const chunks=[];try{for await(const chunk of req){if((size+=chunk.length)>1024*1024)throw Error('SYNC_EVENT_INVALID');chunks.push(chunk)}const result=await http.receive({connectionId:decodeURIComponent(req.url.slice('/webhook/'.length)),rawBody:Buffer.concat(chunks),timestamp:req.headers['x-webhook-timestamp'],signature:req.headers['x-webhook-signature']});res.writeHead(result.ok?200:409,{'Content-Type':'application/json'});res.end(JSON.stringify(result))}catch{res.writeHead(400);res.end('{"ok":false}')}
  });webhook.requestTimeout=15000;webhook.headersTimeout=10000;await new Promise((resolve,reject)=>{webhook.once('error',reject);webhook.listen(0,'127.0.0.1',resolve)})}
  return{url:`http://127.0.0.1:${webhook.address().port}/webhook/${encodeURIComponent(connectionId)}`,scope:'loopback_only'}
 }
 return{settings,dispatchSettings:(method,input)=>dispatchSettings(settings,method,input),dispatch:(method,input)=>diagnostics.operation(method,()=>{if(!Object.hasOwn(methods,method))throw Error('QUERY_INVALID');return methods[method](input??{})}),async close(){settings.cancel();if(webhook){webhook.closeAllConnections();await new Promise(resolve=>webhook.close(resolve))}await queue.close()}}
}
module.exports={createWorkbench}

const {createHash}=require('node:crypto')
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function createMediaWorkflow({dataDir,store,files,queue,ai,recognizeImage,transcribeWav}){
 function submit({assetId,mode,prompt='',route,language}){
  const source=files.asset(assetId)
  if(!['vision','ocr','audio'].includes(mode)||mode==='audio'&&source.data.kind!=='audio'||mode!=='audio'&&source.data.kind!=='image'||typeof prompt!=='string'||prompt.length>16000)throw Error('MEDIA_INPUT_INVALID')
  const input={assetId,assetRevision:source.revision,sha256:source.data.sha256,mode,prompt,route:route??null,language:language??null}
  return queue.enqueue({type:'media',input,dedupeKey:'media_'+hash(input)})
 }
 async function process(input,ctx){
  const source=files.asset(input.assetId)
  if(source.revision!==input.assetRevision||source.data.sha256!==input.sha256)throw Error('MEDIA_SOURCE_STALE')
  ctx.progress(.1);let text,scope
  if(input.mode==='vision'){
   if(!ai)throw Error('MEDIA_AI_UNAVAILABLE')
   const result=await ai.generate({dataDir,images:[source.file],prompt:input.prompt,route:input.route??undefined,signal:ctx.signal})
   if(!result.ok)throw Error('MEDIA_'+String(result.kind).toUpperCase())
   if(result.input_images?.[0]?.sha256!==input.sha256)throw Error('MEDIA_SOURCE_MISMATCH')
   text=result.text;scope='model_response_quality_unverified'
  }else if(input.mode==='ocr'){
   if(!recognizeImage)throw Error('MEDIA_OCR_UNAVAILABLE')
   const result=await recognizeImage(source.file,{dataDir,language:input.language,signal:ctx.signal});if(result.source_sha256!==input.sha256)throw Error('MEDIA_SOURCE_MISMATCH');text=result.text;scope='ocr_text_requires_review'
  }else{
   if(!transcribeWav)throw Error('MEDIA_AUDIO_UNAVAILABLE')
   text=await transcribeWav(source.file,{dataDir,signal:ctx.signal});scope='asr_text_requires_review'
  }
  ctx.signal.throwIfAborted();const current=files.asset(input.assetId)
  if(current.revision!==input.assetRevision||current.data.sha256!==input.sha256)throw Error('MEDIA_SOURCE_STALE')
  if(typeof text!=='string'||text.length>2*1024*1024)throw Error('MEDIA_RESULT_INVALID')
  const before=store.read(),id='analysis_'+hash(input),old=before.records[id]
  store.commit(before.revision,[{id,type:'analysis',expectedRevision:old?.revision??0,data:{assetId:input.assetId,sourceRevision:input.assetRevision,sha256:input.sha256,mode:input.mode,prompt:input.prompt,text,originalText:text,corrected:false,scope},refs:[input.assetId]}]);ctx.progress(1);return{resultId:id,assetId:input.assetId,sha256:input.sha256}
 }
 function correct({resultId,expectedRevision,text}){if(typeof text!=='string'||text.length>2*1024*1024)throw Error('MEDIA_CORRECTION_INVALID');const before=store.read(),row=before.records[resultId];if(row?.type!=='analysis'||row.revision!==expectedRevision)throw Error('MEDIA_RESULT_STALE');const source=files.asset(row.data.assetId);if(source.revision!==row.data.sourceRevision||source.data.sha256!==row.data.sha256)throw Error('MEDIA_SOURCE_STALE');return store.commit(before.revision,[{id:resultId,type:'analysis',expectedRevision,data:{...row.data,text,corrected:true},refs:row.refs}])}
 return{submit,correct,handlers:{media:process}}
}
module.exports={createMediaWorkflow}

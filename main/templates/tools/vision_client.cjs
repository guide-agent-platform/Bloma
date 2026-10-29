// Product-owned OpenAI chat-compatible image client. No Bloma IPC or channel keys.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto')
const {createHttpConnector}=require('./http_connector.cjs')
function mime(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png'
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg'
  if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return 'image/webp'
  return null
}
class VisionClient {
  async analyze({prompt,images, dataDir,config,signal}) {
    if(!config?.api_key||!config?.endpoint||!config?.model)return {ok:false,kind:'unconfigured',message:'请配置产品自己的模型服务'}
    if(typeof prompt!=='string'||prompt.length>64000||images!==undefined&&(!Array.isArray(images)||images.length<1||images.length>4))return {ok:false,kind:'invalid_response',message:'图片请求输入不合法'}
    try {
      const blocks=[{type:'text',text:prompt}],sources=[];let total=0
      if(images){
        if(typeof dataDir!=='string')throw Error('VISION_DATA_REQUIRED')
        const base=await fs.realpath(dataDir)
        for(const image of images){
          signal?.throwIfAborted()
          if(typeof image!=='string')throw Error('VISION_FILE_REQUIRED')
          const file=await fs.realpath(image),rel=path.relative(base,file),info=await fs.stat(file)
          if(path.isAbsolute(rel)||rel==='..'||rel.startsWith('..'+path.sep)||!info.isFile()||info.size>5*1024*1024||(total+=info.size)>5*1024*1024)throw Error('VISION_FILE_INVALID')
          const bytes=await fs.readFile(file),type=mime(bytes)
          if(!type||bytes.length!==info.size)throw Error('VISION_FILE_INVALID')
          sources.push({sha256:createHash('sha256').update(bytes).digest('hex'),media_type:type})
          blocks.push({type:'image_url',image_url:{url:`data:${type};base64,${bytes.toString('base64')}`}})
        }
      }
      const client=createHttpConnector({baseUrl:config.endpoint.replace(/\/+$/,'')+'/',network:config.network??'public',methods:['POST'],requestBytes:8*1024*1024,auth:{header:'Authorization',value:'Bearer '+config.api_key}})
      const response=await client.request('chat/completions',{method:'POST',body:{model:config.model,messages:[{role:'user',content:images?blocks:prompt}]},signal,timeoutMs:Math.min(60000,Math.max(100,Number(config.timeout??30)*1000))})
      if(!response.ok)return {ok:false,kind:['auth_error','rate_limited','invalid_response','cancelled','timeout'].includes(response.kind)?response.kind:'model_error',message:'模型请求未成功'}
      const text=response.data?.choices?.[0]?.message?.content
      if(typeof text!=='string'||!text.trim())return {ok:false,kind:'invalid_response',message:'模型未返回有效文本'}
      return {ok:true,kind:'success',text,input_images:sources,scope:'client_response_not_visual_correctness'}
    }catch{ return {ok:false,kind:signal?.aborted?'cancelled':'invalid_response',message:'图片或模型配置无效'} }
  }
}
module.exports={VisionClient}

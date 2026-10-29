const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto')
const {createHttpConnector}=require('./http_connector.cjs'),{readRoutes,publicRoutes,writeRoutes}=require('./ai_routes.cjs')
function mime(bytes){
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return'image/png'
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return'image/jpeg'
 if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')return'image/webp'
 return null
}
class AIService{
 constructor({resolveKey}={}){this.resolveKey=resolveKey}
 settings(dataDir){return publicRoutes(dataDir)}
 saveSettings(dataDir,value,expectedRevision){return writeRoutes(dataDir,value,expectedRevision)}
 async generate(request){
  const {prompt,images,dataDir,signal,system}=request??{}
  let config=request?.config
  try{
   if(signal?.aborted)return{ok:false,kind:'cancelled',message:'请求已取消'}
   if(!config){const routes=readRoutes(dataDir),name=request?.route??routes.default_route,row=Object.hasOwn(routes.routes,name)?routes.routes[name]:undefined;if(!row)return{ok:false,kind:'unconfigured',message:'请选择有效的AI服务'};const api_key=this.resolveKey?await this.resolveKey(row.api_key_env):process.env[row.api_key_env];config={...row,api_key}}
   if(typeof config?.api_key!=='string'||!config.api_key.trim()||typeof config?.endpoint!=='string'||!config.endpoint||typeof config?.model!=='string'||!config.model)return{ok:false,kind:'unconfigured',message:'请在产品设置中配置AI服务和Key'}
   const protocol=config.protocol??'openai-chat'
   if(config.provider!==undefined&&config.provider!=='real')throw Error('AI_PROVIDER_UNSUPPORTED')
   if(!['openai-chat','anthropic-messages'].includes(protocol)||typeof prompt!=='string'||prompt.length>64000||system!==undefined&&(typeof system!=='string'||system.length>16000)||images!==undefined&&(!Array.isArray(images)||images.length<1||images.length>4))throw Error('AI_INPUT_INVALID')
   const blocks=[{type:'text',text:prompt}],sources=[];let total=0
   if(images){
    if(typeof dataDir!=='string')throw Error('AI_DATA_REQUIRED');const base=await fs.realpath(dataDir)
    for(const image of images){signal?.throwIfAborted();if(typeof image!=='string')throw Error('AI_FILE_INVALID');const file=await fs.realpath(image),rel=path.relative(base,file),info=await fs.stat(file)
     if(path.isAbsolute(rel)||rel==='..'||rel.startsWith('..'+path.sep)||!info.isFile()||info.size>5*1024*1024||(total+=info.size)>5*1024*1024)throw Error('AI_FILE_INVALID')
     const bytes=await fs.readFile(file),type=mime(bytes);if(!type||bytes.length!==info.size)throw Error('AI_FILE_INVALID')
     sources.push({sha256:createHash('sha256').update(bytes).digest('hex'),media_type:type})
     blocks.push(protocol==='anthropic-messages'?{type:'image',source:{type:'base64',media_type:type,data:bytes.toString('base64')}}:{type:'image_url',image_url:{url:`data:${type};base64,${bytes.toString('base64')}`}})
    }
   }
   const maximum=config.max_tokens??2048,parameter=config.token_parameter??'max_tokens'
   if(!Number.isInteger(maximum)||maximum<1||maximum>8192||!['max_tokens','max_completion_tokens'].includes(parameter))throw Error('AI_OUTPUT_LIMIT_INVALID')
   const anthropic=protocol==='anthropic-messages',messages=[{role:'user',content:images?blocks:prompt}]
   if(system&&!anthropic)messages.unshift({role:'system',content:system})
   const body={model:config.model,messages,...(anthropic?{max_tokens:maximum,...(system?{system}:{})}:{[parameter]:maximum})}
   const client=createHttpConnector({baseUrl:config.endpoint.replace(/\/+$/,'')+'/',network:config.network??'public',methods:['POST'],requestBytes:8*1024*1024,
     auth:{header:anthropic?'x-api-key':'Authorization',value:anthropic?config.api_key:'Bearer '+config.api_key},headers:anthropic?{'anthropic-version':'2023-06-01'}:{}})
   const response=await client.request(anthropic?'messages':'chat/completions',{method:'POST',body,signal,timeoutMs:Math.min(60000,Math.max(100,Number(config.timeout??30)*1000))})
   if(!response.ok)return{ok:false,kind:['auth_error','rate_limited','invalid_response','cancelled','timeout'].includes(response.kind)?response.kind:'model_error',status:response.status,message:'AI服务请求未成功',...(response.retryAfterSeconds!==undefined?{retry_after_seconds:response.retryAfterSeconds}:{})}
   const text=anthropic?(Array.isArray(response.data?.content)?response.data.content.filter(b=>b.type==='text'&&typeof b.text==='string').map(b=>b.text).join(''):undefined):response.data?.choices?.[0]?.message?.content
   if(typeof text!=='string'||!text.trim())return{ok:false,kind:'invalid_response',message:'AI服务未返回有效文本'}
   return{ok:true,kind:'success',text,input_images:sources,protocol,scope:'client_response_not_model_quality'}
  }catch(error){return{ok:false,kind:signal?.aborted?'cancelled':'invalid_response',diagnostic_code:/^AI_[A-Z_]+$/.test(error?.message)?error.message:'AI_CONFIG_OR_INPUT_INVALID',message:'AI配置或输入无效'}}
 }
 analyze(request){return this.generate(request)}
}
module.exports={AIService}

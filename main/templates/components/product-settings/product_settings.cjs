// Product backend only. No dependency on Bloma IPC, channels, or filesystem paths.
const {randomUUID}=require('node:crypto')
const {AIService}=require('./ai_service.cjs')
const {validateRoutes}=require('./ai_routes.cjs')
const {createSecretStore,cleanupStagedSecrets}=require('./ai_secrets.cjs')

function createProductSettings({dataDir,safeStorage}) {
  let active, lastCheck
  const encrypted=()=>!!safeStorage?.isEncryptionAvailable() && safeStorage?.getSelectedStorageBackend?.()!=='basic_text'
  const store=()=>{
    if(!encrypted())throw Error('SETTINGS_ENCRYPTION_UNAVAILABLE')
    return createSecretStore({dataDir,encrypt:key=>safeStorage.encryptString(key),decrypt:bytes=>safeStorage.decryptString(bytes)})
  }
  const ai=new AIService({resolveKey:name=>store().get(name)})
  function read(){
    const settings=ai.settings(dataDir)
    if(lastCheck?.revision!==settings.revision)lastCheck=undefined
    return {settings,encryption:encrypted()?'available':'unavailable',routes:settings.routes.map(row=>({name:row.name,key_available:encrypted()&&store().has(row.api_key_env)})),connection:lastCheck??{kind:'not_checked'}}
  }
  function cancel(){active?.controller.abort();return{cancelled:!!active}}
  function save(input){
    if(!input||Object.keys(input).some(k=>!['config','revision','keys'].includes(k)))throw Error('SETTINGS_INPUT_INVALID')
    if(ai.settings(dataDir).revision!==input.revision)throw Error('AI_SETTINGS_STALE')
    const config=structuredClone(input.config)
    validateRoutes(config)
    const keys=input.keys??{}
    if(!keys||Array.isArray(keys)||typeof keys!=='object'||Object.keys(keys).some(name=>!Object.hasOwn(config.routes,name)))throw Error('SETTINGS_INPUT_INVALID')
    for(const key of Object.values(keys))if(typeof key!=='string'||!key.trim()||Buffer.byteLength(key)>8192)throw Error('AI_SECRET_VALUE_INVALID')
    const secrets=Object.keys(keys).length?store():undefined, staged=[]
    try{
      for(const [name,key] of Object.entries(keys)){
        // A new identity keeps the old route/key pair intact if the public save fails.
        const id='APP_AI_'+randomUUID().replaceAll('-','').toUpperCase()
        secrets.set(id,key);staged.push(id);config.routes[name].api_key_env=id
      }
      ai.saveSettings(dataDir,config,input.revision)
    }catch(error){
      const cleanup=cleanupStagedSecrets(secrets,staged,()=>ai.settings(dataDir).routes.map(row=>row.api_key_env))
      if(cleanup.uncertain)throw Error('SETTINGS_SAVE_OUTCOME_UNKNOWN')
      throw error
    }
    cancel();lastCheck=undefined
    return read()
  }
  async function check(input){
    if(!input||Object.keys(input).some(k=>!['revision','route','consent'].includes(k))||input.consent!==true)throw Error('SETTINGS_CHECK_CONSENT_REQUIRED')
    const snapshot=ai.settings(dataDir)
    if(snapshot.revision!==input.revision)throw Error('AI_SETTINGS_STALE')
    if(!snapshot.routes.some(row=>row.name===input.route))throw Error('SETTINGS_INPUT_INVALID')
    if(!encrypted())throw Error('SETTINGS_ENCRYPTION_UNAVAILABLE')
    if(active)throw Error('SETTINGS_CHECK_BUSY')
    const operation={controller:new AbortController(),revision:snapshot.revision};active=operation
    try{
      const result=await ai.generate({dataDir,route:input.route,prompt:'Reply with OK.',signal:operation.controller.signal})
      const current=ai.settings(dataDir).revision
      const kind=operation.controller.signal.aborted?'cancelled':current!==snapshot.revision?'stale':result.ok?'connected':result.kind
      // Never return the model response or key to the renderer.
      const status={kind,revision:snapshot.revision,route:input.route,at:new Date().toISOString(),scope:'connection_only'}
      if(current===snapshot.revision&&kind!=='cancelled'&&kind!=='stale')lastCheck=status
      return status
    }finally{if(active===operation)active=undefined}
  }
  // The bridge exposes no secret getter, arbitrary channel, or arbitrary AI request.
  return {read,save,check,cancel,ai}
}
const errors=new Set(['AI_SETTINGS_STALE','SETTINGS_SAVE_OUTCOME_UNKNOWN','SETTINGS_ENCRYPTION_UNAVAILABLE','SETTINGS_INPUT_INVALID','SETTINGS_CHECK_CONSENT_REQUIRED','SETTINGS_CHECK_BUSY','AI_ROUTE_INVALID','AI_ROUTES_INVALID','AI_SECRET_VALUE_INVALID'])
async function dispatchSettings(backend,method,input){
  if(!['read','save','check','cancel'].includes(method))return{ok:false,code:'SETTINGS_METHOD_INVALID'}
  try{return{ok:true,value:await backend[method](input)}}catch(error){return{ok:false,code:errors.has(error?.message)?error.message:'SETTINGS_OPERATION_FAILED'}}
}
module.exports={createProductSettings,dispatchSettings}

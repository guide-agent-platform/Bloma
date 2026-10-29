// Public route metadata only. Product keys stay in memory/its own secret store.
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto')
const allowed=new Set(['protocol','endpoint','model','api_key_env','timeout','max_tokens','network','token_parameter'])
function validateRoutes(value){
  if(!value||value.version!==1||Object.keys(value).some(k=>!['version','default_route','routes'].includes(k))||typeof value.default_route!=='string'||!value.routes||Array.isArray(value.routes)||Object.keys(value.routes).length<1||Object.keys(value.routes).length>16||!Object.hasOwn(value.routes,value.default_route))throw Error('AI_ROUTES_INVALID')
  for(const[name,route]of Object.entries(value.routes)){
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(name)||!route||Array.isArray(route)||Object.keys(route).some(k=>!allowed.has(k))||!['openai-chat','anthropic-messages'].includes(route.protocol)
      ||typeof route.endpoint!=='string'||route.endpoint.length>2048||typeof route.model!=='string'||route.model.length>160||!/^[A-Za-z0-9_.:/-]*$/.test(route.model)
      ||typeof route.api_key_env!=='string'||!/^APP_[A-Z0-9_]{1,80}$/.test(route.api_key_env)||!['public','loopback'].includes(route.network??'public')
      ||!Number.isFinite(route.timeout??30)||(route.timeout??30)<0.1||(route.timeout??30)>60||!Number.isInteger(route.max_tokens??2048)||(route.max_tokens??2048)<1||(route.max_tokens??2048)>8192
      ||route.token_parameter!==undefined&&!['max_tokens','max_completion_tokens'].includes(route.token_parameter))throw Error('AI_ROUTE_INVALID')
    if(route.endpoint){let url;try{url=new URL(route.endpoint)}catch{throw Error('AI_ROUTE_INVALID')};if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('AI_ROUTE_INVALID')}
  }
  return value
}
function readRoutes(dataDir){
  const override=dataDir&&path.join(fs.realpathSync(dataDir),'ai-service.json'),file=override&&fs.existsSync(override)?override:path.join(__dirname,'AI_SERVICE.template.json')
  if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()||fs.statSync(file).size>65536)throw Error('AI_ROUTES_FILE_INVALID')
  try{return validateRoutes(JSON.parse(fs.readFileSync(file,'utf8')))}catch{throw Error('AI_ROUTES_INVALID')}
}
const revision=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function publicRoutes(dataDir){const value=readRoutes(dataDir);return{version:1,revision:revision(value),default_route:value.default_route,routes:Object.entries(value.routes).map(([name,row])=>({name,protocol:row.protocol,endpoint:row.endpoint,model:row.model,api_key_env:row.api_key_env,timeout:row.timeout??30,max_tokens:row.max_tokens??2048,network:row.network??'public',token_parameter:row.token_parameter??'max_tokens',configured:!!row.endpoint&&!!row.model})),credentials:'runtime_only'}}
function writeRoutes(dataDir,value,expectedRevision){
 validateRoutes(value)
 const root=fs.realpathSync(dataDir),lock=path.join(root,'.ai-settings.lock'),descriptor=fs.openSync(lock,'wx')
 let temporary
 try{
  if(typeof expectedRevision!=='string'||revision(readRoutes(root))!==expectedRevision)throw Error('AI_SETTINGS_STALE')
  const text=JSON.stringify(value);if(Buffer.byteLength(text)>65536)throw Error('AI_ROUTES_INVALID')
  temporary=path.join(root,`.ai-settings-${randomUUID()}.tmp`);const output=fs.openSync(temporary,'wx',0o600)
  try{fs.writeFileSync(output,text);fs.fsyncSync(output)}finally{fs.closeSync(output)}
  fs.renameSync(temporary,path.join(root,'ai-service.json'));temporary=undefined
  return publicRoutes(root)
 }finally{fs.closeSync(descriptor);if(temporary)fs.rmSync(temporary,{force:true});fs.unlinkSync(lock)}
}
module.exports={readRoutes,validateRoutes,publicRoutes,writeRoutes}

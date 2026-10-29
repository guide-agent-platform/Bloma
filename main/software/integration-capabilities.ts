import {createHash} from 'node:crypto'
import {existsSync,lstatSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {mainRootDir} from '../platform/paths'
import {executeSoftwareCommand} from './command-runtime'

export const INTEGRATION_COMPONENTS={ocr:['ocr_runtime.cjs','ocr_worker.ps1'],http:['http_connector.cjs','webhook_inbox.cjs'],ai:['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs'],vision:['vision_client.cjs','ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs']} as const
export type IntegrationCapability=keyof typeof INTEGRATION_COMPONENTS
function components(root:string,kind:IntegrationCapability){return INTEGRATION_COMPONENTS[kind].map(name=>{
  const bytes=readFileSync(join(mainRootDir(),'templates/tools',name)),target=join(root,name),hash=(value:Buffer)=>createHash('sha256').update(value).digest('hex')
  const editable=name==='AI_SERVICE.template.json',regular=existsSync(target)&&lstatSync(target).isFile()&&!lstatSync(target).isSymbolicLink()
  const state=!existsSync(target)?'missing':regular&&editable&&lstatSync(target).size<=65536?'project_config':regular&&lstatSync(target).size===bytes.length&&hash(readFileSync(target))===hash(bytes)?'platform_component':'conflict'
  return{name,bytes,target,state,sha256:state==='project_config'?hash(readFileSync(target)):hash(bytes)}
})}
export async function inspectIntegrationCapability(projectId:string,root:string,kind:IntegrationCapability,signal:AbortSignal,language?:string){
  signal.throwIfAborted()
  const files=components(root,kind),materialized=files.every(file=>['platform_component','project_config'].includes(file.state))
  let runtime:Record<string,unknown>|undefined,error:string|undefined
  if(materialized){
    const source=kind==='ocr'?`require('./ocr_runtime.cjs').inspectOcr().then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e.message);process.exitCode=1})`:kind==='vision'||kind==='ai'?`const{AIService}=require('./ai_service.cjs');${kind==='vision'?`if(typeof require('./vision_client.cjs').VisionClient!=='function')throw Error('VISION_CLIENT_MISSING');`:''}console.log(JSON.stringify({node:process.versions.node,protocols:['openai-chat','anthropic-messages'],settings:new AIService().settings()}))`:`require('./http_connector.cjs');require('./webhook_inbox.cjs');console.log(JSON.stringify({node:process.versions.node,protocol:'json-http-and-hmac-sha256'}))`
    const result=await executeSoftwareCommand({projectId,root,signal,command:['node','-e',source],timeoutMs:30000})
    if(result.code===0)runtime=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)!);else error=result.stderr.slice(-1200)
  }
  const available=kind!=='ocr'||Array.isArray(runtime?.languages)&&runtime.languages.length>0&&(!language||runtime.languages.includes(language))
  return{capability:kind,components:files.map(({name,state,sha256})=>({name,state,sha256})),runtime,ready:materialized&&!!runtime&&available,
    requested_language:language,error:error??(!available?'OCR_LANGUAGE_UNAVAILABLE':undefined),product_verification:'unverified',external_effects:'unverified'}
}
export async function prepareIntegrationCapability(projectId:string,root:string,kind:IntegrationCapability,signal:AbortSignal,language?:string){
  signal.throwIfAborted()
  const files=components(root,kind)
  if(files.some(file=>file.state==='conflict'))throw Error('INTEGRATION_COMPONENT_CONFLICT: 保留已有文件并核对差异')
  for(const file of files){signal.throwIfAborted();if(file.state==='missing')writeFileSync(file.target,file.bytes,{flag:'wx'})}
  const result=await inspectIntegrationCapability(projectId,root,kind,signal,language)
  return{...result,status:result.ready?'prepared':'environment_blocked'}
}
export const MULTIMODAL_GUIDANCE={
  model_vision:'当前支持视觉的制作模型可读取图片附件。开发用inspect_app({include_image:true})附上实际截图；未附图时用view_image({debug_session_id})读取本会话当前截图，工程内参考图用view_image({path})。对比可见结构/颜色/布局及原需求，附图不等于看过或通过，旧源码截图需reload。',
  prepare:'OCR: inspect_software_capabilities({capability:"ocr"})；prepare_software_capability({capability:"ocr",language:"实际可用语言"})。不下载语言包，缺引擎/语言保持未就绪。',
  usage:'产品Node后端require("./ocr_runtime.cjs").recognizeImage(file,{dataDir:process.env.APP_DATA_DIR,language:"zh-Hans-CN",signal,timeoutMs:30000})。PNG/JPEG/BMP最大16MiB；Windows内置引擎返回原图SHA-256、文字、行及词框。空图返回no_text，不伪造文字。',
  scope:'OCR是机器识别结果，可能错字；图文语义理解/手写/视频/跨平台及真实视觉模型效果另验。文字位置属于原图，不把OCR结果当作已人工核对的原文。',
  audio:'语音沿既有speech准备与speech_bridge.cjs文件转写；真实麦克风另需明确授权和证据。本批不增加采集、TTS或模型调用。',
}
export const VISION_GUIDANCE={
  prepare:'prepare_software_capability({capability:"vision"})物化产品VisionClient和HTTP组件，无额外模型请求。OCR仅文字提取，不能代替视觉模型对图片的理解。',
  usage:'const {VisionClient}=require("./vision_client.cjs"); await new VisionClient().analyze({prompt:"描述图中内容",images:[产品数据目录内图片路径],dataDir:process.env.APP_DATA_DIR,config:{endpoint:"https://兼容服务/v1",model:"用户选择的视觉模型",api_key:"产品自己的Key",timeout:30},signal}); 本地测试显式network:"loopback"，生产默认HTTPS公网。',
  protocol:'与通用AIService共用文本/图片处理，可选择openai-chat或anthropic-messages；默认OpenAI聊天兼容保持旧入口。PNG/JPEG/WebP最多4图、合计5MiB；不支持远程图片URL、自动压缩、视频、Responses或流式/工具调用。',
  verify:'CORE_CHECK.json llm:{runtime:"node",module:"vision_client.cjs",factory:"VisionClient",method:"analyze",input:"vision",covers:[相关F编号]}。入口必须为产品实际调用路径。宿主以本地HTTP检查两张不同图片字节、换图、鉴权和错误，不能据此证明模型看懂图片或真实供应商可用。',
  boundary:'Bloma制作模型的图片输入、生成软件的视觉客户端、真实模型回答质量分别取证。产品不借平台渠道密钥，不能用OCR文本或文件名替代图片请求；视觉点评只作修复线索，不能替代业务操作和数据断言。',
}
export const AI_SERVICE_GUIDANCE={
  prepare:'prepare_software_capability({capability:"ai"})提供ai_service.cjs、ai_routes.cjs、AI_SERVICE.template.json和HTTP组件。准备不联网，不写Key，不签发业务PASS。可编辑公开路由模板，重跑准备保留用户路由；代码文件冲突拒绝覆盖。',
  configure:'Agent只填模板里的protocol、endpoint（带版本路径的API基地址）、model、api_key_env、timeout/max_tokens等公开参数。首期openai-chat及anthropic-messages，按具体模型选择max_tokens或max_completion_tokens。真实Key在产品设置/内存/产品自己的密钥存储中填写，传给resolveKey；也可由产品自己启动时注入APP_*环境变量。Bloma不会自动透传宿主环境或渠道Key。',
  usage:'const {AIService}=require("./ai_service.cjs"); const ai=new AIService({resolveKey:async name=>产品自己的密钥存储读取(name)}); await ai.generate({route:"default",prompt:"业务问题",images:可选图片路径数组,dataDir:process.env.APP_DATA_DIR,signal}); 不必每个项目重新写HTTP和解析。直接传config:{endpoint,model,api_key,protocol,...}也可兼容旧入口；analyze是同一方法别名。',
  settings:'ai.settings(APP_DATA_DIR)返回公开路由和revision，不证明连通；ai.saveSettings(APP_DATA_DIR,{version:1,default_route,routes:路由对象},expectedRevision)有锁/原子保存公开配置，拒绝陈旧修改和api_key等额外字段。运行配置优先于工程默认模板。文本/图片共享错误，不自动重试或切换付费路由。',
  keys:'可在产品后台用createSecretStore({dataDir,encrypt:key=>safeStorage.encryptString(key),decrypt:bytes=>safeStorage.decryptString(bytes)})（来自ai_secrets.cjs），先核对产品自己的safeStorage.isEncryptionAvailable()。set(name,key)保存密文，get(name)仅后台调用并注入resolveKey；无可信OS/keyring codec时不落盘、使用内存Key。CLI/服务可自行注入APP_*环境变量，Bloma不自动透传。不要把get函数暴露给renderer。',
  verify:'CORE_CHECK.json llm:{runtime:"node",module:"ai_service.cjs",factory:"AIService",method:"generate",protocol:"openai-chat"或"anthropic-messages",input:仅图片需求时填"vision",covers:[实际功能F编号]}。宿主分别验证协议、鉴权、错误、换图；入口须产品实际使用。不同协议/模型特性需明确配置，未实现的协议不能伪称兼容。',
  limits:'只有一次非流式响应；支持一个用户prompt及可选system、文本/图片输入与统一文本输出。不含多轮会话管理、自动工具调用、结构化输出强保证、OAuth或真实供应商连通认证。产品AI费用与制作模型账本分开，配置和本机测试不产生真实模型请求。',
}
export const PRODUCT_COMPONENT_RECIPES={
  components:[{id:'ai',provides:['文本/图片请求','公开多路由','运行时Key注入'],prepare:'ai',topic:'ai-service'},{id:'documents',provides:['资料文本','字面检索','精确引用'],prepare:'documents',topic:'documents'},{id:'http',provides:['JSON API','Webhook收件辅助'],prepare:'http',topic:'http-integration'},{id:'speech',provides:['已有ASR及文件转写桥'],prepare:'speech',topic:'verification-speech'}],
  recipes:[{name:'资料问答',uses:['documents','ai'],note:'产品保存来源与消息身份，真实回答与引用质量另验'},{name:'图片分析',uses:['ai'],note:'传真实图片，不以文件名/OCR文字替代视觉输入'},{name:'外部记录助手',uses:['http','ai'],note:'按确认范围组合；写操作和凭据由产品明确配置'}],
  scope:'可复用组件和组合参考，不新增用户需求，不自动安装/调用或证明完整产品通过'}
export const HTTP_GUIDANCE={
  prepare:'prepare_software_capability({capability:"http"})物化http_connector.cjs和webhook_inbox.cjs，无额外依赖/网络调用。它是产品后端组件，不是Bloma账号连接或新的需求capabilities标签。',
  client:'const {createHttpConnector}=require("./http_connector.cjs"); const api=createHttpConnector({baseUrl:"https://api.example.com/",methods:["GET"],auth:{header:"Authorization",value:"Bearer 产品自有凭据"}}); await api.request("items",{signal,timeoutMs:15000}); 需要写入时由产品明确配置POST/PUT/PATCH/DELETE及业务授权。',
  network:'默认HTTPS公网，固定来源、不跟随重定向；DNS校验并固定到实际连接，拒绝私网/保留地址。network:"loopback"仅显式配置的本机测试/服务使用；不支持任意内网网段。总超时、取消和有界JSON结果；失败不自动重试，避免重复副作用。',
  webhook:'verifyWebhook({secret,rawBody:Buffer,timestamp,signature})采用HMAC-SHA256(timestamp+"."+原始字节)，signature="sha256="+小写hex，时间窗±300秒。第三方签名格式须自己的适配。应用先从签名覆盖的负载取得eventId，再用createWebhookInbox(APP_DATA_DIR).accept({...参数,eventId})持久记录pending，业务提交后markDone(receipt)。',
  recovery:'重复pending须核对业务是否已执行，不自动重放；done明确拒绝重复，相同ID不同负载拒绝。收件记录不代替外部业务事务，不保证跨存储恰好一次。满1万记录需应用设计保留策略，不静默清空去重。',
  credentials:'产品设置提供自己的凭据，不借平台渠道Key；组件不记录凭据/原始请求或错误响应体。JSON合法不证明业务字段和权限正确，须产品自己的契约/错误映射。没有OAuth、真实服务适配、公网Webhook部署或外部成功证据。组件prepared和本机HTTP测试均不等于真实服务通过。',
}

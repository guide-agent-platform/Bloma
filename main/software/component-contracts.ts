import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mainRootDir } from '../platform/paths'

export const SETTINGS_FILES = ['product_settings.cjs', 'product_settings_ui.js', 'product_settings.css', 'product_settings.html', 'product_settings_electron.cjs', 'product_settings_preload.cjs'] as const
export function componentSource(name: string) {
  return join(mainRootDir(), 'templates', SETTINGS_FILES.includes(name as typeof SETTINGS_FILES[number]) ? 'components/product-settings' : 'tools', name)
}
const specs = {
  'product-settings': { title: '产品 AI 设置', files: ['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs',...SETTINGS_FILES], dependencies: {electron:'39.x (独立窗口适配)'}, schema: 'read(); save({config,revision,keys}); check({route,revision,consent:true}); cancel()', entry: 'createProductSettings + mountProductSettings', tests: ['tests/unit/software/product-settings.test.ts','scripts/verify-product-settings.mjs'], limits: 'Node/Electron 产品适配；HTTP业务配置后续B4a；保存不联网；连接不认证效果' },
  ai: { title: '通用 AI 服务', files: ['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','AI_SERVICE.template.json','http_connector.cjs'], dependencies: {}, schema: 'AI_SERVICE.template.json + ai_routes.cjs:validateRoutes', entry: 'AIService.generate/settings/saveSettings', tests: ['tests/unit/software/ai-service.test.ts'], limits: '非流式文本/图片；真实供应商及质量待验' },
  http: { title: 'HTTP / Webhook', files: ['http_connector.cjs','webhook_inbox.cjs'], dependencies: {}, schema: 'createHttpConnector({baseUrl,methods,auth,network}); verifyWebhook({secret,rawBody,timestamp,signature})', entry: 'createHttpConnector.request / createWebhookInbox', tests: ['tests/unit/software/http-connector.test.ts'], limits: '固定来源 JSON / 通用 HMAC；无 OAuth/公网托管；写操作不重试' },
  documents: { title: '文档文本与引用', files: ['document_runtime.cjs'], dependencies: {'pdfjs-dist':'6.4.299',mammoth:'1.13.0'}, schema: 'extractDocument(file,{dataDir}); searchDocuments(docs,query); verifyCitation(docs,citation)', entry: 'extractDocument/searchDocuments/verifyCitation', tests: ['tests/unit/software/document-capability.test.ts'], limits: '文本 PDF/DOCX/UTF-8；字面检索；不含 OCR/回答质量' },
} as const
const routeSchema = {
  type: 'object', additionalProperties: false, required: ['protocol','endpoint','model','api_key_env'],
  properties: {
    protocol: {enum:['openai-chat','anthropic-messages']}, endpoint:{type:'string',maxLength:2048},
    model:{type:'string',maxLength:160,pattern:'^[A-Za-z0-9_.:/-]*$'}, api_key_env:{type:'string',pattern:'^APP_[A-Z0-9_]{1,80}$'},
    timeout:{type:'number',minimum:0.1,maximum:60,default:30},max_tokens:{type:'integer',minimum:1,maximum:8192,default:2048},
    network:{enum:['public','loopback'],default:'public'},token_parameter:{enum:['max_tokens','max_completion_tokens'],default:'max_tokens'},
  },
}
const publicSchemas: Record<string, unknown> = {
  ai: {type:'object',additionalProperties:false,required:['version','default_route','routes'],properties:{version:{const:1},default_route:{type:'string'},routes:{type:'object',minProperties:1,maxProperties:16,propertyNames:{pattern:'^[A-Za-z0-9_-]{1,64}$'},additionalProperties:routeSchema}},semantic_validation:'ai_routes.cjs:validateRoutes; default_route must exist; endpoint parsed as URL without userinfo/query/hash'},
  http: {type:'object',required:['baseUrl'],properties:{baseUrl:{type:'string',format:'uri'},methods:{type:'array',items:{enum:['GET','POST','PUT','PATCH','DELETE']}},network:{enum:['public','loopback']},timeoutMs:{type:'integer'}},semantic_validation:'http_connector.cjs:createHttpConnector/request; credentials backend runtime only; DNS/origin checked at request time'},
  documents: {type:'object',required:['dataDir'],properties:{dataDir:{type:'string'}},semantic_validation:'document_runtime.cjs:extractDocument; real path within dataDir; limits enforced by runtime; signal is runtime-only'},
}
const behaviors: Record<string, unknown> = {
  ai: {output:'{ok,kind,text?,input_images?,protocol?}',errors:'unconfigured/auth_error/rate_limited/invalid_response/cancelled/timeout/model_error',cancellation:'generate({signal:AbortSignal}); request aborted, no retry',effects:'explicit generate sends one model request; settings reads public data; saveSettings writes public config with revision CAS'},
  http: {output:'request -> {ok,status?,data?,kind?}; verifyWebhook -> {valid,kind?,eventDigest?}',errors:'invalid configuration throws HTTP_*; request returns bounded category without response body',cancellation:'request(relative,{signal,timeoutMs}); no automatic retries',effects:'request may commit remote write before cancellation; verifyWebhook signature only; inbox pending needs business reconciliation'},
  documents: {output:'extractDocument -> documentId/blocks; searchDocuments -> hits/total; verifyCitation -> valid/reason',errors:'throws DOCUMENT_*; parser errors are not valid empty documents',cancellation:'no in-process AbortSignal; run parsing in a supervised worker/process with timeout and cancellation',effects:'reads source files within dataDir; no business persistence or model request'},
  'product-settings': {output:'bridge -> {ok,value? ,code?}; read returns public metadata and Key presence only',errors:'stale/encryption unavailable/input invalid; unexpected errors mapped to SETTINGS_OPERATION_FAILED',cancellation:'cancel() aborts active check; draft reset reloads saved public settings',effects:'save stages OS-encrypted Key then public CAS; failed save removes staged Key; check requires consent:true and sends one short request; old unreferenced encrypted Keys retained'},
}
export function componentContract(id: string) {
  if (!Object.hasOwn(specs, id)) return undefined
  const spec = specs[id as keyof typeof specs]
  if (!spec) return undefined
  const files = spec.files.map(name => ({ name, editable: name === 'AI_SERVICE.template.json', sha256: createHash('sha256').update(readFileSync(componentSource(name))).digest('hex') }))
  return { id, contract_version: 1, version: '1.0.0', title: spec.title, runtime: 'Node >=22', dependencies: spec.dependencies,
    files, source_revision: createHash('sha256').update(JSON.stringify(files)).digest('hex'), public_schema: publicSchemas[id === 'product-settings' ? 'ai' : id], configuration_contract: spec.schema, entry: spec.entry, behavior: behaviors[id],
    verification: { tests: spec.tests, scope: 'local_contract_only', product: 'unverified', external: 'unverified' }, limits: spec.limits,
    preparation: 'prepare_software_capability', policy: '保留公开配置；代码差异拒绝覆盖；摘要变化重新验证；不自动升级' }
}
export const componentContracts = () => Object.keys(specs).map(id => componentContract(id))

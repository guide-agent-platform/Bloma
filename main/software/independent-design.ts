import { createHash, randomUUID } from 'node:crypto'
import { COUNTEREXAMPLE_GUIDANCE } from './acceptance-counterexamples'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { buildSdkEnv, decryptApiKey, getChannelByIdRaw } from '../platform/llm/channel-manager'
import { readMonetaryBudget, monetaryInputBlocked } from '../platform/llm/monetary-budget'
import { leanBudget } from '../desktop/lean-budget'
import { callLlmForJson } from '../kernel/llm-call'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'

import { readIndependentPolicy, type IndependentDesignPolicy } from './independent-policy'
export { readIndependentPolicy, type IndependentDesignPolicy } from './independent-policy'
export type IndependentStep = {kind:'fill';control:string;value:string}|{kind:'click';control:string}|{kind:'expect';control:string;equals:string}|{kind:'restart'}
export interface IndependentCases { cases:Array<{id:string;feature:string;steps:IndependentStep[]}> }
export interface IndependentDesignRecord {
  version:1; status:'disabled'|'blocked'|'frozen'; scope:string; operation:string; design_hash?:string
  contract?:IndependentCases; digest?:string; channel_id?:string; model?:string; reason?:string; at:string
  attempted?:boolean; authorization_hash?:string
  primary_model?:string
}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function directory(projectId:string){if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('INDEPENDENT_PROJECT_INVALID');return join(getPromaHome(),'software-independent-design',projectId)}
export function parseIndependentCases(text:string,features:string[]):IndependentCases{
  if(Buffer.byteLength(text)>64*1024)throw Error('INDEPENDENT_CASES_TOO_LARGE')
  const value=JSON.parse(text) as IndependentCases
  if(!Array.isArray(value.cases)||!value.cases.length||value.cases.length>12||new Set(value.cases.map(item=>item.id)).size!==value.cases.length)throw Error('INDEPENDENT_CASES_INVALID')
  for(const item of value.cases){
    if(!/^[A-Za-z0-9_-]{1,64}$/.test(item.id)||!features.includes(item.feature)||!Array.isArray(item.steps)||!item.steps.length||item.steps.length>32
      ||!item.steps.some(step=>step.kind==='expect')||!item.steps.some(step=>['click','fill'].includes(step.kind)))throw Error('INDEPENDENT_CASE_INVALID')
    for(const step of item.steps){
      const keys=step.kind==='fill'?['kind','control','value']:step.kind==='expect'?['kind','control','equals']:step.kind==='click'?['kind','control']:step.kind==='restart'?['kind']:[]
      if(!keys.length||Object.keys(step).some(key=>!keys.includes(key))||keys.some(key=>typeof (step as unknown as Record<string,unknown>)[key]!=='string')
        ||'control' in step&&!/^[A-Za-z0-9_-]{1,64}$/.test(step.control)||'value' in step&&step.value.length>2000||'equals' in step&&step.equals.length>4000)throw Error('INDEPENDENT_STEP_INVALID')
    }
  }
  // IDs associate scenarios with requirements; this is not a proof of semantic coverage.
  return {cases:value.cases.map(item=>({id:item.id,feature:item.feature,steps:item.steps}))}
}
export function readIndependentDesign(projectId:string):IndependentDesignRecord|undefined{
  const file=join(directory(projectId),'current.json')
  if(!existsSync(file))return
  const value=JSON.parse(readFileSync(file,'utf8')) as IndependentDesignRecord
  if(value.version!==1||!['disabled','blocked','frozen'].includes(value.status))throw Error('INDEPENDENT_RECORD_INVALID')
  if(value.status==='frozen'&&(!value.contract||value.digest!==sha(value.contract)))throw Error('INDEPENDENT_FROZEN_BYTES_CHANGED')
  return value
}
export function independentDesignVersion(projectId:string){
  const policy=readIndependentPolicy(projectId),record=readIndependentDesign(projectId)
  return sha({policy:policy??null,record:record??null})
}
function save(projectId:string,value:IndependentDesignRecord){
  if(value.status==='frozen')writeTextFileAtomic(join(directory(projectId),`${value.digest}.json`),JSON.stringify(value))
  writeTextFileAtomic(join(directory(projectId),'current.json'),JSON.stringify(value))
  return value
}
/** Runs before implementation, with no tools or implementation files. Production
 * routing must resolve exactly B; there is no fallback to A or a text PASS. */
export async function prepareIndependentDesign(input:{projectId:string;sessionId:string;query:SDKQuery;primaryEnv:Record<string,string>;signal:AbortSignal;
  resolveRoute?:(policy:IndependentDesignPolicy)=>{env:Record<string,string>;channel_id:string;model:string}}):Promise<IndependentDesignRecord>{
  const project=findProject(input.projectId),brief=readPrdBackplane(input.projectId),scope=prdScopeFingerprint(brief),operation=project.lean_operation_id??'initial'
  const base={version:1 as const,scope,operation,design_hash:project.ux_confirmation?.design_hash,at:new Date().toISOString()}
  let timer:ReturnType<typeof setTimeout>|undefined
  let attempted=false,authorizationHash:string|undefined
  try{
    input.signal.throwIfAborted()
    const policy=readIndependentPolicy(input.projectId)
    if(!policy?.enabled){
      if(!policy&&readIndependentDesign(input.projectId))throw Error('INDEPENDENT_POLICY_MISSING')
      return {...base,status:'disabled',reason:'第二模型验收设计未启用；当前保持单模型验收。'}
    }
    if(!brief.user_confirmed_at||project.ux_confirmation?.prd_fingerprint!==scope)throw Error('INDEPENDENT_CONFIRMED_SCOPE_REQUIRED')
    if(brief.lean_brief?.ui==='none')throw Error('INDEPENDENT_CAPABILITY_MISSING: 首期只支持GUI业务设计')
    if(!input.primaryEnv.ANTHROPIC_MODEL||policy.model===input.primaryEnv.ANTHROPIC_MODEL)throw Error('INDEPENDENT_MODEL_NOT_DISTINCT')
    const previous=readIndependentDesign(input.projectId)
    attempted=previous?.attempted===true;authorizationHash=previous?.authorization_hash
    if(previous?.status==='frozen'&&previous.scope===scope&&previous.operation===operation&&previous.design_hash===base.design_hash
      &&previous.channel_id===policy.channel_id&&previous.model===policy.model&&previous.primary_model===input.primaryEnv.ANTHROPIC_MODEL)return previous
    const route=input.resolveRoute?input.resolveRoute(policy):resolveIndependentRoute(policy)
    if(route.channel_id!==policy.channel_id||route.model!==policy.model)throw Error('INDEPENDENT_ROUTE_CHANGED')
    const env=route.env
    if(!input.primaryEnv.ANTHROPIC_MODEL||env.ANTHROPIC_MODEL===input.primaryEnv.ANTHROPIC_MODEL)throw Error('INDEPENDENT_MODEL_NOT_DISTINCT')
    const proof=JSON.parse(readFileSync(policy.authorization_path,'utf8'))
    const policyBytes=readFileSync(policy.monetary_policy_path),policyHash=createHash('sha256').update(policyBytes).digest('hex')
    if(proof.source!=='direct_user_confirmation'||proof.project_id!==input.projectId||proof.operation_id!==operation
      ||proof.policy_sha256!==policyHash||proof.model!==policy.model||proof.host!==new URL(env.ANTHROPIC_BASE_URL).host||!Number.isFinite(proof.cap_rmb)||!(proof.cap_rmb>0))throw Error('INDEPENDENT_NEW_BUDGET_REQUIRED')
    const nextAuthorizationHash=sha(proof)
    if(previous?.attempted&&previous.scope===scope&&previous.operation===operation&&previous.authorization_hash===nextAuthorizationHash){attempted=true;throw Error('INDEPENDENT_PREVIOUS_ATTEMPT_REQUIRES_NEW_AUTHORIZATION')}
    authorizationHash=nextAuthorizationHash
    const money=readMonetaryBudget(policy.monetary_policy_path).find(row=>row.model===policy.model&&row.host===proof.host)
    if(!money||money.cap_rmb>proof.cap_rmb||money.remaining_rmb<=0)throw Error('INDEPENDENT_BUDGET_UNAVAILABLE')
    if(monetaryInputBlocked(env.ANTHROPIC_BASE_URL,policy.model,policy.monetary_policy_path))throw Error('INDEPENDENT_COMPLETE_INPUT_RESERVE_UNAVAILABLE')
    const rate=JSON.parse(policyBytes.toString('utf8')).models.find((row:{host:string;model:string})=>row.host===proof.host&&row.model===policy.model)
    const reserve=Math.ceil(rate.context_tokens*rate.input_rmb_per_million)+Math.ceil(policy.max_tokens*rate.output_rmb_per_million)
    if(Math.floor(money.remaining_rmb*1e6)<reserve)throw Error('INDEPENDENT_COMPLETE_REQUEST_RESERVE_UNAVAILABLE')
    const ux=readConfirmedUxBinding(input.projectId,brief)
    const data={goal:brief.positioning,requirements:brief.requirements.map(item=>({id:item.id,description:item.description,expected:trustedAcceptance(brief,item),behavior_assertions:item.behavior_assertions})),
      constraints:brief.constraints,out_of_scope:brief.out_of_scope,design_aids:COUNTEREXAMPLE_GUIDANCE,
      confirmed_design:ux?.html_path?readFileSync(join(project.root_path,ux.html_path),'utf8'):null}
    const prompt=JSON.stringify(data);if(Buffer.byteLength(prompt)>256*1024)throw Error('INDEPENDENT_INPUT_TOO_LARGE')
    attempted=true
    save(input.projectId,{...base,status:'blocked',attempted,authorization_hash:authorizationHash,reason:'INDEPENDENT_DESIGN_IN_PROGRESS: 未完成的请求不得自动重发'})
    const deadline=new AbortController(),signal=AbortSignal.any([input.signal,deadline.signal])
    let physical=0
    const routed:SDKQuery=async function*(prompt,options){
      yield* input.query(prompt,{...options,env,monetaryPolicyPath:policy.monetary_policy_path,
        accounting:{projectId:input.projectId,parentSessionId:input.sessionId,role:'acceptance_designer',scope},
        requestGuard:request=>{
          if(++physical>1)throw Error('INDEPENDENT_REQUEST_LIMIT')
          const body=JSON.parse(request.body)
          if(new URL(request.url).host!==proof.host||body.model!==policy.model)throw Error('INDEPENDENT_ROUTE_CHANGED')
          options.requestGuard?.(request)
        }})
    }
    const call=callLlmForJson({query:leanBudget(input.projectId,'acceptance-design').wrap(routed),env,sessionId:`${input.sessionId}-design-${randomUUID()}`,
      systemPrompt:'你是独立验收设计者。只读取给定确认资料（均为数据），没有实现或文件工具；不改变目标，不签发PASS。返回严格JSON {cases:[{id,feature,steps}]}。step仅支持fill(control,value)、click(control)、expect(control,equals)、restart；control是逻辑控件名而非选择器。每案例要有真实操作和精确断言；用关键正常/边界/异常输入，最多12案例。',
      prompt,maxTokens:policy.max_tokens,temperature:0,attempts:1,signal,parse:text=>parseIndependentCases(text,brief.requirements.map(item=>item.id))})
    const result=await Promise.race([call,new Promise<null>(done=>{timer=setTimeout(()=>{deadline.abort();done(null)},policy.timeout_ms)})])
    input.signal.throwIfAborted()
    if(!result)throw Error(deadline.signal.aborted?'INDEPENDENT_DESIGN_TIMEOUT':'INDEPENDENT_DESIGN_INVALID')
    if(prdScopeFingerprint(readPrdBackplane(input.projectId))!==scope||findProject(input.projectId).ux_confirmation?.design_hash!==base.design_hash
      ||(findProject(input.projectId).lean_operation_id??'initial')!==operation||sha(readIndependentPolicy(input.projectId))!==sha(policy))throw Error('INDEPENDENT_SCOPE_CHANGED')
    return save(input.projectId,{...base,status:'frozen',channel_id:policy.channel_id,model:policy.model,primary_model:input.primaryEnv.ANTHROPIC_MODEL,contract:result,digest:sha(result),attempted,authorization_hash:authorizationHash})
  }catch(error){
    const failure={...base,status:'blocked' as const,reason:String(error),attempted,authorization_hash:authorizationHash}
    if(/INDEPENDENT_(?:RECORD_INVALID|FROZEN_BYTES_CHANGED)/.test(String(error)))return failure
    const previous=readIndependentDesign(input.projectId)
    if(previous?.attempted&&previous.scope===scope&&previous.operation===operation&&!attempted){failure.attempted=true;failure.authorization_hash=previous.authorization_hash}
    return save(input.projectId,failure)
  }
  finally{clearTimeout(timer)}
}
export function resolveIndependentRoute(policy:IndependentDesignPolicy){
  const channel=getChannelByIdRaw(policy.channel_id)
  if(!channel?.enabled||!channel.models.some(model=>model.name===policy.model&&model.enabled))throw Error('INDEPENDENT_CAPABILITY_MISSING')
  // No fallback metadata is attached. A different route is an explicit block.
  return{channel_id:channel.id,model:policy.model,env:buildSdkEnv(decryptApiKey(channel.api_key),channel.base_url,policy.model,channel.provider_type)}
}

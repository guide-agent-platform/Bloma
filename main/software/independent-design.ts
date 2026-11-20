import { isAgentChannel } from '../../shared/channel-protocol'
import { independentBatches } from './independent-batches'
import { createHash, randomUUID } from 'node:crypto'
import { COUNTEREXAMPLE_GUIDANCE } from './acceptance-counterexamples'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance, requirementEvidenceHash } from '../project/requirement-contract'
import { readConfirmedUxBinding } from '../project/ux-binding'
import { buildSdkEnv, decryptApiKey, getChannelByIdRaw } from '../platform/llm/channel-manager'
import { readMonetaryBudget, monetaryInputBlocked } from '../platform/llm/monetary-budget'
import { leanBudget } from '../desktop/lean-budget'
import { callLlmForJson, type LlmAttemptFailure } from '../kernel/llm-call'
import { requirementCapabilities } from '../model/requirement-capabilities'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import { readQualityLedger } from './quality-store'
import { reviewIndependentCorrection, settleIndependentCorrection, type IndependentCorrection } from './independent-correction'

import { readIndependentPolicy, independentDesignMatchesPolicy, type IndependentDesignPolicy } from './independent-policy'
export { readIndependentPolicy, type IndependentDesignPolicy } from './independent-policy'
import { assessIndependentCases, independentCategoryRequested, IndependentCaseFormatError, parseIndependentCases, INDEPENDENT_CATEGORIES, INDEPENDENT_SEMANTICS_INSTRUCTIONS, type IndependentCases } from './independent-semantics'
export { parseIndependentCases } from './independent-semantics'
export type { IndependentCases, IndependentStep } from './independent-semantics'
export interface IndependentDesignRecord {
  version:1; status:'disabled'|'blocked'|'frozen'; scope:string; operation:string; design_hash?:string
  contract?:IndependentCases; digest?:string; channel_id?:string; model?:string; reason?:string; at:string
  attempted?:boolean; authorization_hash?:string
  primary_model?:string
  funding?:'project'
  correction?:IndependentCorrection
}
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function directory(projectId:string){if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('INDEPENDENT_PROJECT_INVALID');return join(getPromaHome(),'software-independent-design',projectId)}
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
  if (value.status === 'frozen') {
    const archive = join(directory(projectId), `${value.digest}.json`)
    if (!existsSync(archive)) writeTextFileAtomic(archive, JSON.stringify(value))
  }
  writeTextFileAtomic(join(directory(projectId),'current.json'),JSON.stringify(value))
  return value
}
/** Runs before implementation, with an independent context and no tools.
 * Explicit routes retain their own authorization; project-funded design inherits
 * the current production route and its existing accounting boundary. */
export async function prepareIndependentDesign(input:{projectId:string;sessionId:string;requestId?:string;query:SDKQuery;primaryEnv:Record<string,string>;signal:AbortSignal;
  maxTokens?:number; redesign?:boolean; previousFailure?:IndependentDesignRecord;
  resolveRoute?:(policy:IndependentDesignPolicy)=>{env:Record<string,string>;channel_id:string;model:string}}):Promise<IndependentDesignRecord>{
  const project=findProject(input.projectId),brief=readPrdBackplane(input.projectId),scope=prdScopeFingerprint(brief),operation=project.lean_operation_id??'initial'
  const base={version:1 as const,scope,operation,design_hash:project.ux_confirmation?.design_hash,at:new Date().toISOString()}
  let timer:ReturnType<typeof setTimeout>|undefined
  let attempted=false,authorizationHash:string|undefined
  let redesigning = false
  let proposed:IndependentCases|undefined
  try{
    input.signal.throwIfAborted()
    const policy=readIndependentPolicy(input.projectId)
    if(!policy?.enabled){
      if(!policy&&readIndependentDesign(input.projectId))throw Error('INDEPENDENT_POLICY_MISSING')
      return {...base,status:'disabled',reason:'第二模型验收设计未启用；当前保持单模型验收。'}
    }
    if(!brief.user_confirmed_at||project.ux_confirmation?.prd_fingerprint!==scope)throw Error('INDEPENDENT_CONFIRMED_SCOPE_REQUIRED')
    if(brief.lean_brief?.ui==='none')throw Error('INDEPENDENT_CAPABILITY_MISSING: 首期只支持GUI业务设计')
    const shared='funding' in policy
    if(!input.primaryEnv.ANTHROPIC_MODEL)throw Error('INDEPENDENT_PRIMARY_MODEL_REQUIRED')
    if(!shared&&policy.model===input.primaryEnv.ANTHROPIC_MODEL)throw Error('INDEPENDENT_MODEL_NOT_DISTINCT')
    const previous=readIndependentDesign(input.projectId)
    attempted=previous?.attempted===true;authorizationHash=previous?.authorization_hash
    const current = previous?.status === 'frozen' && previous.scope === scope && previous.operation === operation
      && previous.design_hash === base.design_hash && independentDesignMatchesPolicy(previous, policy) ? previous : undefined
    const findings = current ? readQualityLedger(input.projectId).findings.filter(row => row.independent?.design_digest === current.digest) : []
    const challenges=findings.filter(row=>row.challenge&&!row.challenge.resolution)
    const challengeVersion=sha(challenges)
    const assessment=shared&&input.redesign&&current?.contract?assessIndependentCases(brief,current.contract,
      challenges.map(row=>({case_id:row.independent!.case_id,reason:row.challenge!.reason,evidence:row.challenge!.evidence}))):undefined
    const repair = assessment && !assessment.ready ? assessment : undefined
    redesigning = !!repair
    if (current && !repair && current.primary_model === input.primaryEnv.ANTHROPIC_MODEL) return current
    const route=shared ? {env:input.primaryEnv,model:input.primaryEnv.ANTHROPIC_MODEL,channel_id:undefined}
      : input.resolveRoute?input.resolveRoute(policy):resolveIndependentRoute(policy)
    if(!shared&&(route.channel_id!==policy.channel_id||route.model!==policy.model))throw Error('INDEPENDENT_ROUTE_CHANGED')
    const env=route.env
    if(!shared&&env.ANTHROPIC_MODEL===input.primaryEnv.ANTHROPIC_MODEL)throw Error('INDEPENDENT_MODEL_NOT_DISTINCT')
    const batches=independentBatches(brief.requirements.map(r=>r.id))
    const maxTokens=shared ? input.maxTokens??4096 : policy.max_tokens
    const timeoutMs=shared ? undefined : policy.timeout_ms
    const monetaryPolicyPath=shared ? undefined : policy.monetary_policy_path
    if(shared){
      authorizationHash=sha({scope,operation,design_hash:base.design_hash,model:route.model,host:new URL(env.ANTHROPIC_BASE_URL).host,funding:'project'})
    }else{
      const proof=JSON.parse(readFileSync(policy.authorization_path,'utf8'))
      const policyBytes=readFileSync(policy.monetary_policy_path),policyHash=createHash('sha256').update(policyBytes).digest('hex')
      if(proof.source!=='direct_user_confirmation'||proof.project_id!==input.projectId||proof.operation_id!==operation
        ||proof.policy_sha256!==policyHash||proof.model!==policy.model||proof.host!==new URL(env.ANTHROPIC_BASE_URL).host||!Number.isFinite(proof.cap_rmb)||!(proof.cap_rmb>0))throw Error('INDEPENDENT_NEW_BUDGET_REQUIRED')
      if(batches.length>1&&(!Number.isSafeInteger(proof.max_design_requests)||proof.max_design_requests<batches.length||proof.max_design_requests>32))throw Error('INDEPENDENT_BATCH_AUTHORIZATION_REQUIRED: 当前授权没有覆盖所需批次，不自动增加请求')
      const nextAuthorizationHash=sha(proof)
      if(previous?.attempted&&previous.operation===operation&&previous.authorization_hash===nextAuthorizationHash){attempted=true;throw Error('INDEPENDENT_PREVIOUS_ATTEMPT_REQUIRES_NEW_AUTHORIZATION')}
      authorizationHash=nextAuthorizationHash
      const money=readMonetaryBudget(policy.monetary_policy_path).find(row=>row.model===policy.model&&row.host===proof.host)
      if(!money||money.cap_rmb>proof.cap_rmb||money.remaining_rmb<=0)throw Error('INDEPENDENT_BUDGET_UNAVAILABLE')
      if(monetaryInputBlocked(env.ANTHROPIC_BASE_URL,policy.model,policy.monetary_policy_path))throw Error('INDEPENDENT_COMPLETE_INPUT_RESERVE_UNAVAILABLE')
      const rate=JSON.parse(policyBytes.toString('utf8')).models.find((row:{host:string;model:string})=>row.host===proof.host&&row.model===policy.model)
      const reserve=Math.ceil(rate.context_tokens*rate.input_rmb_per_million)+Math.ceil(policy.max_tokens*rate.output_rmb_per_million)
      if(Math.floor(money.remaining_rmb*1e6)<reserve*batches.length)throw Error('INDEPENDENT_COMPLETE_REQUEST_RESERVE_UNAVAILABLE')
    }
    const ux=readConfirmedUxBinding(input.projectId,brief)
    const failure = input.previousFailure ?? previous
    const previousFormatIssue = shared && failure?.status === 'blocked'
      && failure.scope === scope && failure.operation === operation && failure.design_hash === base.design_hash
      && failure.authorization_hash === authorizationHash
      && /^Error: INDEPENDENT_(?:JSON_INVALID|CASES_(?:INVALID|TOO_LARGE)|CASE_INVALID|BASIS_INVALID|RELATED_INVALID|COVERAGE(?:_NOTES)?_INVALID|STEP_INVALID|ORACLE_INVALID|BATCH_CASE_(?:ID_INVALID|DUPLICATE))\b/.test(failure.reason ?? '')
      ? failure.reason?.slice(0, 500) : undefined
    const data={goal:brief.positioning,requirements:brief.requirements.map(item=>({id:item.id,description:item.description,expected:trustedAcceptance(brief,item),requirement_hash:requirementEvidenceHash(brief,item),behavior_assertions:item.behavior_assertions,capabilities:[...requirementCapabilities(item)],
      required_coverage:INDEPENDENT_CATEGORIES.filter(category=>independentCategoryRequested(brief,item.id,category))})),
      intent:brief.requirements_model,constraints:brief.constraints,assumptions:brief.assumptions,out_of_scope:brief.out_of_scope,design_aids:COUNTEREXAMPLE_GUIDANCE,
      user_instructions:brief.lean_brief?.intent_sources,
      confirmed_design:ux?.html_path?readFileSync(join(project.root_path,ux.html_path),'utf8'):null,
      ...(previousFormatIssue ? { previous_format_issue: previousFormatIssue } : {}),
      ...(repair ? { previous_design_feedback: {
        contract: input.previousFailure?.contract ?? current!.contract,
        original_contract: current!.contract,
        ...(input.previousFailure?.reason ? {review_issue:input.previousFailure.reason.slice(0,7000)} : {}),
        cases: repair.cases.filter(row => row.status === 'disputed').slice(0, 12).map(({ id, feature, issues }) => ({ id, feature, issues })),
        coverage: repair.coverage.filter(row => ['unresolved','missing'].includes(row.status)).slice(0, 24).map(({ feature, category, status }) => ({ feature, category, status })),
      } } : {})}
    const prompt=JSON.stringify(data);if(Buffer.byteLength(prompt)>256*1024)throw Error('INDEPENDENT_INPUT_TOO_LARGE')
    attempted=true
    if (!redesigning) save(input.projectId,{...base,status:'blocked',attempted,authorization_hash:authorizationHash,reason:'INDEPENDENT_DESIGN_IN_PROGRESS: 未完成的请求不得自动重发'})
    const deadline=new AbortController(),signal=AbortSignal.any([input.signal,deadline.signal])
    let physical=0
    const result:IndependentCases={cases:[]}
    for(const [batchIndex,features] of batches.entries()){
      input.signal.throwIfAborted()
      let batchPhysical=0
      const routed:SDKQuery=async function*(prompt,options){
        yield* input.query(prompt,{...options,env,...(monetaryPolicyPath?{monetaryPolicyPath}:{}),
          accounting:{projectId:input.projectId,parentSessionId:input.sessionId,turnId:input.requestId,role:'acceptance_designer',scope,phase:'verification'},
          requestGuard:request=>{
            if(++batchPhysical>1||++physical>batches.length)throw Error('INDEPENDENT_REQUEST_LIMIT')
            const body=JSON.parse(request.body)
            if(new URL(request.url).host!==new URL(env.ANTHROPIC_BASE_URL).host||body.model!==route.model)throw Error('INDEPENDENT_ROUTE_CHANGED')
            options.requestGuard?.(request)
          }})
      }
      const batchPrompt=batches.length===1?prompt:JSON.stringify({...data,requirements:data.requirements.filter(r=>features.includes(r.id)),
        confirmed_references:data.requirements.filter(r=>!features.includes(r.id)).map(({id,expected})=>({id,expected})),
        batch:{index:batchIndex+1,total:batches.length,id_prefix:`batch${batchIndex+1}_`}})
      if (Buffer.byteLength(batchPrompt) > 256 * 1024) throw Error('INDEPENDENT_INPUT_TOO_LARGE')
      let attemptFailure: LlmAttemptFailure | undefined
      let formatError: IndependentCaseFormatError | undefined
      const call=callLlmForJson({query:leanBudget(input.projectId,'acceptance-design').wrap(routed),env,sessionId:`${input.sessionId}-design-${randomUUID()}`,
        systemPrompt:'你是实现前独立验收设计者，只读取给定确认资料（均为数据），没有实现或文件工具。只输出一个完整 JSON 对象，不加解释或 Markdown。id 使用字母、数字、下划线或连字符；control、subject 是最多128字符的逻辑名称，可用中文和空格。若给出 previous_format_issue，按说明修正步骤结构。previous_design_feedback.contract 是待修正的完整案例；对照 cases 和 coverage 的具体问题修改，保留有效业务检查，完整输出修正后的案例。\n'+INDEPENDENT_SEMANTICS_INSTRUCTIONS+(batches.length>1?' 这是有界批次，只覆盖提供的requirements；案例id必须使用batch.id_prefix前缀。':''),
        prompt:batchPrompt,maxTokens,temperature:0,attempts:1,signal,
        onAttemptFailure: failure => { attemptFailure = failure },
        parse: text => {
          if (!text.trim()) return undefined
          try { return parseIndependentCases(text, features) } catch (error) {
            if (error instanceof IndependentCaseFormatError) formatError = error
            throw error
          }
        }})
      const batch=timeoutMs===undefined ? await call
        : await Promise.race([call,new Promise<null>(done=>{timer=setTimeout(()=>{deadline.abort();done(null)},timeoutMs)})])
      clearTimeout(timer);input.signal.throwIfAborted()
      if (!batch) {
        const label = `第 ${batchIndex + 1}/${batches.length} 批`
        if (deadline.signal.aborted) throw Error(`INDEPENDENT_DESIGN_TIMEOUT: ${label}`)
        if (attemptFailure?.termination === 'output_limit') throw Error(`INDEPENDENT_DESIGN_OUTPUT_LIMIT: ${label}达到模型输出上限`)
        if (formatError) throw Error(`${formatError.message}（${label}）`)
        if (attemptFailure?.kind === 'error') throw Error(`INDEPENDENT_DESIGN_REQUEST_FAILED: ${label}模型调用或请求准入失败`)
        if (attemptFailure?.kind === 'empty') throw Error(`INDEPENDENT_DESIGN_EMPTY: ${label}模型未返回正文`)
        throw Error(`INDEPENDENT_DESIGN_INVALID: ${label}未返回可解析的案例`)
      }
      if(batches.length>1&&batch.cases.some(c=>!c.id.startsWith(`batch${batchIndex+1}_`)))throw Error('INDEPENDENT_BATCH_CASE_ID_INVALID')
      if(batch.cases.some(c=>result.cases.some(old=>old.id===c.id)))throw Error('INDEPENDENT_BATCH_CASE_DUPLICATE')
      writeTextFileAtomic(join(directory(input.projectId),`batch-${authorizationHash}-${batchIndex}.json`),JSON.stringify({scope,operation,features,contract:batch,digest:sha(batch)}))
      result.cases.push(...batch.cases);if(batch.coverage_notes)(result.coverage_notes??=[]).push(...batch.coverage_notes)
      if(prdScopeFingerprint(readPrdBackplane(input.projectId))!==scope||sha(readIndependentPolicy(input.projectId))!==sha(policy))throw Error('INDEPENDENT_SCOPE_CHANGED')
    }
    if(prdScopeFingerprint(readPrdBackplane(input.projectId))!==scope||findProject(input.projectId).ux_confirmation?.design_hash!==base.design_hash
      ||(findProject(input.projectId).lean_operation_id??'initial')!==operation||sha(readIndependentPolicy(input.projectId))!==sha(policy))throw Error('INDEPENDENT_SCOPE_CHANGED')
    let correction:IndependentCorrection|undefined
    if (repair && findings.some(row => row.challenge || row.checks.length)) {
      proposed=result
      const revised=assessIndependentCases(brief,result)
      if (!revised.ready) throw Error('INDEPENDENT_CORRECTION_INVALID: '+JSON.stringify({cases:revised.cases.filter(row=>row.status==='disputed'),coverage:revised.coverage.filter(row=>['missing','unresolved'].includes(row.status))}))
      correction = await reviewIndependentCorrection({projectId:input.projectId,sessionId:input.sessionId,
        before:current!.contract!,after:result,from:current!.digest!,findings,requirements:data.requirements,
        query:leanBudget(input.projectId,'acceptance-design').wrap(async function*(prompt,options){
          yield* input.query(prompt,{...options,accounting:{projectId:input.projectId,parentSessionId:input.sessionId,turnId:input.requestId,role:'acceptance_designer',scope,phase:'verification'}})
        }),env,maxTokens,signal})
    }
    input.signal.throwIfAborted()
    if (redesigning && (sha(readIndependentDesign(input.projectId))!==sha(current)
      ||sha(readQualityLedger(input.projectId).findings.filter(row=>row.independent?.design_digest===current!.digest&&row.challenge&&!row.challenge.resolution))!==challengeVersion
      ||prdScopeFingerprint(readPrdBackplane(input.projectId))!==scope
      ||findProject(input.projectId).ux_confirmation?.design_hash!==base.design_hash
      ||(findProject(input.projectId).lean_operation_id??'initial')!==operation
      ||sha(readIndependentPolicy(input.projectId))!==sha(policy))) throw Error('INDEPENDENT_SCOPE_CHANGED')
    const saved=save(input.projectId,{...base,status:'frozen',...(shared?{funding:'project' as const}:{}),channel_id:route.channel_id,model:route.model,primary_model:input.primaryEnv.ANTHROPIC_MODEL,contract:result,digest:sha(result),attempted,authorization_hash:authorizationHash,...(correction?{correction}:{})})
    settleIndependentCorrection(input.projectId,saved)
    return saved
  }catch(error){
    const failure={...base,status:'blocked' as const,reason:String(error),attempted,authorization_hash:authorizationHash,...(redesigning&&proposed?{contract:proposed}:{})}
    if(/INDEPENDENT_(?:RECORD_INVALID|FROZEN_BYTES_CHANGED)/.test(String(error)))return failure
    const previous=readIndependentDesign(input.projectId)
    if(previous?.attempted&&previous.scope===scope&&previous.operation===operation&&!attempted){failure.attempted=true;failure.authorization_hash=previous.authorization_hash}
    return redesigning ? failure : save(input.projectId,failure)
  }
  finally{clearTimeout(timer)}
}
export function resolveIndependentRoute(policy:IndependentDesignPolicy){
  const channel=getChannelByIdRaw(policy.channel_id)
  if(!channel?.enabled||!isAgentChannel(channel)||!channel.models.some(model=>model.name===policy.model&&model.enabled))throw Error('INDEPENDENT_CAPABILITY_MISSING')
  // No fallback metadata is attached. A different route is an explicit block.
  return{channel_id:channel.id,model:policy.model,env:buildSdkEnv(decryptApiKey(channel.api_key),channel.base_url,policy.model,channel.provider_type,channel.models.find(row=>row.name===policy.model),channel.protocol)}
}

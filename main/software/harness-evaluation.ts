import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { readIndependentPolicy } from './independent-design'
import { independentPolicyDigest } from './independent-policy'
import { readConfirmedUxBinding } from '../project/ux-binding'

export interface EvaluationTask {id:string;goal:string;delivery:'browser'|'desktop'|'command';requirements:Array<{description:string;expected:string}>;constraints:string[];out_of_scope:string[]}
export interface EvaluationProtocol {version:1;id:string;mode:'offline'|'paid';budget_rmb:number;tasks:EvaluationTask[];digest:string}
export interface EvaluationBinding {version:1;run_id:string;project_id:string;task_id:string;variant:'single'|'independent';protocol:EvaluationProtocol;scope:string;design_hash?:string;independent_policy_digest?:string;at:string}
export interface EvaluationEvent {version:1;seq:number;event_id:string;host_id:string;at:number;kind:string;data:Record<string,unknown>}
const hostId=randomUUID(),poisoned=new Set<string>()
const sha=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function folder(projectId:string){if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('EVALUATION_PROJECT_INVALID');return join(getPromaHome(),'harness-evaluation',projectId)}
/** Confirmation scope includes project ID; paired delegated designs must not. */
function evaluationDesignHash(projectId:string){
  const brief=readPrdBackplane(projectId)
  readConfirmedUxBinding(projectId,brief)
  return brief.lean_brief?.ui==='none'?undefined:brief.lean_brief?.preview==='skip'
    ?sha({kind:'delegated-ui',delivery:brief.lean_brief.delivery}):findProject(projectId).ux_confirmation?.html_hash??undefined
}
export function createEvaluationProtocol(tasks:EvaluationTask[],mode:'offline'|'paid'='offline',budget=0):EvaluationProtocol{
  if(!['offline','paid'].includes(mode)||!Number.isFinite(budget)||budget<0||mode==='paid'&&budget<=0
    ||!Array.isArray(tasks)||!tasks.length||new Set(tasks.map(task=>task.id)).size!==tasks.length)throw Error('EVALUATION_PROTOCOL_INVALID')
  for(const task of tasks)if(!/^[A-Za-z0-9_-]+$/.test(task.id)||!task.goal||!['browser','desktop','command'].includes(task.delivery)||!task.requirements?.length
    ||task.requirements.some(item=>!item.description||!item.expected)||!Array.isArray(task.constraints)||!Array.isArray(task.out_of_scope))throw Error('EVALUATION_TASK_INVALID')
  const fields={version:1 as const,id:randomUUID(),mode,budget_rmb:budget,tasks:structuredClone(tasks)}
  return {...fields,digest:sha(fields)}
}
export function validateEvaluationProtocol(protocol:EvaluationProtocol){
  const {digest,...fields}=protocol
  if(protocol.version!==1||digest!==sha(fields))throw Error('EVALUATION_PROTOCOL_CHANGED')
}
/** Enroll before user confirmation; bind the exact confirmed target at production
 * entry. This avoids a timing race with the normal confirmation -> build flow. */
export function stageEvaluationRun(projectId:string,protocol:EvaluationProtocol,taskId:string,variant:'single'|'independent',runId:string,authorizationPath?:string){
  validateEvaluationProtocol(protocol)
  const project=findProject(projectId),base=folder(projectId)
  if(project.workflow_version!=='software-v1'||!protocol.tasks.some(task=>task.id===taskId)||!['single','independent'].includes(variant)||!/^[A-Za-z0-9_-]{1,100}$/.test(runId))throw Error('EVALUATION_RUN_INVALID')
  if(['binding.json','pending.json'].some(name=>existsSync(join(base,name)))||existsSync(join(getPromaHome(),'software-run-states',projectId+'.json'))
    ||existsSync(join(getPromaHome(),'software-independent-design',projectId,'current.json')))throw Error('EVALUATION_RUN_ALREADY_BOUND')
  if((readIndependentPolicy(projectId)?.enabled===true)!==(variant==='independent'))throw Error('EVALUATION_VARIANT_ROUTE_MISMATCH')
  if(protocol.mode==='paid'&&!authorizationPath)throw Error('EVALUATION_NEW_BUDGET_REQUIRED')
  const value={version:1,project_id:projectId,operation_id:project.lean_operation_id,protocol,task_id:taskId,variant,run_id:runId,
    independent_policy_digest:independentPolicyDigest(projectId),authorization_path:authorizationPath}
  writeTextFileAtomic(join(base,'pending.json'),JSON.stringify(value))
  return{project_id:projectId,run_id:runId,status:'awaiting_confirmed_target',admission:'not_checked'}
}
export function activatePendingEvaluation(projectId:string){
  const file=join(folder(projectId),'pending.json')
  if(!existsSync(file))return
  const pending=JSON.parse(readFileSync(file,'utf8')),project=findProject(projectId)
  validateEvaluationProtocol(pending.protocol)
  if(pending.version!==1||pending.project_id!==projectId||pending.operation_id!==project.lean_operation_id
    ||pending.independent_policy_digest!==independentPolicyDigest(projectId))throw Error('EVALUATION_PENDING_CHANGED')
  const binding=join(folder(projectId),'binding.json')
  if(existsSync(binding)){
    const saved=JSON.parse(readFileSync(binding,'utf8')) as EvaluationBinding
    if(saved.run_id!==pending.run_id||saved.protocol.digest!==pending.protocol.digest||saved.variant!==pending.variant
      ||saved.task_id!==pending.task_id||saved.scope!==prdScopeFingerprint(readPrdBackplane(projectId))
      ||saved.design_hash!==evaluationDesignHash(projectId))throw Error('EVALUATION_PENDING_CHANGED')
    return saved
  }
  return bindEvaluationRun(projectId,pending.protocol,pending.task_id,pending.variant,pending.run_id,pending.authorization_path)
}
/** Sealing a study run is bookkeeping, never model spending authorization. */
export function bindEvaluationRun(projectId:string,protocol:EvaluationProtocol,taskId:string,variant:'single'|'independent',runId:string,authorizationPath?:string){
  validateEvaluationProtocol(protocol)
  const project=findProject(projectId),brief=readPrdBackplane(projectId),task=protocol.tasks.find(task=>task.id===taskId)
  if(!task||!['single','independent'].includes(variant)||!/^[A-Za-z0-9_-]{1,100}$/.test(runId)||!brief.user_confirmed_at)throw Error('EVALUATION_RUN_INVALID')
  if(task.goal!==brief.positioning||task.requirements.length!==brief.requirements.length||task.requirements.some(expected=>!brief.requirements.some(item=>item.description===expected.description&&trustedAcceptance(brief,item)===expected.expected))
    ||task.delivery!==brief.lean_brief?.delivery||sha([...task.constraints].sort())!==sha([...(brief.constraints??[])].sort())
    ||sha([...task.out_of_scope].sort())!==sha([...brief.out_of_scope].sort()))throw Error('EVALUATION_CONFIRMED_TARGET_MISMATCH')
  if(protocol.mode==='paid'){
    if(!authorizationPath)throw Error('EVALUATION_NEW_BUDGET_REQUIRED')
    const proof=JSON.parse(readFileSync(authorizationPath,'utf8'))
    if(proof.source!=='direct_user_confirmation'||proof.project_id!==projectId||proof.operation_id!==project.lean_operation_id||proof.protocol_digest!==protocol.digest
      ||proof.cap_rmb!==protocol.budget_rmb)throw Error('EVALUATION_NEW_BUDGET_REQUIRED')
  }
  if((readIndependentPolicy(projectId)?.enabled===true)!==(variant==='independent'))throw Error('EVALUATION_VARIANT_ROUTE_MISMATCH')
  const file=join(folder(projectId),'binding.json')
  if(existsSync(file))throw Error('EVALUATION_RUN_ALREADY_BOUND: 保留原失败记录，另用新隔离项目')
  const value:EvaluationBinding={version:1,run_id:runId,project_id:projectId,task_id:taskId,variant,protocol,scope:prdScopeFingerprint(brief),design_hash:evaluationDesignHash(projectId),independent_policy_digest:independentPolicyDigest(projectId),at:new Date().toISOString()}
  writeTextFileAtomic(file,JSON.stringify(value));recordEvaluationEvent(projectId,'bound',{run_id:runId});return value
}
/** Optional observation only. A broken collector cannot create usable study
 * evidence; it does not interrupt an otherwise authorized product operation. */
export function recordEvaluationEvent(projectId:string,kind:string,data:Record<string,unknown>={},at=Date.now()):boolean{
  const base=folder(projectId),binding=join(base,'binding.json'),events=join(base,'events.jsonl')
  if(!existsSync(binding))return false
  try{
    const bound=JSON.parse(readFileSync(binding,'utf8')) as EvaluationBinding;validateEvaluationProtocol(bound.protocol)
    const previous=existsSync(events)?readFileSync(events,'utf8').split(/\r?\n/).filter(Boolean):[]
    if(kind==='user_intervention'&&data.message_id&&previous.some(line=>{const event=JSON.parse(line) as EvaluationEvent;return event.kind===kind&&event.data.message_id===data.message_id}))return true
    if(previous.length>=20000)throw Error('EVALUATION_EVENT_LIMIT')
    mkdirSync(base,{recursive:true})
    const event:EvaluationEvent={version:1,seq:previous.length+1,event_id:randomUUID(),host_id:hostId,at,kind,data:{...data,
      ...(poisoned.has(base)?{recording_error:true}:{}),scope_current:prdScopeFingerprint(readPrdBackplane(projectId)),variant_current:readIndependentPolicy(projectId)?.enabled?'independent':'single',independent_policy_digest_current:independentPolicyDigest(projectId),design_current:evaluationDesignHash(projectId)}}
    appendFileSync(events,JSON.stringify(event)+'\n');return true
  }catch(error){poisoned.add(base);console.warn('Evaluation evidence unavailable:',String(error).slice(0,160));return false}
}
export function summarizeEvaluation(binding:EvaluationBinding,events:EvaluationEvent[]){
  validateEvaluationProtocol(binding.protocol)
  const issues:string[]=[],seen=new Set<string>()
  let previous=-Infinity
  for(const [index,event]of events.entries()){
    if(event.version!==1||event.seq!==index+1||seen.has(event.event_id)||!Number.isFinite(event.at)||event.at<previous)issues.push('invalid event sequence')
    seen.add(event.event_id);previous=event.at
    if(event.data.recording_error)issues.push('recording failure')
    if(event.data.scope_current!==binding.scope)issues.push('confirmed target changed')
    if(!['accounting_snapshot','defect_audit','user_intervention'].includes(event.kind)&&event.data.variant_current!==binding.variant)issues.push('execution route changed or unknown')
    if(binding.independent_policy_digest&&!['accounting_snapshot','defect_audit','user_intervention'].includes(event.kind)&&event.data.independent_policy_digest_current!==binding.independent_policy_digest)issues.push('acceptance policy changed or unknown')
    if(binding.independent_policy_digest&&!['accounting_snapshot','defect_audit','user_intervention'].includes(event.kind)&&event.data.design_current!==binding.design_hash)issues.push('confirmed design changed or unknown')
  }
  const executionEvents=events.filter(event=>!['bound','accounting_snapshot','defect_audit','user_intervention'].includes(event.kind))
  if(new Set(executionEvents.map(event=>event.host_id)).size>1)issues.push('host restart/interruption requires separate accounting')
  const start=events.find(event=>event.kind==='operation_started')??events.find(event=>event.kind==='run_state'&&event.data.status==='running')
  const trial=events.find(event=>event.kind==='trial_ready'&&(!start||event.at>=start.at))
  const end=events.filter(event=>(event.kind==='delivery_final'&&event.data.status==='delivered'||event.kind==='run_state'&&['blocked','cancelled','interrupted','waiting_environment','waiting_user'].includes(String(event.data.status)))&&start&&event.at>=start.at).at(-1)
  if(!start||!end)issues.push('run incomplete')
  let repair:{at:number;category:string}|undefined,productRepair=0,harnessRepair=0,unknownRepair=0
  for(const event of events){
    if(repair&&event.kind==='run_state'){
      const elapsed=Math.max(0,event.at-repair.at)
      if(repair.category==='product_assertion')productRepair+=elapsed
      else if(['harness','test_adapter','environment'].includes(repair.category))harnessRepair+=elapsed
      else unknownRepair+=elapsed
      repair=undefined
    }
    if(event.kind==='repair_started')repair={at:event.at,category:String(event.data.category??'unknown')}
  }
  if(repair)issues.push('repair interval incomplete')
  if(unknownRepair>0)issues.push('repair category unknown')
  if(!trial&&binding.protocol.tasks.find(task=>task.id===binding.task_id)?.delivery!=='command')issues.push('first actual trial unobserved')
  const audits=events.filter(event=>event.kind==='defect_audit').slice(-1),usage=events.filter(event=>event.kind==='accounting_snapshot').at(-1)
  if(!usage)issues.push('accounting snapshot missing')
  let physicalRequests:number|null=null,cost:number|null=null,accountingEvidence:unknown=null,implementationModels:string[]=[],implementationHosts:string[]=[]
  let acceptanceModels:string[]=[],acceptanceHosts:string[]=[],acceptanceRequests:number|null=null
  if(usage){
    try{
      const proof=usage.data.evidence as {ledger_path:string;ledger_sha256:string;cost_path?:string;cost_sha256?:string}
      const bytes=readFileSync(proof.ledger_path)
      if(createHash('sha256').update(bytes).digest('hex')!==proof.ledger_sha256)throw Error('ledger bytes changed')
      const entries=bytes.toString('utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line))
      if(entries.some(entry=>entry.project_id!==binding.project_id))throw Error('foreign project accounting')
      if(entries.some(entry=>entry.event==='transport_started'&&(typeof entry.query_id!=='string'||!Number.isSafeInteger(entry.transport_index)||entry.transport_index<1)))throw Error('transport identity missing')
      physicalRequests=new Set(entries.filter(entry=>entry.event==='transport_started').map(entry=>`${entry.query_id}:${entry.transport_index}`)).size
      implementationModels=[...new Set<string>(entries.filter(entry=>entry.event==='query_started'&&entry.role!=='acceptance_designer').map(entry=>entry.model).filter(value=>typeof value==='string'))].sort()
      implementationHosts=[...new Set<string>(entries.filter(entry=>entry.event==='query_started'&&entry.role!=='acceptance_designer').map(entry=>entry.endpoint_host).filter(value=>typeof value==='string'))].sort()
      const designer=entries.filter(entry=>entry.event==='query_started'&&entry.role==='acceptance_designer')
      acceptanceModels=[...new Set<string>(designer.map(entry=>entry.model).filter(value=>typeof value==='string'))].sort()
      acceptanceHosts=[...new Set<string>(designer.map(entry=>entry.endpoint_host).filter(value=>typeof value==='string'))].sort()
      const designerQueries=new Set(designer.map(entry=>entry.query_id))
      acceptanceRequests=new Set(entries.filter(entry=>entry.event==='transport_started'&&designerQueries.has(entry.query_id)).map(entry=>`${entry.query_id}:${entry.transport_index}`)).size
      if(binding.variant==='single'&&designer.length)issues.push('single run used acceptance designer')
      if(acceptanceModels.some(model=>implementationModels.includes(model)))issues.push('acceptance designer model is not distinct')
      if(binding.protocol.mode==='paid'&&binding.variant==='independent'&&end?.data.status==='delivered'&&(!acceptanceModels.length||!acceptanceHosts.length||!acceptanceRequests))issues.push('acceptance designer accounting missing')
      if(binding.protocol.mode==='paid'&&(!implementationModels.length||!implementationHosts.length))issues.push('implementation route accounting missing')
      accountingEvidence=proof
      if(proof.cost_path){
        const money=readFileSync(proof.cost_path)
        if(createHash('sha256').update(money).digest('hex')!==proof.cost_sha256)throw Error('cost evidence changed')
        const value=JSON.parse(money.toString('utf8'))
        if(value.run_id!==binding.run_id||value.project_id!==binding.project_id||value.protocol_digest!==binding.protocol.digest||value.covered_requests!==physicalRequests||value.external_changes!==false||!Number.isFinite(value.spent_rmb)||value.spent_rmb<0
          ||value.source!=='direct_user_confirmation'&&!(binding.protocol.mode==='offline'&&value.source==='offline_fixture'))throw Error('cost evidence invalid')
        cost=value.spent_rmb
        if(binding.protocol.mode==='paid'&&cost!==null&&cost>binding.protocol.budget_rmb)issues.push('budget exceeded')
      }else issues.push('cost unknown; no user-confirmed balance evidence')
    }catch(error){physicalRequests=null;cost=null;acceptanceRequests=null;acceptanceModels=[];acceptanceHosts=[];issues.push(`accounting evidence invalid: ${String(error)}`)}
  }
  let missed:number|null=null,falsePositives:number|null=null
  if(!audits.length)issues.push('independent defect audit missing')
  for(const event of audits){
    try{
      const proof=event.data.evidence as {path:string;sha256:string},bytes=readFileSync(proof.path)
      if(createHash('sha256').update(bytes).digest('hex')!==proof.sha256)throw Error('audit bytes changed')
      const value=JSON.parse(bytes.toString('utf8'))
      if(value.run_id!==binding.run_id||value.project_id!==binding.project_id||value.protocol_digest!==binding.protocol.digest||!Number.isSafeInteger(value.missed)||value.missed<0||!Number.isSafeInteger(value.false_positives)||value.false_positives<0
        ||!['independent_host_audit','human_review'].includes(value.source)&&!(binding.protocol.mode==='offline'&&value.source==='offline_fixture'))throw Error('audit identity invalid')
      missed=(missed??0)+value.missed;falsePositives=(falsePositives??0)+value.false_positives
    }catch(error){issues.push(`defect audit invalid: ${String(error)}`);missed=null;falsePositives=null}
  }
  return{run_id:binding.run_id,task_id:binding.task_id,variant:binding.variant,mode:binding.protocol.mode,budget_rmb:binding.protocol.budget_rmb,
    status:end?.data.status??'incomplete',comparable:issues.length===0,issues:[...new Set(issues)],
    first_trial_ms:start&&trial?trial.at-start.at:null,delivery_ms:start&&end?.data.status==='delivered'?end.at-start.at:null,
    elapsed_ms:start&&end?end.at-start.at:null,product_repair_ms:productRepair,harness_repair_ms:harnessRepair,unclassified_repair_ms:unknownRepair,
    failures:events.filter(event=>event.kind==='verification_result'&&event.data.status!=='passed'&&event.data.status!=='reused'||event.kind==='run_state'&&['blocked','cancelled','interrupted'].includes(String(event.data.status))).map(event=>({kind:event.kind,at:event.at,...event.data} as Record<string,unknown>)),
    physical_requests:physicalRequests,cost_rmb:cost,accounting_evidence:accountingEvidence,
    implementation_models:implementationModels,implementation_hosts:implementationHosts,
    acceptance_models:acceptanceModels,acceptance_hosts:acceptanceHosts,acceptance_physical_requests:acceptanceRequests,
    user_interventions:events.filter(event=>event.kind==='user_intervention').length,
    missed_defects:missed,false_positives:falsePositives,
    note:binding.protocol.mode==='offline'?'离线工程样例；不用于模型质量、成功率、速度或成本收益推断。':'描述性单次记录；失败、中止及未知费用必须保留。'}
}
export function evaluationReport(directories:string[]){
  const runs=directories.map(directory=>{const binding=JSON.parse(readFileSync(join(directory,'binding.json'),'utf8')) as EvaluationBinding
    const events=readFileSync(join(directory,'events.jsonl'),'utf8').split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line) as EvaluationEvent)
    return{binding,summary:summarizeEvaluation(binding,events)}})
  const pairs=runs.filter(run=>run.binding.variant==='single').map(single=>{
    const matches=runs.filter(run=>run.binding.variant==='independent'&&run.binding.task_id===single.binding.task_id&&run.binding.protocol.digest===single.binding.protocol.digest
      &&run.binding.design_hash===single.binding.design_hash)
    const singles=runs.filter(run=>run.binding.variant==='single'&&run.binding.task_id===single.binding.task_id&&run.binding.protocol.digest===single.binding.protocol.digest&&run.binding.design_hash===single.binding.design_hash)
    const independent=matches.length===1&&singles.length===1?matches[0]:undefined
    const isolated=Boolean(independent&&independent.binding.project_id!==single.binding.project_id&&independent.binding.run_id!==single.binding.run_id)
    const sameImplementation=Boolean(independent&&sha(single.summary.implementation_models)===sha(independent.summary.implementation_models)&&sha(single.summary.implementation_hosts)===sha(independent.summary.implementation_hosts))
    return{task_id:single.binding.task_id,single:single.binding.run_id,independent:independent?.binding.run_id??null,
      comparable:Boolean(independent&&isolated&&sameImplementation&&single.summary.comparable&&independent.summary.comparable),reason:!independent?'missing or ambiguous fixed-target/budget/design peer':!isolated?'paired runs must use separate projects and run IDs':!sameImplementation?'implementation model/channel changed':!single.summary.comparable||!independent.summary.comparable?'run evidence incomplete or invalid':null}
  })
  return{version:1,runs:runs.map(run=>run.summary),pairs,decision:'真实付费对照尚未执行时，不能得出引入第二模型的收益结论；不计算模型可靠性成功率。'}
}

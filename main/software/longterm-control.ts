import { resolve } from 'node:path'
import type { LongtermActionInput } from '../../shared/types'
import { readLongtermState, saveLongtermState, isLongtermSoftware, longtermPendingDecision } from './longterm-state'
import { loadSoftwareRelease, promoteSoftwareRelease, sealSoftwareRelease, verifyReleaseSource } from './release-store'
import { verifySoftwareCandidate } from './verification'
import { findProject, updateProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { commitDesktopDelivery } from '../desktop/delivery-state'
import { recordEvaluationEvent } from './harness-evaluation'
import { adoptLeanSuggestions } from '../guide/lean-suggestions'
import { stageLeanScope } from '../guide/lean-scope'
import { withLeanRuntime, leanBudget } from '../desktop/lean-budget'

type Emit=(type:'message_delta'|'stage_changed'|'user_decision_required'|'longterm_changed',data:Record<string,unknown>)=>void
export async function performLongtermAction(input:LongtermActionInput,signal:AbortSignal,deps:{busy:boolean;emit:Emit;verify?:typeof verifySoftwareCandidate}){
  signal.throwIfAborted()
  if(!isLongtermSoftware(input.project_id)||!Number.isSafeInteger(input.revision))throw Error('LONGTERM_CONTEXT_INVALID')
  if(['archived','abandoned'].includes(findProject(input.project_id).status))throw Error('LONGTERM_PROJECT_ARCHIVED: 先显式恢复项目')
  const state=readLongtermState(input.project_id),current=state?.milestones.find(item=>item.id===state.current_id)
  if(!state||state.revision!==input.revision)throw Error('LONGTERM_STATE_STALE')
  if(!['confirm','later','adopt_backlog','archive'].includes(input.action))throw Error('LONGTERM_ACTION_INVALID')
  const notify=()=>deps.emit('longterm_changed',{summary:findProject(input.project_id).longterm_summary})
  if(input.action==='adopt_backlog'){
    const item=state.backlog.find(item=>item.id===input.backlog_id)
    if(!item||!['deferred','adopt_requested'].includes(item.state))throw Error('LONGTERM_BACKLOG_STALE')
    if(current&&['awaiting_confirmation','confirming'].includes(current.status))throw Error('LONGTERM_CONFIRM_CURRENT_MILESTONE_FIRST')
    item.state='adopt_requested'
    if(deps.busy){const next=saveLongtermState(state);notify();return{state:next,detail:'已保留选择，当前制作继续；空闲后再次选择才更新范围。'}}
    const previous=readPrdBackplane(input.project_id),nextBrief=adoptLeanSuggestions(previous,[item],[item.id])
    stageLeanScope(input.project_id,input.session_id,input.request_id,previous,nextBrief,deps.emit,{adoptedSuggestions:[item]})
    item.state='staged';const next=saveLongtermState(state);notify();return{state:next,detail:'已更新下一轮任务单，确认范围后才开工。'}
  }
  if(input.action==='archive'){
    if(deps.busy||current?.status!=='delivered')throw Error('LONGTERM_DELIVERED_MILESTONE_REQUIRED_TO_ARCHIVE')
    state.archived_at=new Date().toISOString();const next=saveLongtermState(state)
    updateProject(input.project_id,{status:'archived'});notify();return{state:next,detail:'长期项目已归档，版本、待办、决策和数据保留。'}
  }
  if(!current||!['awaiting_confirmation','confirming'].includes(current.status)||current.session_id!==input.session_id)throw Error('LONGTERM_PENDING_OWNER_MISMATCH')
  if(input.action==='later'){
    current.deferred_at=new Date().toISOString();const next=saveLongtermState(state);notify()
    return{state:next,detail:'里程碑和可用版本已保留，待办没有自动开工。'}
  }
  if(deps.busy)throw Error('LONGTERM_WAIT_FOR_ACTIVE_WORK')
  const project=findProject(input.project_id),scope=prdScopeFingerprint(readPrdBackplane(input.project_id))
  if(scope!==current.scope_hash||(project.lean_operation_id??'initial')!==current.operation_id||!current.candidate_id||!current.source_digest||!current.request_id)throw Error('LONGTERM_PENDING_SCOPE_CHANGED')
  const finalize=await withLeanRuntime(input.project_id,'desktop-verify',signal,async activeSignal=>{
  const candidate=await loadSoftwareRelease(input.project_id,current.candidate_id!,activeSignal)
  if(candidate.source.digest!==current.source_digest||resolve(candidate.sourceRoot)!==resolve(project.root_path)||candidate.verified?.scope!==scope)throw Error('LONGTERM_PENDING_VERSION_CHANGED')
  await verifyReleaseSource(candidate,activeSignal)
  const result=await(deps.verify??verifySoftwareCandidate)(input.project_id,current.request_id!,activeSignal,false,candidate)
  if(result.status!=='passed'||result.candidate?.id!==candidate.id)throw Error(`LONGTERM_CURRENT_VERIFICATION_REQUIRED: ${result.summary}`)
  const stillCurrent=()=>readLongtermState(input.project_id)?.revision===state.revision&&prdScopeFingerprint(readPrdBackplane(input.project_id))===scope&&isLongtermSoftware(input.project_id)
  activeSignal.throwIfAborted();if(!stillCurrent())throw Error('LONGTERM_PENDING_CHANGED_DURING_CONFIRMATION')
  const evidence={version:result.core?.fingerprint??candidate.verified!.version,scope,at:new Date().toISOString()}
  await sealSoftwareRelease(candidate,evidence,activeSignal,stillCurrent)
  return async()=>{
  signal.throwIfAborted();if(!stillCurrent())throw Error('LONGTERM_PENDING_CHANGED_DURING_CONFIRMATION')
  // Persist the human's version-bound intent before changing the active release.
  // A crash leaves an explicit incomplete confirmation which needs a new click.
  current.status='confirming';current.confirmation_requested_at=new Date().toISOString()
  const intent=saveLongtermState(state)
  const stillIntentCurrent=()=>readLongtermState(input.project_id)?.revision===intent.revision&&prdScopeFingerprint(readPrdBackplane(input.project_id))===scope&&isLongtermSoftware(input.project_id)
  const began=Date.now();let accounted=false
  try{await promoteSoftwareRelease(candidate,evidence,signal,()=>{leanBudget(input.project_id,'desktop-verify').recordRuntime(Date.now()-began);accounted=true;return stillIntentCurrent()})}
  finally{if(!accounted)leanBudget(input.project_id,'desktop-verify').recordRuntime(Date.now()-began)}
  commitDesktopDelivery(input.project_id,signal)
  current.status='delivered';current.confirmed_at=new Date().toISOString()
  let next:typeof state
  try{next=saveLongtermState(intent)}catch(error){
    try{updateProject(input.project_id,{status:'active',current_stage:'blocked_for_user_decision',desktop_phase:'desktop-verify',longterm_summary:{status:'awaiting_confirmation',pending_items:state.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state)).length,milestone:current.title}})}catch{/* canonical pending file still refuses a new confirmation */}
    throw error
  }
  recordEvaluationEvent(input.project_id,'delivery_final',{status:'delivered',candidate_id:candidate.id,milestone_id:current.id})
  deps.emit('stage_changed',{stage:'delivered'});notify()
  return{state:next,detail:`本阶段已确认并保留版本；待办 ${next.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state)).length} 项未自动开工。`}
  }
  })
  return finalize()
}
export function currentMilestoneAction(projectId:string,sessionId:string,option:string){
  const decision=longtermPendingDecision(projectId,sessionId),state=readLongtermState(projectId)
  if(!decision||!state||!decision.questions.some(item=>item.id===option))throw Error('LONGTERM_PENDING_STALE')
  return{state,action:option.startsWith('longterm_confirm:')?'confirm' as const:'later' as const}
}

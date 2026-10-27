import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject, updateProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { isSoftwareProject } from '../desktop/workflow-policy'
import type { LeanScopeSuggestion, LongtermProjectState } from '../../shared/types'
import type { SoftwareRelease } from './release-store'
import { redactSoftwareOutput } from './process-manager'

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function path(projectId:string){if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('LONGTERM_PROJECT_INVALID');return join(getPromaHome(),'software-longterm',projectId+'.json')}
export function isLongtermSoftware(projectId:string){return findProject(projectId).mode==='longterm'&&isSoftwareProject(projectId)}
export function readLongtermState(projectId:string):LongtermProjectState|undefined{
  const file=path(projectId);if(!existsSync(file))return
  const value=JSON.parse(readFileSync(file,'utf8')) as LongtermProjectState&{checksum:string}
  const{checksum,...state}=value
  if(state.version!==1||state.project_id!==projectId||!Number.isSafeInteger(state.revision)||state.revision<1||hash(state)!==checksum
    ||!Array.isArray(state.milestones)||state.milestones.length>100||!Array.isArray(state.backlog)||state.backlog.length>100||!Array.isArray(state.decisions)||state.decisions.length>200
    ||new Set(state.milestones.map(item=>item.id)).size!==state.milestones.length||new Set(state.backlog.map(item=>item.id)).size!==state.backlog.length
    ||state.milestones.some(item=>!['building','awaiting_confirmation','confirming','delivered','superseded'].includes(item.status)||!item.id||!item.session_id||!/^[a-f0-9]{64}$/.test(item.scope_hash)))throw Error('LONGTERM_STATE_INVALID')
  return state
}
export function saveLongtermState(state:LongtermProjectState){
  if(state.milestones.length>100||state.backlog.length>100||state.decisions.length>200)throw Error('LONGTERM_HISTORY_LIMIT: 历史已保留，请先归档整理')
  const before=readLongtermState(state.project_id)
  if(before&&before.revision!==state.revision)throw Error('LONGTERM_STATE_STALE')
  const next={...state,revision:state.revision+1}
  writeTextFileAtomic(path(state.project_id),JSON.stringify({...next,checksum:hash(next)}))
  const current=next.milestones.find(item=>item.id===next.current_id),pending=next.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state)).length
  updateProject(next.project_id,{longterm_summary:{status:next.archived_at?'archived':!current?'planning':['awaiting_confirmation','confirming'].includes(current.status)?'awaiting_confirmation':current.status==='delivered'?(pending?'backlog_pending':'milestone_delivered'):'building',pending_items:pending,milestone:current?.title}})
  return next
}
export function ensureLongtermState(projectId:string,sessionId:string){
  if(!isLongtermSoftware(projectId))throw Error('LONGTERM_SOFTWARE_REQUIRED')
  const brief=readPrdBackplane(projectId)
  if(!brief.user_confirmed_at)throw Error('LONGTERM_CONFIRMED_SCOPE_REQUIRED')
  const state=readLongtermState(projectId)??{version:1 as const,project_id:projectId,revision:0,milestones:[],backlog:[],decisions:[]}
  const scope=prdScopeFingerprint(brief),current=state.milestones.find(item=>item.id===state.current_id)
  if(current?.scope_hash===scope&&current.status!=='delivered'&&current.status!=='superseded'){
    if(current.session_id!==sessionId)throw Error('LONGTERM_SESSION_MISMATCH: 先回到当前里程碑所属会话')
    return state
  }
  if(current&&['building','awaiting_confirmation','confirming'].includes(current.status))current.status='superseded'
  const id=randomUUID();state.current_id=id;state.archived_at=undefined
  state.milestones.push({id,title:brief.positioning,scope_hash:scope,session_id:sessionId,operation_id:findProject(projectId).lean_operation_id??'initial',status:'building',
    features:brief.requirements.map(item=>({id:item.id,description:item.description,expected:brief.acceptance[item.id]??''})),created_at:new Date().toISOString()})
  return saveLongtermState(state)
}
export function stageLongtermMilestone(projectId:string,sessionId:string,requestId:string,candidate:SoftwareRelease){
  const state=ensureLongtermState(projectId,sessionId),current=state.milestones.find(item=>item.id===state.current_id)!
  if(!candidate.verified||candidate.verified.scope!==current.scope_hash||candidate.projectId!==projectId)throw Error('LONGTERM_VERIFIED_CANDIDATE_REQUIRED')
  current.status='awaiting_confirmation';current.candidate_id=candidate.id;current.source_digest=candidate.source.digest;current.request_id=requestId;current.verified_at=new Date().toISOString()
  current.versions??=[]
  if(!current.versions.some(item=>item.candidate_id===candidate.id))current.versions.push({candidate_id:candidate.id,source_digest:candidate.source.digest,at:current.verified_at})
  if(current.versions.length>100)throw Error('LONGTERM_VERSION_HISTORY_LIMIT')
  const next=saveLongtermState(state)
  updateProject(projectId,{status:'active',current_stage:'blocked_for_user_decision',desktop_phase:'desktop-verify',desktop_blocked:undefined})
  return next
}
export function longtermPendingDecision(projectId:string,sessionId:string){
  if(!isLongtermSoftware(projectId))return
  if(['archived','abandoned'].includes(findProject(projectId).status))return
  const state=readLongtermState(projectId),current=state?.milestones.find(item=>item.id===state.current_id)
  if(!state||!current||!['awaiting_confirmation','confirming'].includes(current.status)||current.session_id!==sessionId)return
  const seal=hash([current.id,current.scope_hash,current.candidate_id,current.source_digest])
  return{kind:'longterm_milestone',title:'当前里程碑已通过宿主检查',summary:`${current.title}\n版本 ${current.candidate_id?.slice(0,12)}；请核对本阶段。待办未自动进入实现。`,
    questions:[{id:`longterm_confirm:${seal}`,label:'确认本阶段，保留版本',description:'确认当前版本和范围，后续待办另选'},
      {id:`longterm_later:${seal}`,label:'稍后核对',description:'成果和试用保留，不发模型请求'}]}
}
export function noteLongtermSuggestion(projectId:string,sessionId:string,item:LeanScopeSuggestion,state:'deferred'|'rejected'|'adopt_requested'|'staged'){
  if(!isLongtermSoftware(projectId))return
  let value=readLongtermState(projectId)
  if(!value)value={version:1,project_id:projectId,revision:0,milestones:[],backlog:[],decisions:[]}
  const prior=value.backlog.find(row=>row.id===item.id)
  if(prior)prior.state=state
  else value.backlog.push({...item,state,origin_scope:prdScopeFingerprint(readPrdBackplane(projectId)),at:new Date().toISOString()})
  return saveLongtermState(value)
}
export function recordLongtermDecision(projectId:string,sessionId:string,decision:string,reason:string){
  if(!decision.trim()||!reason.trim()||decision.length>1200||reason.length>1600)throw Error('LONGTERM_DECISION_INVALID')
  const state=ensureLongtermState(projectId,sessionId)
  state.decisions.push({id:randomUUID(),decision:redactSoftwareOutput(decision.trim()),reason:redactSoftwareOutput(reason),author:'agent',at:new Date().toISOString(),scope:prdScopeFingerprint(readPrdBackplane(projectId))})
  return saveLongtermState(state)
}

import {createHash} from 'node:crypto'
import {existsSync,readFileSync,statSync} from 'node:fs'
import {join} from 'node:path'
import {getPromaHome} from '../../storage/config-paths'
import {findProject} from '../project/project-service'
import {softwareVerificationFingerprint} from '../desktop/verification-fingerprint'
import {readSoftwareRunState} from './run-state'
import {softwareStatusView} from './state-view'
import {activeSoftwareCommands,redactSoftwareOutput} from './process-manager'
import {activeDebugSessionId,readDebugSession} from './debug-sessions'

/** One bounded navigation view. Historical receipts are never fresh PASS. */
export function softwareDiagnosticContext(projectId:string,sessionId:string){
 const project=findProject(projectId),source=softwareVerificationFingerprint(project.root_path)
 let run:ReturnType<typeof readSoftwareRunState>,runError:string|undefined
 try{const state=readSoftwareRunState(projectId);if(state?.operationId===project.lean_operation_id)run=state}catch{runError='执行索引不可读'}
 let verification:unknown={available:false},debug:unknown={available:false}
 const file=join(getPromaHome(),'software-verification',projectId+'.json')
 if(existsSync(file))try{
  if(statSync(file).size>2*1024*1024)throw Error('large')
  const receipt=JSON.parse(readFileSync(file,'utf8'))
  if(receipt.version!==1||receipt.state!=='complete'||!receipt.result||receipt.result_hash!==createHash('sha256').update(JSON.stringify(receipt.result)).digest('hex'))throw Error('invalid')
  const result=receipt.result,failure=result.failure
  const bounded=(value:unknown)=>redactSoftwareOutput(typeof value==='string'?value:JSON.stringify(value)??'').slice(0,1600)
  verification={available:true,historical:true,revalidated:false,status:bounded(result.status).slice(0,32),at:typeof receipt.at==='number'?receipt.at:undefined,candidate:typeof result.candidate?.id==='string'?result.candidate.id.slice(0,64):undefined,
   failure:failure&&{category:bounded(failure.category).slice(0,80),classification_basis:bounded(failure.classification_basis).slice(0,80),code:bounded(failure.code).slice(0,120),expected:bounded(failure.expected),actual:bounded(failure.actual),next:bounded(failure.next)},
   cases:(result.core?.host_gui?.case_results??[]).filter((row:{status:string})=>row.status!=='passed').slice(0,8).map((row:{name?:string;status:string;error?:string})=>({name:row.name?.slice(0,200),status:bounded(row.status).slice(0,32),error:row.error&&bounded(row.error)}))}
 }catch{verification={available:false,error:'验收记录损坏、未完成或过大；不能推断通过'}}
 try{const id=activeDebugSessionId(projectId,sessionId);if(id){const state=readDebugSession(projectId,sessionId,id);debug={available:true,id,state:state.state,source:state.source,version:state.version,stale:state.source!==source||state.stale,screenshot:state.screenshot,
  observations:state.observations.slice(-6).map(row=>({kind:row.kind,message:redactSoftwareOutput(row.message).slice(0,600)})),next:'当前截图用view_image({debug_session_id})；源码变化先inspect_app重新观察'}}}catch{debug={available:false,error:'本会话调试记录不可用'}}
 const scrub=(value:unknown):unknown=>typeof value==='string'?redactSoftwareOutput(value):Array.isArray(value)?value.map(scrub):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,scrub(item)])):value
 return scrub({project_id:projectId,current_source:source,status:softwareStatusView(projectId,true),run_error:runError,current_error:run?.error?.slice(0,1600),historical_failure:run?.last_failure&&{error:run.last_failure.error.slice(0,800)},
  commands:activeSoftwareCommands(projectId,sessionId).map(row=>({process_id:row.process_id,state:row.state})),verification,debug,
  next:'已有命令用read_process接续；按已记录expected/actual定位。未知原因保留未知，截图附上不等于已审阅；历史记录不签发当前PASS。不重置预算或重复副作用。'})
}

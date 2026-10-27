/** Short production routing; retired phase dispatch has no executor here. */
import {findProject} from '../project/project-service'
import {GENERATION_MAX_TOKENS} from '../platform/llm/model-resolution'
import type {SDKQuery} from '../orchestration/stages/orchestration-contracts'
import {isLeanProject} from './workflow-policy'
import {workflowRetirementReason} from './workflow-retirement'
import type {DesktopRouteDeps,DesktopRouteInput} from './production-contracts'
export {defaultQuickSecurityGate,type DesktopRouteDeps,type DesktopRouteInput,type QuickSecurityGateResult} from './production-contracts'
export interface DesktopLineProjectLike{project_id?:string;workflow_version?:import('../../shared/workflow-version').ModernWorkflowVersion;template_type:string;desktop_phase?:string;current_stage?:string}
export const DESKTOP_LINE_TEMPLATE_TYPES:ReadonlySet<string>=new Set(['desktop_tool','game'])
const PHASE_IDS=new Set(['requirements','desktop-arch','desktop-scaffold','desktop-implement','desktop-verify','delivered'])
export function shouldEnterDesktopLine(project:DesktopLineProjectLike|undefined):boolean{
  return !!project&&project.workflow_version==='software-v1'&&(!project.project_id||isLeanProject(project.project_id))&&DESKTOP_LINE_TEMPLATE_TYPES.has(project.template_type)
}
export function isDesktopLineActive(project:DesktopLineProjectLike|undefined):boolean{
  return shouldEnterDesktopLine(project)&&(PHASE_IDS.has(project?.desktop_phase??'')||['generating_mvp','testing','completed','ready'].includes(project?.current_stage??''))
}
interface DesktopStageInput{projectId:string;sessionId:string;requestId:string;content:string;maxTokens?:number;signal?:AbortSignal;images?:import('../../shared/types').PastedImageRef[];initialMessagePersisted?:boolean}
export async function enterDesktopLine(input:DesktopStageInput,query:SDKQuery,env:Record<string,string>,deps:DesktopRouteDeps):Promise<boolean>{
  const project=findProject(input.projectId),retirement=workflowRetirementReason(project)
  if(retirement){deps.publish(input,'message_delta',{text:retirement});deps.complete(input.sessionId,input.projectId,'incomplete');return true}
  if(!shouldEnterDesktopLine(project))return false
  if(input.signal?.aborted)return true
  const {runLeanProduction}=await import('./lean-production')
  await runLeanProduction({ ...input, query, env,maxTokens:input.maxTokens??GENERATION_MAX_TOKENS},deps)
  return true
}
export async function handleDesktopDispatchMessage(input:DesktopRouteInput,deps:DesktopRouteDeps):Promise<void>{
  input.signal?.throwIfAborted()
  const retirement=workflowRetirementReason(findProject(input.projectId))
  if(retirement){deps.publish(input,'message_delta',{text:retirement});deps.complete(input.sessionId,input.projectId,'incomplete');return}
  const {runLeanProduction}=await import('./lean-production')
  await runLeanProduction(input,deps)
}

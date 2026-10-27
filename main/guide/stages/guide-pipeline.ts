import {randomUUID} from 'node:crypto'
import type {AgentEvent,AgentSendMessageInput} from '../../../shared/types'
import type {GuideModelOptions} from '../../orchestration/stages/orchestration-contracts'
import {findProject} from '../../project/project-service'
import {workflowRetirementReason} from '../../desktop/workflow-retirement'
import {handleLeanGuide} from '../lean-guide'
export async function handleGuideMessage(input:AgentSendMessageInput,publish:(event:AgentEvent)=>void,model?:GuideModelOptions,persistAssistant?:(text:string)=>void,_persistSystem?:(text:string)=>void):Promise<void>{
  const retirement=workflowRetirementReason(findProject(input.project_id))
  if(retirement){persistAssistant?.(retirement);publish({event_id:randomUUID(),project_id:input.project_id,session_id:input.session_id,type:'message_delta',payload:{text:retirement},created_at:new Date().toISOString()});return}
  return handleLeanGuide(input, publish, model)
}

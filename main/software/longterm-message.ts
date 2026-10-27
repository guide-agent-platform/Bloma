import type { DesktopRouteInput, DesktopRouteDeps } from '../desktop/desktop-route'
import { findProject, updateProject } from '../project/project-service'
import { isLongtermSoftware, readLongtermState, saveLongtermState, longtermPendingDecision } from './longterm-state'
import { currentMilestoneAction, performLongtermAction } from './longterm-control'

/** This runs before model admission. Cards and read-only resume never spend a
 * request or turn an unconfirmed milestone into a completed product. */
export async function handleLongtermMessage(input:DesktopRouteInput,deps:DesktopRouteDeps):Promise<boolean>{
  if(!isLongtermSoftware(input.projectId))return false
  const emit:Parameters<typeof performLongtermAction>[2]['emit']=(type,data)=>deps.publish(input,type,data)
  try{
    const state=readLongtermState(input.projectId),current=state?.milestones.find(item=>item.id===state.current_id)
    if(!current||!['awaiting_confirmation','confirming'].includes(current.status)){
      if(input.cardOptionId?.startsWith('longterm_'))throw Error('LONGTERM_PENDING_STALE')
      if(!input.cardOptionId&&/^(?:确认本阶段|确认里程碑|本阶段通过)[。！!\s]*$/.test(input.content.trim())){
        emit('message_delta',{text:current?.status==='delivered'?'本阶段已经确认，已有版本保留。':'当前没有待核对的里程碑；请先明确本轮目标。'});deps.complete(input.sessionId,input.projectId);return true
      }
      if(state&&!input.cardOptionId&&/^(?:查看待办|待办|查看决策|查看版本)[。！!\s]*$/.test(input.content.trim())){
        emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary});emit('message_delta',{text:`长期记录已保留：待办 ${state.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state)).length} 项、决策 ${state.decisions.length} 条、里程碑 ${state.milestones.length} 个。可在长期维护面板查看。`});deps.complete(input.sessionId,input.projectId);return true
      }
      if(state&&!input.cardOptionId&&/^(?:继续|恢复|查看待办|待办|查看决策|查看版本|下一步)[。！!\s]*$/.test(input.content.trim())&&current?.status==='delivered'){
        emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary});emit('message_delta',{text:`本阶段已交付，待办 ${state.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state)).length} 项保留。请在长期维护面板选择下一轮，或直接提出明确修改。`});deps.complete(input.sessionId,input.projectId);return true
      }
      return false
    }
    if(current.session_id!==input.sessionId)throw Error('LONGTERM_PENDING_OWNER_MISMATCH: 请回到本里程碑所属会话')
    const pending=longtermPendingDecision(input.projectId,input.sessionId)!
    const text=input.content.trim()
    let choice=input.cardOptionId
    if(!choice&&/^(?:确认本阶段|确认里程碑|本阶段通过)[。！!\s]*$/.test(text))choice=pending.questions[0].id
    if(choice){
      const action=currentMilestoneAction(input.projectId,input.sessionId,choice)
      const result=await performLongtermAction({request_id:input.requestId,project_id:input.projectId,session_id:input.sessionId,revision:action.state.revision,action:action.action},input.signal??new AbortController().signal,{busy:false,emit})
      emit('message_delta',{text:result.detail});deps.complete(input.sessionId,input.projectId);return true
    }
    if(/^(?:继续|恢复|查看进度|查看结果|看看|好的|收到|谢谢|稍后再说|先停|停止|暂停|取消)[。！!\s]*$/.test(text)){
      emit('user_decision_required',pending);emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary})
      emit('message_delta',{text:'当前里程碑的检查和版本已保留，请先核对本阶段；待办没有自动开工。'});deps.complete(input.sessionId,input.projectId,'incomplete');return true
    }
    // A genuine new user correction reopens engineering of this milestone;
    // the former candidate stays in immutable release/version history.
    current.status='building';saveLongtermState(state!)
    updateProject(input.projectId,{status:'active',current_stage:'generating_mvp',desktop_phase:'desktop-implement',desktop_blocked:undefined})
    emit('stage_changed',{stage:'desktop-implement'});emit('longterm_changed',{summary:findProject(input.projectId).longterm_summary})
    return false
  }catch(error){emit('message_delta',{text:`里程碑尚未确认：${String(error)}`});deps.complete(input.sessionId,input.projectId,'incomplete');return true}
}

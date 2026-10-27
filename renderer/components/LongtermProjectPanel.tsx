import React from 'react'
import { useAtomValue } from 'jotai'
import { activeAgentSessionIdAtom, hasActiveStreamAtom } from '../agent-atoms'
import type { LongtermProjectState, LongtermActionInput } from '../../shared/types'

export function LongtermProjectPanel({projectId,state,error,refresh,archived=false}:{projectId:string;state?:LongtermProjectState;error?:string;refresh:()=>void;archived?:boolean}){
  const sessionId=useAtomValue(activeAgentSessionIdAtom),busy=useAtomValue(hasActiveStreamAtom)
  const[pending,setPending]=React.useState(false),[message,setMessage]=React.useState('')
  const current=state?.milestones.find(item=>item.id===state.current_id),backlog=state?.backlog.filter(item=>['deferred','adopt_requested'].includes(item.state))??[]
  const awaiting=!!current&&['awaiting_confirmation','confirming'].includes(current.status)
  const ownershipMismatch=awaiting&&current.session_id!==sessionId
  const readOnly=archived||!!state?.archived_at
  React.useEffect(()=>setMessage(''),[projectId,state?.current_id])
  const choose=async(action:LongtermActionInput['action'],backlogId?:string)=>{
    const api=window.electronAPI?.projectDeliverables;if(!api||!state||pending||!sessionId||readOnly)return
    setPending(true)
    try{const result=await api.longtermAction({request_id:crypto.randomUUID(),project_id:projectId,session_id:sessionId,revision:state.revision,action,...(backlogId?{backlog_id:backlogId}:{})})
      setMessage(result.ok?result.data.detail:result.error.user_visible_message||result.error.message);refresh()
    }catch{setMessage('操作尚未确认，状态和已有版本保留，请刷新后重试。')}finally{setPending(false)}
  }
  return <section className="longterm-project-panel" aria-label="长期项目与里程碑">
    <header><strong>长期维护</strong><span>{archived||state?.archived_at?'已归档':awaiting?'本阶段待核对':current?.status==='delivered'?'本阶段已交付':current?'当前里程碑制作中':'下一轮目标待确认'}</span></header>
    {error?<p role="alert">长期状态暂不可读：{error}</p>:<>
      <p>{current?.title??'确认目标后建立里程碑。已有版本保留，待办不会自动开工。'}</p>
      {current?.candidate_id&&<p>本阶段版本 {current.candidate_id.slice(0,12)} · 请核对当前版本后确认</p>}
      {ownershipMismatch&&<p role="status">请回到本里程碑所属会话后核对；这里仅查看记录。</p>}
      {current?.status==='confirming'&&!pending&&<p role="status">上次核对尚未完成；已有版本和记录保留，请重新核对后确认。</p>}
      {awaiting&&<div className="software-trial-controls">
        <button type="button" data-ai-id="longterm-confirm" disabled={pending||busy||readOnly||!sessionId||ownershipMismatch} onClick={()=>void choose('confirm')}>确认本阶段，保留版本</button>
        <button type="button" disabled={pending||readOnly||!sessionId||ownershipMismatch} onClick={()=>void choose('later')}>稍后核对</button>
      </div>}
      {pending&&<div role="status">正在核对，请稍候… <button type="button" onClick={()=>{if(sessionId)void window.electronAPI?.agent.cancel({request_id:crypto.randomUUID(),project_id:projectId,session_id:sessionId,reason:'user_cancelled'})}}>取消核对</button></div>}
      <details open={backlog.length>0}><summary>待办 · {backlog.length}</summary>{backlog.length?backlog.map(item=><article key={item.id}><strong>{item.title}</strong><p>{item.description}</p><p>应看到：{item.expected}</p><button type="button" disabled={pending||busy||readOnly||!sessionId||awaiting} onClick={()=>void choose('adopt_backlog',item.id)}>{item.state==='adopt_requested'?'更新下一轮任务单并确认':'纳入下一轮并确认'}</button></article>):<p>暂无已保留待办。可在改进建议中选择“以后再说”。</p>}</details>
      <details><summary>决策与版本记录 · {state?.decisions.length??0} / {state?.milestones.length??0}</summary>
        {state?.decisions.slice(-12).map(item=><p key={item.id}><strong>{item.decision}</strong> · {item.reason}</p>)}
        {state?.milestones.slice(-10).map(item=><p key={item.id}>{item.title} · {item.status==='delivered'?'阶段已确认':item.status==='superseded'?'已由新范围接续':item.status==='awaiting_confirmation'?'待核对':'制作中'}{item.candidate_id?` · ${item.candidate_id.slice(0,12)}`:''}</p>)}
      </details>
      {current?.status==='delivered'&&!state?.archived_at&&!archived&&<button type="button" disabled={pending||busy||!sessionId} onClick={()=>void choose('archive')}>归档长期项目（保留全部记录）</button>}
    </>}{message&&<p role="status">{message}</p>}
  </section>
}

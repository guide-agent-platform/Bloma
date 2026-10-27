import React from 'react'
import { useAtomValue } from 'jotai'
import { activeAgentSessionIdAtom, hasActiveStreamAtom } from '../agent-atoms'
import type { SoftwareSuggestions as Suggestions } from '../../shared/types'

export function SoftwareSuggestions({value,refresh}:{value?:Suggestions;refresh:()=>void}) {
  const sessionId=useAtomValue(activeAgentSessionIdAtom), busy=useAtomValue(hasActiveStreamAtom)
  const [pending,setPending]=React.useState(false),[message,setMessage]=React.useState('')
  if(!value||value.session_id!==sessionId||value.items.every(item=>['rejected','staged'].includes(item.state)))return null
  const choose=async(id:string,action:'adopt'|'defer'|'reject')=>{
    const api=window.electronAPI?.projectDeliverables
    if(!api||pending)return
    setPending(true)
    try{const result=await api.decideSuggestion({request_id:crypto.randomUUID(),project_id:value.project_id,session_id:sessionId,set_id:value.id,suggestion_id:id,action})
      setMessage(result.ok?result.data.detail:result.error.user_visible_message||result.error.message);refresh()
    }catch{setMessage('选择尚未保存，请重试。')}finally{setPending(false)}
  }
  return <section className="software-improvement-suggestions" aria-label="供参考的改进建议"><h3>供参考的改进建议</h3><p>可忽略，不影响当前制作。选择本轮采用后，还会请你确认更新后的范围。</p>
    {value.items.filter(item=>!['rejected','staged'].includes(item.state)).map(item=><article key={item.id}><strong>{item.title}</strong><p>{item.benefit}</p><p>{item.description} · {item.expected}</p>
      {item.state==='deferred'&&<span>已留待以后</span>}
      <div className="software-trial-controls"><button disabled={pending||busy&&item.state==='adopt_requested'} onClick={()=>void choose(item.id,'adopt')}>{item.state==='adopt_requested'?'更新任务单并确认':'本轮采用'}</button><button disabled={pending} onClick={()=>void choose(item.id,'defer')}>以后再说</button><button disabled={pending} onClick={()=>void choose(item.id,'reject')}>不采用</button></div>
    </article>)}{message&&<p role="status">{message}</p>}</section>
}

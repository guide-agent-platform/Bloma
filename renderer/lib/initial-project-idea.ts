import type { createStore } from 'jotai'
import type { Project } from '../../shared/types'
import type { ComposerDraft, SendReceipt } from '../../shared/attachment-types'
import { composerDraftFamily, composerLoadedFamily } from '../composer-state'

/** First send uses the same durable draft, client identity and receipt contract as the composer. */
export async function submitInitialProjectIdea(project: Project, sessionId: string, text: string, store: ReturnType<typeof createStore>, onReceipt: (receipt: SendReceipt) => void): Promise<void> {
  const key=`${project.project_id}|${sessionId}`
  const atom=composerDraftFamily(key)
  const messageId=crypto.randomUUID()
  const draft: ComposerDraft={project_id:project.project_id,session_id:sessionId,draft_id:`draft-${sessionId}`,text,attachment_refs:[],revision:1,pending_send:{client_message_id:messageId,text,attachment_refs:[],revision:1,composer_revision:1}}
  store.set(atom,draft)
  store.set(composerLoadedFamily(key),true)
  const api=window.electronAPI?.composer
  if (!api) throw new Error('消息接收接口不可用，想法已保留在输入框。')
  const saved=await api.save({request_id:crypto.randomUUID(),draft})
  if (!saved.ok) throw new Error(saved.error.user_visible_message ?? saved.error.message)
  const result=await api.submit({request_id:crypto.randomUUID(),project_id:project.project_id,session_id:sessionId,draft_id:draft.draft_id,client_message_id:messageId,content:text,attachment_refs:[],mode:project.mode,current_stage:project.current_stage,metadata:{source:'chat'}})
  if (!result.ok) throw new Error(result.error.user_visible_message ?? result.error.message)
  if (result.data.status==='needs_recovery') throw new Error('这条想法需要恢复确认，原消息已保留。')
  onReceipt(result.data)
  const current=store.get(atom)
  if (current.pending_send?.client_message_id!==messageId) return
  const next={...current,text:current.revision===draft.revision?'':current.text,pending_send:undefined,revision:current.revision+1}
  store.set(atom,next)
  const cleaned=await api.save({request_id:crypto.randomUUID(),draft:next})
  if (!cleaned.ok) throw new Error('消息已接收，草稿清理保存失败；重启后可确认接收状态。')
}

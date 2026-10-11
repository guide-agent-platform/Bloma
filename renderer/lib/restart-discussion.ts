import type { AgentMessage, ElectronAPI } from '../../shared/types'
import { isInternalMessage } from '../../shared/message-presentation'

export async function restartDiscussion(api: ElectronAPI['agent'] | undefined, projectId: string | undefined, sessionId: string, message: AgentMessage) {
  if (!api?.forkSession || !projectId) throw new Error('新开讨论通道不可用，请重新打开项目')
  if (message.role !== 'user' || isInternalMessage(message)) throw new Error('只能从你输入的要求新开讨论')
  const result = await api.forkSession({ request_id: crypto.randomUUID(), session_id: sessionId, project_id: projectId,
    ...(message.id ? { entry_id: message.id } : {}), entry_timestamp: message.timestamp })
  if (!result.ok) throw new Error(result.error.user_visible_message ?? result.error.message ?? '新开讨论失败，请重试')
  return { sessionId: result.data.new_session_id, text: message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n') }
}

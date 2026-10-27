import type { ChatSubmitInput, MessageRecoveryInput, SendReceipt } from '../../../shared/attachment-types'
import { assertScope, resolveAttachments } from '../../platform/attachments/composer-store'
import { acceptMessage, existingReceipt, updateReceipt, recoveryRecord, reserveRecovery, cancelReceipt } from '../../platform/attachments/send-inbox'
import { findProject } from '../../project/project-service'
import { recordSessionActivity, listSessions } from '../../platform/sessions/session-service'
import { resolveChannelEnv } from '../../platform/llm/runtime-fallback'
import { categoryForStage } from '../../platform/llm/model-resolution'
import { enqueueSteer, registerSteer, steerConfirmEnabled } from '../../agent/loop/steer-queue'
import { runAgent } from './agent-dispatch'
import { hasRunForProject, sessionMessageQueue } from './run-registry'
import { trialFeedbackText } from '../../software/trial'

/** Durable acceptance precedes dispatch. No model promise is part of the IPC receipt. */
export function submitChat(input: ChatSubmitInput): SendReceipt {
  assertScope(input)
  if (typeof input.content !== 'string' || input.content.length > 200_000 || !/^[A-Za-z0-9_-]{1,128}$/.test(input.client_message_id)) throw new Error('MESSAGE_INVALID')
  const project = findProject(input.project_id)
  const owner = listSessions({ request_id: input.request_id }).sessions.find(session => session.session_id === input.session_id)
  if (owner && owner.project_id !== input.project_id) throw new Error('MESSAGE_SCOPE: 会话属于其他项目')
  const previous = existingReceipt(input)
  if (previous) return previous
  const attachments = resolveAttachments(input, input.attachment_refs)
  if (!input.content.trim() && attachments.length === 0) throw new Error('MESSAGE_EMPTY')
  const resolution = resolveChannelEnv({ channelId: input.channel_id, category: categoryForStage(project.current_stage), projectId: input.project_id, sessionId: input.session_id })
  if (!resolution.env) throw new Error('NO_USABLE_CHANNEL: 请先在设置中连接可用渠道，草稿已保留')
  recordSessionActivity(input.session_id, input.project_id)
  const queued = hasRunForProject(input.project_id)
  const imageRefs = attachments.flatMap(item => item.image ? [item.image] : [])
  const receipt = acceptMessage(input, queued, imageRefs, attachments.map(item => item.info))
  const dispatchInput = { ...input, request_id: input.client_message_id, images: imageRefs, run_generation: receipt.run_generation }
  if (queued && attachments.length === 0) {
    const steer = { queueMessageId: input.client_message_id, content: input.metadata?.observed_software_version ? trialFeedbackText(input.project_id, input.metadata.observed_software_version, input.content) : input.content, enqueuedAt: Date.now() }
    const steered = steerConfirmEnabled() ? registerSteer(input.session_id, steer, input.project_id) : enqueueSteer(input.session_id, steer)
    if (steered) {
      updateReceipt(input.client_message_id, 'steered')
      return { ...receipt, status: 'steered' }
    }
  }
  void runAgent(dispatchInput).catch(error => {
    try { updateReceipt(input.client_message_id, 'failed', error instanceof Error ? error.message : String(error), receipt.run_generation) }
    catch (storageError) { console.error('[chat-receipt] 执行失败状态保存失败', storageError) }
  })
  return receipt
}

export function resolveMessageReceipt(input: MessageRecoveryInput): SendReceipt {
  const record = recoveryRecord(input.client_message_id, input.project_id, input.session_id)
  const project = findProject(input.project_id)
  if (input.action === 'cancel') {
    const receipt = cancelReceipt(input.client_message_id, input.project_id, input.session_id)
    sessionMessageQueue.cancel(input.session_id, input.client_message_id)
    return receipt
  }
  if (input.action !== 'resume') throw new Error('RECOVERY_ACTION_INVALID')
  const attachments = resolveAttachments(record.input, record.input.attachment_refs)
  const resolution = resolveChannelEnv({ channelId: record.input.channel_id, category: categoryForStage(project.current_stage), projectId: input.project_id, sessionId: input.session_id })
  if (!resolution.env) throw new Error('NO_USABLE_CHANNEL: 请先连接可用渠道，材料与消息记录已保留')
  const reserved = reserveRecovery(input.client_message_id, input.project_id, input.session_id, input.operation_id, hasRunForProject(input.project_id))
  if (!reserved.dispatch) return reserved.record.receipt
  const generation = reserved.record.receipt.run_generation
  const dispatchInput = { ...record.input, request_id: record.input.client_message_id, current_stage: project.current_stage, run_generation: generation, images: attachments.flatMap(item => item.image ? [item.image] : []) }
  void runAgent(dispatchInput).catch(error => {
    try { updateReceipt(input.client_message_id, 'failed', error instanceof Error ? error.message : String(error), generation) }
    catch (storageError) { console.error('[chat-recovery] 状态保存失败', storageError) }
  })
  return reserved.record.receipt
}

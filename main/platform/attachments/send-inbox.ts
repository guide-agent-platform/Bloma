import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { composerPath, readStored, writeStored } from './composer-store'
import type { ChatSubmitInput, SendReceipt } from '../../../shared/attachment-types'
import { trackComposerEvent } from './composer-events'

const processEpoch = randomUUID()
const generations = new Map<string, number>()
export function isCurrentReceiptGeneration(id: string, generation: number): boolean {
  const path = composerPath('inbox', id)
  let current = generations.get(path)
  if (current === undefined) {
    current = readStored<InboxRecord>(path)?.receipt.run_generation ?? 1
    generations.set(path, current)
  }
  return current === generation
}
interface InboxRecord { input: ChatSubmitInput; fingerprint: string; receipt: SendReceipt; epoch: string; last_recovery_operation?: string; accepted_at?: number }
function fingerprint(input: ChatSubmitInput): string {
  const identity = { project_id: input.project_id, session_id: input.session_id, draft_id: input.draft_id, content: input.content, attachment_refs: input.attachment_refs,
    ...(input.metadata?.observed_software_version ? {observed_software_version:input.metadata.observed_software_version} : {}) }
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
export function existingReceipt(input: ChatSubmitInput): SendReceipt | undefined {
  const record = readStored<InboxRecord>(composerPath('inbox', input.client_message_id))
  if (!record) return undefined
  if (record.fingerprint !== fingerprint(input)) throw new Error('MESSAGE_ID_CONFLICT: 重试内容与原消息不一致')
  return receiptFor(record)
}
function receiptFor(record: InboxRecord): SendReceipt {
  const receipt = record.receipt
  if (record.epoch !== processEpoch && ['accepted', 'queued', 'running', 'steered'].includes(receipt.status)) return { ...receipt, status: 'needs_recovery', recovery_may_repeat: receipt.status === 'running' || receipt.status === 'steered' }
  return receipt
}
export function acceptMessage(input: ChatSubmitInput, queued: boolean, images?: SendReceipt['images'], attachments?: SendReceipt['attachments']): SendReceipt {
  const existing = existingReceipt(input)
  if (existing) return existing
  const receipt: SendReceipt = { client_message_id: input.client_message_id, request_id: input.request_id, session_id: input.session_id, status: queued ? 'queued' : 'accepted', images, attachments, run_generation: 1, recovery_may_repeat: false }
  writeStored(composerPath('inbox', input.client_message_id), { input, receipt, fingerprint: fingerprint(input), epoch: processEpoch, accepted_at: Date.now() })
  generations.set(composerPath('inbox', input.client_message_id), 1)
  trackComposerEvent('message_accepted', input.project_id, input.session_id, { client_message_id: input.client_message_id, request_id: input.request_id, status: receipt.status, attachment_ids: input.attachment_refs.map(ref => ref.attachment_id) })
  return receipt
}
export function updateReceipt(id: string | undefined, status: SendReceipt['status'], error?: string, runGeneration?: number): void {
  if (!id) return
  const path = composerPath('inbox', id)
  const record = readStored<InboxRecord>(path)
  if (!record) return
  if (runGeneration !== undefined && (record.receipt.run_generation ?? 1) !== runGeneration) return
  record.receipt = { ...record.receipt, status, ...(status === 'running' ? { recovery_may_repeat: true } : {}), ...(error ? { error } : {}) }
  writeStored(path, record)
}
export function recoveryRecord(id: string, projectId: string, sessionId: string): InboxRecord {
  const record = readStored<InboxRecord>(composerPath('inbox', id))
  if (!record || record.input.project_id !== projectId || record.input.session_id !== sessionId) throw new Error('MESSAGE_SCOPE: 找不到本会话的接收记录')
  return { ...record, receipt: receiptFor(record) }
}
/** Adapted from Proma bf3e98c reserveRunGeneration: lifecycle owns identity, queue only dispatches. */
export function reserveRecovery(id: string, projectId: string, sessionId: string, operationId: string, queued: boolean): { record: InboxRecord; dispatch: boolean } {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(operationId)) throw new Error('RECOVERY_OPERATION_INVALID')
  const record = recoveryRecord(id, projectId, sessionId)
  if (record.last_recovery_operation === operationId || ['accepted', 'queued', 'running', 'completed', 'steered'].includes(record.receipt.status)) return { record, dispatch: false }
  const oldStatus = record.receipt.status
  record.receipt = { ...record.receipt, status: queued ? 'queued' : 'accepted', run_generation: (record.receipt.run_generation ?? 1) + 1, error: undefined, recovery_may_repeat: record.receipt.recovery_may_repeat ?? (oldStatus === 'failed' || oldStatus === 'cancelled') }
  record.epoch = processEpoch
  record.last_recovery_operation = operationId
  writeStored(composerPath('inbox', id), record)
  generations.set(composerPath('inbox', id), record.receipt.run_generation ?? 1)
  trackComposerEvent('message_resumed', projectId, sessionId, { client_message_id: id, run_generation: record.receipt.run_generation, previous_status: oldStatus })
  return { record, dispatch: true }
}
export function cancelReceipt(id: string, projectId: string, sessionId: string): SendReceipt {
  const record = recoveryRecord(id, projectId, sessionId)
  if (['running', 'completed', 'steered'].includes(record.receipt.status)) throw new Error('MESSAGE_NOT_WITHDRAWABLE: 已执行的消息不能撤回；运行中请使用停止按钮')
  updateReceipt(id, 'cancelled')
  trackComposerEvent('message_cancelled', projectId, sessionId, { client_message_id: id })
  return { ...record.receipt, status: 'cancelled' }
}
export function readReceipt(id: string, sessionId: string): SendReceipt | undefined {
  const record = readStored<InboxRecord>(composerPath('inbox', id))
  if (record && record.input.session_id !== sessionId) throw new Error('MESSAGE_SCOPE')
  return record ? receiptFor(record) : undefined
}
export function listReceipts(sessionId: string): Array<{ receipt: SendReceipt; input: ChatSubmitInput }> {
  const root = dirname(composerPath('inbox', 'index'))
  if (!existsSync(root)) return []
  return readdirSync(root).filter(name => name.endsWith('.json')).flatMap(name => {
    const record = readStored<InboxRecord>(join(root, name))
    return record && record.input.session_id === sessionId ? [{ receipt: receiptFor(record), input: record.input, accepted_at: record.accepted_at ?? 0 }] : []
  }).sort((a, b) => a.accepted_at - b.accepted_at).map(({ accepted_at: _at, ...row }) => row)
}
export function cancelPendingReceipts(projectId: string | undefined, sessionId: string): void {
  const root = dirname(composerPath('inbox', 'index'))
  if (!existsSync(root)) return
  for (const name of readdirSync(root).filter(name => name.endsWith('.json'))) {
    const record = readStored<InboxRecord>(join(root, name))
    if (record && (projectId ? record.input.project_id === projectId : record.input.session_id === sessionId)
      && ['accepted', 'queued', 'running'].includes(record.receipt.status)) updateReceipt(record.receipt.client_message_id, 'cancelled')
  }
}

import type { IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import type { AttachmentImportInput, AttachmentPreviewInput, ChatSubmitInput, DraftLoadInput, DraftSaveInput } from '../../shared/attachment-types'
import { assertScope, importAttachment, loadDraft, resolveAttachments, saveDraft, readAttachmentPage } from '../platform/attachments/composer-store'
import { listReceipts, readReceipt } from '../platform/attachments/send-inbox'
import { submitChat, resolveMessageReceipt } from '../orchestration/stages/chat-submit'
import { reuseHistoryAttachment, sessionHistoryAttachments } from '../platform/attachments/attachment-history'
import { findProject } from '../project/project-service'
import { listSessions, recordSessionActivity } from '../platform/sessions/session-service'
import type { DraftScope } from '../../shared/attachment-types'
import { extractRequestId, requireFields, safeInvoke } from './shared'

export function registerComposerIpc(ipc: IpcMain): void {
  ipc.handle(IPC_CHANNELS.COMPOSER_LOAD, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () =>
    loadDraft(ownedScope(requireFields<DraftLoadInput>(payload, ['project_id', 'session_id', 'draft_id'])))))
  ipc.handle(IPC_CHANNELS.COMPOSER_SAVE, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<DraftSaveInput>(payload, ['draft'])
    ownedScope(input.draft)
    return saveDraft(input.draft)
  }))
  ipc.handle(IPC_CHANNELS.ATTACHMENT_IMPORT, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () =>
    importAttachment(ownedScope(requireFields<AttachmentImportInput>(payload, ['project_id', 'session_id', 'draft_id', 'media_type', 'name'])))))
  ipc.handle(IPC_CHANNELS.ATTACHMENT_PREVIEW, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<AttachmentPreviewInput>(payload, ['project_id', 'session_id', 'draft_id', 'attachment_id'])
    ownedScope(input, false)
    const [item] = resolveAttachments(input, [input])
    const { imageId: _path, ...info } = item.info
    return { info, ...(item.dataUrl ? { dataUrl: item.dataUrl } : { page: readAttachmentPage(info, 1, 100) }) }
  }))
  ipc.handle(IPC_CHANNELS.ATTACHMENT_READ, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<import('../../shared/attachment-types').AttachmentReadInput>(payload, ['project_id', 'session_id', 'draft_id', 'attachment_id'])
    ownedScope(input, false)
    const [item] = resolveAttachments(input, [input])
    return readAttachmentPage(item.info, input.start_line, input.limit)
  }))
  ipc.handle(IPC_CHANNELS.CHAT_SUBMIT, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () =>
    submitChat(requireFields<ChatSubmitInput>(payload, ['client_message_id', 'draft_id', 'attachment_refs', 'session_id', 'project_id', 'mode', 'current_stage']))))
  ipc.handle(IPC_CHANNELS.CHAT_RECEIPT, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<{ request_id: string; client_message_id: string; session_id: string }>(payload, ['client_message_id', 'session_id'])
    return readReceipt(input.client_message_id, input.session_id)
  }))
  ipc.handle(IPC_CHANNELS.CHAT_RECEIPTS, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<{ request_id: string; session_id: string }>(payload, ['session_id'])
    return listReceipts(input.session_id)
  }))
  ipc.handle(IPC_CHANNELS.CHAT_RECOVER, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () =>
    resolveMessageReceipt(requireFields<import('../../shared/attachment-types').MessageRecoveryInput>(payload, ['project_id', 'session_id', 'client_message_id', 'operation_id', 'action']))))
  ipc.handle(IPC_CHANNELS.ATTACHMENT_HISTORY, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<{ request_id: string; project_id: string; session_id: string }>(payload, ['project_id', 'session_id'])
    ownedScope({ ...input, draft_id: `draft-${input.session_id}` }, false)
    return sessionHistoryAttachments(input.project_id, input.session_id)
  }))
  ipc.handle(IPC_CHANNELS.ATTACHMENT_REUSE, (_event, payload: unknown) => safeInvoke(extractRequestId(payload), async () => {
    const input = requireFields<import('../../shared/attachment-types').AttachmentReuseInput>(payload, ['project_id', 'session_id', 'draft_id', 'source_session_id', 'attachment_id'])
    ownedScope(input)
    ownedScope({ project_id: input.project_id, session_id: input.source_session_id, draft_id: `draft-${input.source_session_id}` }, false)
    return reuseHistoryAttachment(input)
  }))
}

function ownedScope<T extends DraftScope>(input: T, touch = true): T {
  assertScope(input)
  findProject(input.project_id)
  const owner = listSessions({ request_id: 'composer-scope' }).sessions.find(session => session.session_id === input.session_id)
  if (owner && owner.project_id !== input.project_id) throw new Error('COMPOSER_SCOPE')
  // Register draft-only sessions so restart can resolve the same draft before the first send.
  if (touch) recordSessionActivity(input.session_id, input.project_id)
  return input
}

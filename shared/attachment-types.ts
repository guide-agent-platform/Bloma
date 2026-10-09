import type { AgentSendMessageInput, PastedImageRef, RequestEnvelope } from './types'

export const ATTACHMENT_LIMITS = { files: 8, images: 4, imageBytes: 5 * 1024 * 1024, textBytes: 1024 * 1024, readChars: 12000, contextChars: 24000 } as const
export interface AttachmentRef { attachment_id: string }
export interface DraftScope { project_id: string; session_id: string; draft_id: string }
export interface AttachmentInfo extends AttachmentRef, DraftScope {
  name: string
  media_type: string
  bytes: number
  sha256: string
  status: 'ready'
  kind?: 'image' | 'text'
  line_count?: number
  encoding?: 'utf-8'
}
export interface ComposerDraft extends DraftScope {
  text: string
  attachment_refs: AttachmentRef[]
  revision: number
  pending_send?: { client_message_id: string; text: string; attachment_refs: AttachmentRef[]; revision: number; composer_revision?: number; preserve_current?: boolean }
}
export interface SendReceipt {
  run_generation?: number
  recovery_may_repeat?: boolean
  attachments?: AttachmentInfo[]
  images?: PastedImageRef[]
  client_message_id: string
  request_id: string
  session_id: string
  status: 'accepted' | 'queued' | 'running' | 'completed' | 'failed' | 'needs_recovery' | 'cancelled' | 'steered'
  error?: string
}
export interface ChatSubmitInput extends AgentSendMessageInput {
  client_message_id: string
  draft_id: string
  attachment_refs: AttachmentRef[]
}
export interface AttachmentImportInput extends RequestEnvelope, DraftScope { base64: string; media_type: string; name: string }
export interface DraftLoadInput extends RequestEnvelope, DraftScope {}
export interface DraftSaveInput extends RequestEnvelope { draft: ComposerDraft }
export interface AttachmentPreviewInput extends RequestEnvelope, DraftScope, AttachmentRef {}
export interface MaterialSourceRef extends AttachmentRef { sha256: string; start_line?: number; end_line?: number }
export interface MaterialContext { project_id: string; owner_session_id: string; attachments: AttachmentInfo[] }
export interface AttachmentPage extends MaterialSourceRef { text: string; total_lines: number; next_line?: number; truncated: boolean }
export interface AttachmentPreview { info: AttachmentInfo; dataUrl?: string; page?: AttachmentPage }
export interface AttachmentReadInput extends RequestEnvelope, DraftScope, AttachmentRef { start_line?: number; limit?: number }
export interface MessageRecoveryInput extends RequestEnvelope { project_id: string; session_id: string; client_message_id: string; operation_id: string; action: 'resume' | 'cancel' }
export interface AttachmentReuseInput extends RequestEnvelope, DraftScope { source_session_id: string; attachment_id: string; expected_revision: number }

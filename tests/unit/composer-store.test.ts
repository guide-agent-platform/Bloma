import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importImage, loadDraft, resolveAttachments, saveDraft, composerPath } from '../../main/platform/attachments/composer-store'
import { acceptMessage, existingReceipt, readReceipt, updateReceipt, cancelPendingReceipts, listReceipts } from '../../main/platform/attachments/send-inbox'
import type { ChatSubmitInput } from '../../shared/attachment-types'
import { resolvePastedImagePath } from '../../main/platform/shell/pasted-images'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const scope = { project_id: 'project-one', session_id: 'session-one', draft_id: 'draft-one' }
const image = () => importImage({ request_id: 'r', ...scope, base64: png, media_type: 'image/png', name: '参考.png' })
const input = (id = 'client-one'): ChatSubmitInput => ({ request_id: 'r', ...scope, client_message_id: id, attachment_refs: [], content: 'hello', mode: 'quick', current_stage: 'clarifying' })
beforeEach(() => vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-composer-'))))
afterEach(() => vi.unstubAllEnvs())

describe('composer snapshots and durable acceptance', () => {
  it('copies and hashes real image bytes; keeps draft JSON free of base64', () => {
    const info = image()
    const draft = { ...scope, text: '参考', attachment_refs: [{ attachment_id: info.attachment_id }], revision: 1 }
    saveDraft(draft)
    expect(loadDraft(scope)).toEqual(draft)
    expect(resolveAttachments(scope, draft.attachment_refs)[0].dataUrl).toBe(`data:image/png;base64,${png}`)
    expect(readFileSync(composerPath('drafts', scope.draft_id), 'utf8')).not.toContain(png)
  })
  it('rejects traversals, mismatched ownership, invalid bytes, duplicated refs and >4 images', () => {
    expect(() => image.call(null)).not.toThrow()
    const info = image()
    expect(() => loadDraft({ ...scope, draft_id: '../escape' })).toThrow()
    expect(() => resolveAttachments({ ...scope, session_id: 'other' }, [info])).toThrow('ATTACHMENT_SCOPE')
    expect(() => importImage({ request_id: 'r', ...scope, base64: 'aGVsbG8=', media_type: 'image/png', name: 'bad' })).toThrow('ATTACHMENT_DATA')
    expect(() => resolveAttachments(scope, [info, info])).toThrow('ATTACHMENT_DUPLICATE')
    expect(() => resolveAttachments(scope, Array.from({ length: 5 }, image))).toThrow('ATTACHMENT_LIMIT')
  })
  it('detects changed or missing image snapshots instead of dropping them silently', () => {
    const info = image()
    const [resolved] = resolveAttachments(scope, [info])
    writeFileSync(resolvePastedImagePath(resolved.image!.imageId), 'changed')
    expect(() => resolveAttachments(scope, [info])).toThrow('ATTACHMENT_CHANGED')
    expect(() => resolveAttachments(scope, [{ attachment_id: 'missing' }])).toThrow('ATTACHMENT_SCOPE')
  })
  it('isolates drafts and rejects stale asynchronous saves', () => {
    saveDraft({ ...scope, text: 'latest', attachment_refs: [], revision: 9 })
    saveDraft({ ...scope, text: 'stale', attachment_refs: [], revision: 2 })
    expect(loadDraft(scope).text).toBe('latest')
    expect(loadDraft({ ...scope, draft_id: 'second', session_id: 'second' }).text).toBe('')
  })
  it('durably deduplicates stable identity even with a new request id; conflicting content is rejected', () => {
    const first = acceptMessage(input(), false)
    expect(existingReceipt({ ...input(), request_id: 'retry', current_stage: 'blocked_for_user_decision' })).toEqual(first)
    expect(() => acceptMessage({ ...input(), content: 'different' }, false)).toThrow('MESSAGE_ID_CONFLICT')
    expect(listReceipts(scope.session_id)).toHaveLength(1)
    expect(() => readReceipt('client-one', 'other')).toThrow('MESSAGE_SCOPE')
  })
  it('marks interrupted records as needs_recovery after a process epoch change; never restarts them', async () => {
    acceptMessage(input(), true)
    vi.resetModules()
    const restarted = await import('../../main/platform/attachments/send-inbox')
    expect(restarted.readReceipt('client-one', scope.session_id)?.status).toBe('needs_recovery')
  })
  it('cancels pending records across a project and preserves completed history', () => {
    acceptMessage(input('queued'), true)
    acceptMessage(input('done'), false)
    updateReceipt('done', 'completed')
    cancelPendingReceipts(scope.project_id, 'other-session')
    expect(readReceipt('queued', scope.session_id)?.status).toBe('cancelled')
    expect(readReceipt('done', scope.session_id)?.status).toBe('completed')
  })
})

import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { importAttachment, composerPath, loadDraft, resolveAttachments, saveDraft } from '../../main/platform/attachments/composer-store'
import { reuseHistoryAttachment, sessionHistoryAttachments } from '../../main/platform/attachments/attachment-history'
import { collectUnusedAttachments } from '../../main/platform/attachments/attachment-cleanup'
import { appendSessionMessage, resetSessionTreeForTests } from '../../main/platform/sessions/session-tree'
import { forkFrom, loadMessages, loadConversationHistory, recordSessionActivity, setSessionActiveChecker } from '../../main/platform/sessions/session-service'
import { sessionMaterials } from '../../main/platform/attachments/material-context'
import { getAgentSessionPath } from '../../storage/config-paths'
import { cleanupPastedImages, savePastedImage } from '../../main/platform/shell/pasted-images'
import type { AttachmentInfo } from '../../shared/attachment-types'

const scope = { project_id: 'project', session_id: 'source', draft_id: 'draft-source' }
const create = (name = 'requirements.md', body = '导出保留 settlement_currency') => importAttachment({ request_id: 'r', ...scope, name, media_type: 'text/plain', base64: Buffer.from(body).toString('base64') })
function message(info: AttachmentInfo, timestamp = 1) { return { role: 'user' as const, timestamp, content: [{ type: 'text' as const, text: '按材料做需求' }], attachments: [info] } }
beforeEach(() => { vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-attachment-lifecycle-'))); resetSessionTreeForTests(); setSessionActiveChecker(() => false) })
afterEach(() => vi.unstubAllEnvs())
describe('material reuse, fork and conservative lifecycle', () => {
  it('snapshots legacy image references lazily during fork, so original session image cleanup cannot break them', () => {
    const image = savePastedImage('source', 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'png')
    appendSessionMessage('source', { role: 'user', timestamp: 1, content: [{ type: 'image', ...image }] })
    const fork = forkFrom('source', { project_id: 'project', entry_timestamp: 1 })
    cleanupPastedImages('source')
    const [info] = sessionMaterials('project', fork.new_session_id).attachments
    expect(resolveAttachments(info, [info])[0].dataUrl).toMatch(/^data:image\/png;base64,/)
  })
  it('recovery history excludes only the current stable identity and keeps distinct same-text instructions', () => {
    appendSessionMessage('source', { role: 'user', client_message_id: 'first', timestamp: 10, content: [{ type: 'text', text: 'same text' }] })
    appendSessionMessage('source', { role: 'user', client_message_id: 'second', timestamp: 20, content: [{ type: 'text', text: 'same text' }] })
    expect(loadConversationHistory('source')).toHaveLength(2)
    expect(loadConversationHistory('source', 10, { excludeClientMessageId: 'second' })).toEqual([{ role: 'user', content: 'same text' }])
  })
  it('reuses the same immutable id/hash in another session without copying bytes; source changes do not affect it', () => {
    const originalFile = join(process.env.PROMA_HOME!, 'original.md'); writeFileSync(originalFile, 'version-one')
    const info = create('original.md', readFileSync(originalFile, 'utf8'))
    appendSessionMessage('source', message(info))
    const target = { project_id: 'project', session_id: 'target', draft_id: 'draft-target' }
    const draft = reuseHistoryAttachment({ request_id: 'r', ...target, source_session_id: 'source', attachment_id: info.attachment_id, expected_revision: 0 })
    writeFileSync(originalFile, 'version-two'); rmSync(originalFile)
    expect(draft.attachment_refs).toEqual([{ attachment_id: info.attachment_id }])
    expect(resolveAttachments(target, draft.attachment_refs)[0]).toMatchObject({ text: 'version-one', info: { sha256: info.sha256, session_id: 'target' } })
    expect(loadDraft(scope).attachment_refs).toEqual([])
  })
  it('fork copies only material references before the anchor; deletion of source history cannot break the fork', () => {
    const first = create('one.md', 'one'), later = create('two.md', 'later')
    appendSessionMessage('source', message(first, 10)); appendSessionMessage('source', message(later, 20))
    const fork = forkFrom('source', { project_id: 'project', entry_timestamp: 10 })
    rmSync(getAgentSessionPath('source'))
    const materials = sessionMaterials('project', fork.new_session_id)
    expect(materials.attachments.map(info => info.attachment_id)).toEqual([first.attachment_id])
    expect(resolveAttachments(materials.attachments[0], [first])[0].text).toBe('one')
    const age = new Date(Date.now() - 48 * 60 * 60 * 1000)
    utimesSync(composerPath('attachments', first.attachment_id), age, age); utimesSync(composerPath('attachments', later.attachment_id), age, age)
    expect(collectUnusedAttachments(new Set(['project']))).toMatchObject({ removed: 1, kept: 1 })
    expect(existsSync(composerPath('attachments', first.attachment_id))).toBe(true)
  })
  it('same-name reimports form distinct versions; source ownership and draft revision are enforced', () => {
    const one = create('same.md', 'one'), two = create('same.md', 'two')
    appendSessionMessage('source', message(one, 10)); appendSessionMessage('source', message(two, 20))
    expect(sessionHistoryAttachments('project', 'source').map(info => info.sha256)).toEqual([one.sha256, two.sha256])
    expect(one.attachment_id).not.toBe(two.attachment_id)
    expect(() => reuseHistoryAttachment({ request_id: 'r', ...scope, source_session_id: 'other', attachment_id: one.attachment_id, expected_revision: 0 })).toThrow('ATTACHMENT_SCOPE')
    saveDraft({ ...scope, text: 'edited', attachment_refs: [], revision: 9 })
    expect(() => reuseHistoryAttachment({ request_id: 'r', ...scope, source_session_id: 'source', attachment_id: one.attachment_id, expected_revision: 8 })).toThrow('DRAFT_CHANGED')
    expect(() => sessionHistoryAttachments('other-project', 'source')).toThrow('ATTACHMENT_SCOPE')
  })
  it('does not collect recently imported, drafted or shared material; aborts on corrupt reference records', () => {
    const unused = create('unused.md'), drafted = create('drafted.md'), recent = create('recent.md')
    saveDraft({ ...scope, text: '', attachment_refs: [drafted], revision: 1 })
    const age = new Date(Date.now() - 48 * 60 * 60 * 1000)
    for (const info of [unused, drafted]) utimesSync(composerPath('attachments', info.attachment_id), age, age)
    writeFileSync(composerPath('drafts', scope.draft_id), '{bad json')
    expect(() => collectUnusedAttachments(new Set(['project']))).toThrow()
    expect(existsSync(composerPath('attachments', unused.attachment_id))).toBe(true)
    writeFileSync(composerPath('drafts', scope.draft_id), JSON.stringify({ ...scope, text: '', attachment_refs: [drafted], revision: 1 }))
    expect(collectUnusedAttachments(new Set(['project']))).toEqual({ removed: 1, kept: 2 })
    expect(existsSync(composerPath('attachments', recent.attachment_id))).toBe(true)
  })
  it('draft-only indexed sessions load as empty history, and existing fork targets are rejected', () => {
    recordSessionActivity('empty', 'project')
    expect(loadMessages({ request_id: 'r', session_id: 'empty' }).messages).toEqual([])
    const info = create(); appendSessionMessage('source', message(info))
    expect(() => forkFrom('source', { project_id: 'project', entry_timestamp: 1, new_session_id: 'empty' })).toThrow('SESSION_FORK_TARGET_EXISTS')
  })
})

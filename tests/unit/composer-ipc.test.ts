import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { registerComposerIpc } from '../../main/ipc/composer'
import { createProject, findProject } from '../../main/project/project-service'
import { recordSessionActivity, setProjectTouchHandler } from '../../main/platform/sessions/session-service'
import { IPC_CHANNELS } from '../../shared/types'
import { updateProject } from '../../main/project/project-service'
import { loadDraft } from '../../main/platform/attachments/composer-store'

beforeEach(() => {
  vi.stubEnv('PROMA_HOME', mkdtempSync(join(tmpdir(), 'bloma-composer-ipc-')))
  setProjectTouchHandler((id, patch) => { updateProject(id, patch) })
})
afterEach(() => { setProjectTouchHandler(null); vi.unstubAllEnvs() })
function handlers() {
  const map = new Map<string, (_event: unknown, input: unknown) => Promise<any>>()
  registerComposerIpc({ handle: (name: string, fn: any) => map.set(name, fn) } as never)
  return map
}
describe('composer IPC ownership and restore', () => {
  it('registers a draft-only session for restart and returns metadata without internal image path', async () => {
    const project = createProject({ request_id: 'r', mode: 'quick' })
    const scope = { request_id: 'r', project_id: project.project_id, session_id: 'draft-only', draft_id: 'draft-draft-only' }
    const map = handlers()
    const response = await map.get(IPC_CHANNELS.COMPOSER_LOAD)!(null, scope)
    expect(response.ok).toBe(true)
    expect(findProject(project.project_id).last_session_id).toBe('draft-only')
    const imported = await map.get(IPC_CHANNELS.ATTACHMENT_IMPORT)!(null, { ...scope, name: 'reference.png', media_type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' })
    expect(imported.ok).toBe(true)
    expect(imported.data.imageId).toBeUndefined()
    const preview = await map.get(IPC_CHANNELS.ATTACHMENT_PREVIEW)!(null, { ...scope, attachment_id: imported.data.attachment_id })
    expect(preview.ok).toBe(true)
    expect(preview.data.info.imageId).toBeUndefined()
    const pureImage = await map.get(IPC_CHANNELS.CHAT_SUBMIT)!(null, {
      ...scope, client_message_id: 'image-only', content: '', attachment_refs: [{ attachment_id: imported.data.attachment_id }], mode: 'quick', current_stage: 'clarifying',
    })
    expect(pureImage.error.message).toContain('NO_USABLE_CHANNEL')
    expect(pureImage.error.message).not.toContain('Missing required field: content')
  })
  it('rejects crossed sessions, path traversal and absent references without overwriting a saved draft', async () => {
    const first = createProject({ request_id: 'r', mode: 'quick' })
    const second = createProject({ request_id: 'r2', mode: 'quick' })
    recordSessionActivity('owner', first.project_id)
    const map = handlers()
    const scope = { project_id: first.project_id, session_id: 'owner', draft_id: 'draft-owner' }
    const draft = { ...scope, text: 'saved', attachment_refs: [], revision: 1 }
    expect((await map.get(IPC_CHANNELS.COMPOSER_SAVE)!(null, { request_id: 'r', draft })).ok).toBe(true)
    const crossed = await map.get(IPC_CHANNELS.COMPOSER_LOAD)!(null, { request_id: 'r', ...scope, project_id: second.project_id })
    expect(crossed.ok).toBe(false)
    const invalid = await map.get(IPC_CHANNELS.COMPOSER_LOAD)!(null, { request_id: 'r', ...scope, session_id: '../escape' })
    expect(invalid.ok).toBe(false)
    const missing = await map.get(IPC_CHANNELS.COMPOSER_SAVE)!(null, { request_id: 'r', draft: { ...draft, revision: 2, attachment_refs: [{ attachment_id: 'missing' }] } })
    expect(missing.ok).toBe(false)
    expect(loadDraft(scope).text).toBe('saved')
  })
})

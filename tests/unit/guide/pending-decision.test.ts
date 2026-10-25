import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { stageLeanScope } from '../../../main/guide/lean-scope'
import { readPendingDecision } from '../../../main/guide/pending-decision'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { guideConfirmationPath, saveGuideConfirmation } from '../../../main/guide/confirmation-journal'

let home: string, old: string | undefined
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-pending-ui-')); process.env.PROMA_HOME = home })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function setup() {
  const project = createProject({ request_id: 'c', mode: 'longterm' }, { workflowVersion: 'software-v1' }), previous = readPrdBackplane(project.project_id)
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '本地课程笔记', ui: 'required', delivery: 'browser', requirements: [{ description: '保存笔记', expected: '重开后保留' }] }),
    { projectId: project.project_id, sessionId: 's', source: '本地课程笔记', previous, software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  stageLeanScope(project.project_id, 's', 'r', previous, parsed.brief, () => {})
  return project
}
it('rehydrates the owner scope card without consuming its journal or requiring another model turn', () => {
  const project = setup(), file = guideConfirmationPath('prd', project.project_id), before = readFileSync(file, 'utf8')
  const pending = readPendingDecision(project.project_id, 's')!
  expect(pending.payload).toMatchObject({ kind: 'lean_scope', scope: { features: [{ description: '保存笔记', expected: '重开后保留' }] } })
  expect(readPendingDecision(project.project_id, 'foreign')).toBeUndefined()
  expect(readFileSync(file, 'utf8')).toBe(before)
})
it('restores only an actual current sketch and owner confirmation; changed bytes cannot restore a confirm button', () => {
  const project = setup(); markPrdUserConfirmed(project.project_id)
  const brief = readPrdBackplane(project.project_id), scope = prdScopeFingerprint(brief), html = '<!DOCTYPE html><html><body>实际草图</body></html>'
  mkdirSync(join(project.root_path, '00_UX'), { recursive: true }); writeFileSync(join(project.root_path, '00_UX/ux-sketch.html'), html)
  saveGuideConfirmation({ version: 1, kind: 'ux', id: randomUUID(), project_id: project.project_id, session_id: 's', scope_hash: scope, state: 'pending', data: {
    project_id: project.project_id, session_id: 's', prdFingerprint: scope, backplane: brief, sketchHtml: html,
    sketchHash: createHash('sha256').update(html).digest('hex'), generationFailed: false,
  } })
  const pending = readPendingDecision(project.project_id, 's')!
  expect(pending.preview_url).toContain('bloma-file:')
  expect(pending.payload).toMatchObject({ kind: 'ux_confirm', questions: expect.arrayContaining([expect.objectContaining({ id: 'ux_confirm_go' })]) })
  expect(readPendingDecision(project.project_id, 'foreign')).toBeUndefined()
  writeFileSync(join(project.root_path, '00_UX/ux-sketch.html'), html + 'changed')
  expect(() => readPendingDecision(project.project_id, 's')).toThrow('SKETCH_CHANGED')
})

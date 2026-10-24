import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { installGuiAcceptanceSuite, type GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { saveSoftwareRegressionBaseline, assertRetainedSoftwareBehavior } from '../../../main/software/regression-baseline'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-regression-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
function brief(expanded = false, changed = false) {
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '笔记', ui: 'required', delivery: 'desktop', requirements: [
    { id: 'F-001', description: '保存笔记', expected: changed ? '改为仅临时显示' : '保存并重开仍可读回' },
    ...(expanded ? [{ id: 'F-002', description: '搜索', expected: '输入词找到已有笔记' }] : [])] }),
  { projectId: project.project_id, sessionId: 's', source: '用户确认修改', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
}
it('keeps unchanged behavior/inputs across new features, permits selector repair and releases explicitly changed requirements', () => {
  brief()
  const old: GuiAcceptanceSuite = { version: 1, scope_hash: prdScopeFingerprint(readPrdBackplane(project.project_id)), covers: ['F-001'], acceptance_refs: { saved: ['F-001'], reopened: ['F-001'] },
    steps: [{ id: 'input', kind: 'fill', selector: '#input', value: 'original-note' }, { id: 'save', kind: 'click', selector: '#save' },
      { id: 'saved', kind: 'expect', selector: '#out', equals: 'original-note' }, { id: 'restart', kind: 'restart' }, { id: 'reopened', kind: 'expect', selector: '#out', equals: 'original-note' }] }
  installGuiAcceptanceSuite(project.project_id, old); saveSoftwareRegressionBaseline(project.project_id, 'host-verified-v1')
  brief(true)
  const weakened: GuiAcceptanceSuite = { ...old, covers: ['F-001', 'F-002'], steps: [{ id: 'click', kind: 'click', selector: '#search' }, { id: 'search', kind: 'expect', selector: '#search-result', equals: 'found' }], acceptance_refs: { search: ['F-001', 'F-002'] } }
  expect(() => assertRetainedSoftwareBehavior(project.project_id, 'gui', weakened)).toThrow('GUI_RETAINED_BEHAVIOR_MISSING')
  const repaired = { ...old, covers: ['F-001', 'F-002'], steps: old.steps.map(step => 'selector' in step ? { ...step, selector: `#new-${step.id}` } : step) }
  expect(() => assertRetainedSoftwareBehavior(project.project_id, 'gui', repaired)).not.toThrow()
  const changedInput = structuredClone(repaired); (changedInput.steps[0] as { value: string }).value = 'easier-new-input'
  expect(() => assertRetainedSoftwareBehavior(project.project_id, 'gui', changedInput)).toThrow('GUI_RETAINED_INPUT_MISSING')
  brief(true, true)
  expect(() => assertRetainedSoftwareBehavior(project.project_id, 'gui', weakened)).not.toThrow()
})

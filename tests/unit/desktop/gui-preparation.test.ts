import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProject, findProject, updateProject } from '../../../main/project/project-service'
import { syncDocuments, readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/document-engine'
import { organizedPrd } from '../../support/organized-prd'
import { bindAcceptance, prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { projectRequirementsModel } from '../../../main/model/requirements-model'
import { buildFallbackUxDesign, uxDesignFingerprint } from '../../../main/model/ux-design'
import { prepareGuiAcceptance, guiControlBindings } from '../../../main/desktop/gui-acceptance-preparation'
import { guiSuitePath } from '../../../main/desktop/gui-acceptance'
import { readProjectAttempts } from '../../../main/platform/execution/project-attempts'
import { getDocumentsDir } from '../../../storage/config-paths'
import type { SDKQuery } from '../../../main/orchestration/orchestrator'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-gui-preparation-')); process.env.PROMA_HOME = home; process.env.BLOMA_AUTO_GUI_ACCEPTANCE = '1' })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; process.env.BLOMA_AUTO_GUI_ACCEPTANCE = '0'; rmSync(home, { recursive: true, force: true }) })
function setup() {
  const project = createProject({ request_id: 'create', mode: 'quick' })
  const organized = organizedPrd([{ id: 'F-001', description: '保存记录' }], '重启后保留数据')
  const prd = projectRequirementsModel(bindAcceptance({ project_id: project.project_id, name: '记录', positioning: '记录', requirements: organized.requirements,
    requirements_model: organized.requirements_model, acceptance: {}, constraints: [], assumptions: [], out_of_scope: [] }))
  syncDocuments({ request_id: 'setup', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, prd)
  markPrdUserConfirmed(project.project_id)
  const backplane = readPrdBackplane(project.project_id), design = buildFallbackUxDesign(backplane)
  const path = join(project.root_path, '00_UX'); requireDir(path)
  writeFileSync(join(path, 'confirmed.json'), JSON.stringify({ version: 1, design }))
  writeFileSync(join(project.root_path, 'app.py'), '# IMPLEMENTATION_ONLY_MARKER')
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: prdScopeFingerprint(backplane), design_hash: uxDesignFingerprint(design), html_hash: null } })
  const ids = [...new Set(design.interactions.flatMap(item => item.states.flatMap(state => state.scenario_ids)))]
  const suite = { covers: ['F-001'], control_bindings: [{ selector: '#name', description: '记录名输入框' }, { selector: '#save', description: '保存按钮' }, { selector: '#result', description: '结果与错误状态' }],
    acceptance_refs: Object.fromEntries(ids.map((id, i) => [`assert-${i}`, [id]])), steps: [
      { id: 'input', kind: 'fill', selector: '#name', value: '固定输入' }, { id: 'save', kind: 'click', selector: '#save' },
      ...ids.map((_id, i) => ({ id: `assert-${i}`, kind: 'expect', selector: '#result', nonempty: true }))] }
  return { project, suite, scope: prdScopeFingerprint(backplane) }
}
import { mkdirSync } from 'node:fs'
const requireDir = (path: string) => mkdirSync(path, { recursive: true })
describe('independent GUI rules in ordinary production', () => {
  it('creates host-owned frozen expectations before implementation and hands over only control identities', async () => {
    const { project, suite, scope } = setup()
    const query: SDKQuery = vi.fn(async function* (prompt, options) {
      expect(prompt).not.toContain('IMPLEMENTATION_ONLY_MARKER')
      expect(options.accounting).toMatchObject({ role: 'gui_acceptance_planner', projectId: project.project_id })
      expect(options.tools).toBeUndefined()
      yield { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: JSON.stringify(suite) }] } }
    })
    const input = { projectId: project.project_id, sessionId: 's', query, env: {} }
    expect(await prepareGuiAcceptance(input)).toBe(true)
    expect(findProject(project.project_id).gui_acceptance).toMatchObject({ status: 'sealed', scope_hash: scope })
    expect(JSON.parse(readFileSync(guiSuitePath(project.project_id), 'utf8')).acceptance_refs).toEqual(suite.acceptance_refs)
    expect(guiControlBindings(project.project_id)).toEqual(suite.control_bindings)
    expect(await prepareGuiAcceptance(input)).toBe(true)
    expect(query).toHaveBeenCalledOnce()
  })
  it('bounds preparation across retries and preserves unknown rather than weakening rules', async () => {
    const { project } = setup()
    const query: SDKQuery = vi.fn(async function* () { yield { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: '{}' }] } } })
    const input = { projectId: project.project_id, sessionId: 's', query, env: {} }
    expect(await prepareGuiAcceptance(input)).toBe(false)
    expect(await prepareGuiAcceptance(input)).toBe(false)
    expect(await prepareGuiAcceptance(input)).toBe(false)
    expect(query).toHaveBeenCalledTimes(4)
    expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
    expect(findProject(project.project_id).gui_acceptance?.reason).toBe('GUI_PREPARATION_ATTEMPTS_EXHAUSTED')
    expect(Object.values(readProjectAttempts(project.project_id).total)).toEqual([2])
  })
  it.each(['scope', 'cancel', 'missing_coverage', 'vacuous'] as const)('does not seal %s rules', async mode => {
    const { project, suite } = setup(), controller = new AbortController()
    const query: SDKQuery = async function* () {
      if (mode === 'scope') {
        const path = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
        const current = JSON.parse(readFileSync(path, 'utf8')); current.constraints = ['必须离线']; writeFileSync(path, JSON.stringify(current))
      }
      if (mode === 'cancel') controller.abort()
      yield { type: 'assistant' as const, message: { role: 'assistant' as const, content: [{ type: 'text' as const, text: JSON.stringify({ ...suite,
        ...(mode === 'missing_coverage' ? { acceptance_refs: {} } : {}), ...(mode === 'vacuous' ? { steps: suite.steps.filter(step => step.kind === 'expect') } : {}) }) }] } }
    }
    const work = prepareGuiAcceptance({ projectId: project.project_id, sessionId: 's', query, env: {}, signal: controller.signal })
    if (mode === 'cancel') await expect(work).rejects.toThrow()
    else expect(await work).toBe(false)
    expect(existsSync(guiSuitePath(project.project_id))).toBe(false)
  })
  it('does not silently upgrade a legacy project or invoke an extra model', async () => {
    process.env.BLOMA_AUTO_GUI_ACCEPTANCE = '0'
    const project = createProject({ request_id: 'legacy', mode: 'quick' }), query = vi.fn() as SDKQuery
    expect(await prepareGuiAcceptance({ projectId: project.project_id, sessionId: 's', query, env: {} })).toBe(true)
    expect(query).not.toHaveBeenCalled()
  })
})

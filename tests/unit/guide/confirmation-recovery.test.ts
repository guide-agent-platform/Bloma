import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../../main/desktop/desktop-route', () => ({ enterDesktopLine: vi.fn(async () => true), DESKTOP_LINE_TEMPLATE_TYPES: new Set(['desktop_tool', 'game']) }))
vi.mock('../../../main/delivery/preview-scheme', () => ({ mintProjectPreviewUrl: vi.fn((id, path) => `bloma-file://${id}/${path}`) }))
vi.mock('../../../main/guide/ux-visual-pipeline', () => ({ generateUxVisualDesign: vi.fn() }))
vi.mock('../../../storage/json-store', async original => {
  const actual = await original<typeof import('../../../storage/json-store')>()
  return { ...actual, writeTextFileAtomic: vi.fn(actual.writeTextFileAtomic) }
})
import { writeTextFileAtomic } from '../../../storage/json-store'
import { getDocumentsDir } from '../../../storage/config-paths'
import { organizedPrd } from '../../support/organized-prd'
import { createProject } from '../../../main/project/project-service'
import { bindAcceptance } from '../../../main/project/requirement-contract'
import { projectRequirementsModel } from '../../../main/model/requirements-model'
import { syncDocuments, markPrdUserConfirmed, readPrdBackplane } from '../../../main/project/document-engine'
import { buildFallbackUxDesign } from '../../../main/model/ux-design'
import { generateUxVisualDesign } from '../../../main/guide/ux-visual-pipeline'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import { publishPrdConfirmCard, clearPrdConfirmationMemoryForTests, restorePrdConfirmation, replayPrdConfirmation,
  consumePrdConfirmAdjust, hasPrdAdjustAwait, resetPrdConfirmationForTests } from '../../../main/guide/prd-confirm'
import { runUxConfirmGate, clearUxConfirmationMemoryForTests, restoreUxConfirmation, replayUxConfirmation,
  resumeUxConfirmConfirmed, startUxAdjustAwait, takeUxAdjustFeedback, hasPendingUxConfirm, resetUxConfirmForTests } from '../../../main/guide/ux-confirm'
import { guideConfirmationPath, readGuideConfirmation } from '../../../main/guide/confirmation-journal'
import type { AgentSendMessageInput } from '../../../shared/types'
import type { SDKQuery } from '../../../main/orchestration/orchestrator'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-confirmation-recovery-')); process.env.PROMA_HOME = home; vi.clearAllMocks() })
afterEach(() => {
  resetPrdConfirmationForTests(); resetUxConfirmForTests()
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  rmSync(home, { recursive: true, force: true })
})
function setup() {
  const project = createProject({ request_id: 'create', mode: 'quick' })
  const organized = organizedPrd([{ id: 'F-001', description: '保存记录' }], '保存后重启仍保留记录')
  const prd = projectRequirementsModel(bindAcceptance({ project_id: project.project_id, name: '记录', positioning: '记录管理', requirements: organized.requirements,
    requirements_model: organized.requirements_model, acceptance: {}, constraints: [], assumptions: [], out_of_scope: [] }))
  syncDocuments({ request_id: 'setup', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, prd)
  markPrdUserConfirmed(project.project_id)
  const current = readPrdBackplane(project.project_id), design = buildFallbackUxDesign(current)
  const html = '<!DOCTYPE html><html><body>' + design.pages.map(page => `<section data-page-id="${page.id}"></section>`).join('')
    + design.interactions.map(item => `<button data-interaction-id="${item.id}">${item.action}</button>`).join('') + '</body></html>'
  vi.mocked(generateUxVisualDesign).mockResolvedValue({ design, html, source: 'llm' } as never)
  const events: any[] = [], query = vi.fn(async function* () { throw Error('unexpected model call during restore') }) as SDKQuery
  const input = { request_id: 'next', session_id: 's', project_id: project.project_id, content: '', mode: 'quick', current_stage: 'clarifying' } as AgentSendMessageInput
  const pending = { request_id: 'old', session_id: 's', project_id: project.project_id, mode: 'quick' as const,
    query, env: { ANTHROPIC_API_KEY: 'NEVER_PERSIST_THIS' }, signal: new AbortController().signal,
    publish: (event: any) => events.push(event), round: 1, positioning: current.positioning, requirements: current.requirements }
  return { project, current, design, html, events, query, input, pending }
}
describe('PRD/UX durable candidate recovery', () => {
  it('restores the same PRD without serializing credentials or invoking a model', () => {
    const { project, current, input, pending, events, query } = setup()
    publishPrdConfirmCard({ input: pending, backplane: current, requirements: current.requirements, query, env: pending.env, publish: pending.publish })
    expect(readFileSync(guideConfirmationPath('prd', project.project_id), 'utf8')).not.toContain('NEVER_PERSIST_THIS')
    clearPrdConfirmationMemoryForTests()
    const context = { query, env: { ANTHROPIC_API_KEY: 'CURRENT_KEY' }, signal: new AbortController().signal }
    expect(restorePrdConfirmation(input, pending.publish, context)).toBe(true)
    replayPrdConfirmation(project.project_id)
    expect(events.at(-1).payload.requirements[0].id).toBe('F-001')
    expect(query).not.toHaveBeenCalled()
  })
  it('retains PRD adjust-wait and in-flight feedback after a restart', () => {
    const { current, input, pending, query } = setup()
    publishPrdConfirmCard({ input: pending, backplane: current, requirements: current.requirements, query, publish: pending.publish })
    consumePrdConfirmAdjust(input)
    clearPrdConfirmationMemoryForTests()
    restorePrdConfirmation(input, pending.publish, { query, env: {} })
    expect(hasPrdAdjustAwait(input.project_id)).toBe(true)
    consumePrdConfirmAdjust({ ...input, content: '增加导出列' })
    clearPrdConfirmationMemoryForTests()
    restorePrdConfirmation(input, pending.publish, { query, env: {} })
    expect(consumePrdConfirmAdjust({ ...input, content: '重试' })?.unappliedFeedback).toBe('增加导出列')
    expect(query).not.toHaveBeenCalled()
  })
  it('restores the same UX candidate and binds a fresh query and signal before confirming', async () => {
    const { project, input, pending, events, query } = setup()
    await runUxConfirmGate(pending)
    const before = readGuideConfirmation('ux', project.project_id)!
    clearUxConfirmationMemoryForTests()
    const controller = new AbortController(), newQuery = vi.fn(async function* () {}) as SDKQuery
    expect(restoreUxConfirmation(input, pending.publish, { query: newQuery, env: { ANTHROPIC_API_KEY: 'CURRENT' }, signal: controller.signal })).toBe(true)
    replayUxConfirmation(project.project_id)
    expect(readGuideConfirmation('ux', project.project_id)?.data.sketchHtml).toBe(before.data.sketchHtml)
    expect(events.at(-1).payload.kind).toBe('ux_confirm')
    await resumeUxConfirmConfirmed(input)
    expect(enterDesktopLine).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }), newQuery, expect.anything(), expect.anything())
    expect(readGuideConfirmation('ux', project.project_id)).toBeUndefined()
    expect(query).not.toHaveBeenCalled(); expect(newQuery).not.toHaveBeenCalled()
    expect(generateUxVisualDesign).toHaveBeenCalledOnce()
  })
  it('retains UX feedback and the spent round when a crash happens before regeneration', async () => {
    const { input, pending, query } = setup()
    await runUxConfirmGate({ ...pending, round: 3 })
    startUxAdjustAwait(input)
    const taken = takeUxAdjustFeedback({ ...input, content: '按钮改到右侧' })!
    expect(taken.pending.round).toBe(3)
    clearUxConfirmationMemoryForTests()
    restoreUxConfirmation(input, pending.publish, { query, env: {} })
    const retried = takeUxAdjustFeedback({ ...input, content: '重试' })!
    expect(retried.feedback).toBe('按钮改到右侧')
    expect(retried.pending.round).toBe(3)
    expect(generateUxVisualDesign).toHaveBeenCalledOnce()
  })
  it('rejects cross-session recovery, then archives a stale scope without modifying the candidate bytes', async () => {
    const { project, input, pending, query } = setup()
    await runUxConfirmGate(pending); clearUxConfirmationMemoryForTests()
    expect(() => restoreUxConfirmation({ ...input, session_id: 'other' }, pending.publish, { query, env: {} })).toThrow('SESSION_CHANGED')
    const file = guideConfirmationPath('ux', project.project_id), original = readFileSync(file, 'utf8')
    const path = join(getDocumentsDir(project.workspace_slug, project.project_id), 'prd.json')
    const prd = JSON.parse(readFileSync(path, 'utf8')); prd.constraints = ['必须离线']; writeFileSync(path, JSON.stringify(prd))
    expect(() => restoreUxConfirmation(input, pending.publish, { query, env: {} })).toThrow('SCOPE_CHANGED')
    expect(existsSync(file)).toBe(false)
    const archive = join(home, 'pending-confirmations/archive')
    expect(readFileSync(join(archive, readdirSync(archive)[0]), 'utf8')).toBe(original)
  })
  it('quarantines a corrupt record and refuses that confirmation', async () => {
    const { project, input, pending, query } = setup()
    await runUxConfirmGate(pending); clearUxConfirmationMemoryForTests()
    const path = guideConfirmationPath('ux', project.project_id); writeFileSync(path, '{broken')
    expect(() => restoreUxConfirmation(input, pending.publish, { query, env: {} })).toThrow('CORRUPT_ARCHIVED')
    expect(existsSync(path)).toBe(false)
    expect(enterDesktopLine).not.toHaveBeenCalled()
  })
  it('does not consume a UX candidate when persistence of its next state fails', async () => {
    const { project, input, pending } = setup()
    await runUxConfirmGate(pending)
    const path = guideConfirmationPath('ux', project.project_id), before = readFileSync(path, 'utf8')
    vi.mocked(writeTextFileAtomic).mockImplementationOnce(() => { throw Error('disk full') })
    expect(() => startUxAdjustAwait(input)).toThrow('disk full')
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(hasPendingUxConfirm(project.project_id)).toBe(true)
  })
})

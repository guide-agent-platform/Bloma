import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { handleGuideMessage } from '../../../main/guide/stages/guide-pipeline'
import { readConfirmedUxBinding } from '../../../main/project/ux-binding'
import { clearUxConfirmationMemoryForTests } from '../../../main/guide/ux-confirm'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import type { AgentEvent, AgentSendMessageInput } from '../../../shared/types'
import { authorizesDirectBuild } from '../../../main/guide/lean-scope'
import { stageLeanScope } from '../../../main/guide/lean-scope'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'

vi.mock('../../../main/desktop/desktop-route', () => ({ enterDesktopLine: vi.fn(async () => true), DESKTOP_LINE_TEMPLATE_TYPES: new Set(['desktop_tool', 'game']) }))
let home: string, previous: string | undefined
beforeEach(() => { vi.clearAllMocks(); previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-ux-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
it('one scope extraction plus one HTML request reaches preview and survives restart confirmation without any graph or audit calls', async () => {
  const project = createProject({ request_id: 'create', mode: 'longterm' }, { workflowVersion: 'software-v1' })
  const calls: string[] = [], events: AgentEvent[] = []
  const query: SDKQuery = async function* (prompt) {
    calls.push(prompt)
    const text = calls.length === 1 ? JSON.stringify({ action: 'brief', name: '记录', goal: '保存与查看记录', ui: 'required',
      requirements: [{ description: '保存记录', expected: '重开后仍显示记录' }], constraints: [], out_of_scope: [], assumptions: [] })
      : '<!DOCTYPE html><html><body><label>记录<input></label><button>保存</button><ul><li>示例记录</li></ul></body></html>'
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }; yield { type: 'result', subtype: 'success' }
  }
  const input: AgentSendMessageInput = { project_id: project.project_id, session_id: 's', request_id: 'r', mode: 'longterm', current_stage: 'clarifying', content: '做一个本地记录工具，重开保留' }
  const model = { query, env: {}, signal: new AbortController().signal, sessionId: 's', history: [], maxTokens: 8192, persistAssistant: vi.fn() }
  const publish = (event: AgentEvent) => events.push(event)
  await handleGuideMessage(input, publish, model)
  const card = events.find(e => e.payload.kind === 'lean_scope')!
  const scope = (card.payload.questions as Array<{ id: string }>)[0].id
  await handleGuideMessage({ ...input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: scope } }, publish, model)
  expect(calls).toHaveLength(2)
  expect(calls[1]).not.toContain('验收关联索引')
  expect(events.filter(e => e.type === 'ux_sketch_ready')).toHaveLength(1)
  expect(existsSync(join(project.root_path, '00_UX/ux-design.json'))).toBe(false)
  expect(() => readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))).toThrow('UX_CONFIRMATION_MISSING')
  clearUxConfirmationMemoryForTests()
  await handleGuideMessage({ ...input, content: '确认草图', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } }, publish, model)
  expect(calls).toHaveLength(2)
  expect(enterDesktopLine).toHaveBeenCalledTimes(1)
  expect(readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))?.html_path).toBe('00_UX/confirmed.html')
  expect(JSON.parse(readFileSync(join(project.root_path, '00_UX/confirmed.json'), 'utf8'))).toMatchObject({ version: 2, mode: 'lean' })
  expect(findProject(project.project_id).ux_confirmation?.html_hash).toBeTruthy()
  const accepted = readPrdBackplane(project.project_id)
  const revised = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '记录与查找', ui: 'required', requirements: [
    { id: 'F-001', description: '保存记录', expected: '重开后仍显示记录' }, { description: '查找记录', expected: '输入关键词找到记录' }] }),
    { projectId: project.project_id, sessionId: 's', source: '增加查找，保持外观', previous: accepted })!
  if (revised.action !== 'brief') throw Error('fixture')
  stageLeanScope(project.project_id, 's', 'revision', accepted, revised.brief, (type, payload) => publish({ ...events[0], type, payload }))
  expect(readPrdBackplane(project.project_id).lean_brief?.preview).toBe('reuse')
  await handleGuideMessage({ ...input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: `lean_confirm:${prdScopeFingerprint(revised.brief)}` } }, publish, model)
  expect(calls).toHaveLength(2)
  expect(enterDesktopLine).toHaveBeenCalledTimes(2)
  expect(readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))?.html_path).toBe('00_UX/confirmed.html')
  writeFileSync(join(project.root_path, '00_UX/confirmed.html'), 'changed')
  expect(() => readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))).toThrow('UX_CONFIRMATION_CHANGED')
})
it('explicit direct implementation skips preview without a second model request; negatives never approve', async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const query = vi.fn<SDKQuery>(async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ action: 'brief', goal: '计算加法', ui: 'required', requirements: [{ description: '加法', expected: '2加3得5' }] }) }] } }
    yield { type: 'result', subtype: 'success', usage: { output_tokens: 20 } }
  })
  await handleGuideMessage({ project_id: project.project_id, session_id: 's', request_id: 'r', mode: 'quick', current_stage: 'clarifying', content: '做一个加法工具，直接实现，不用草图' }, () => {},
    { query, env: {}, signal: new AbortController().signal, sessionId: 's', history: [], maxTokens: 8192, persistAssistant: vi.fn() })
  expect(query).toHaveBeenCalledTimes(1)
  expect(enterDesktopLine).toHaveBeenCalledTimes(1)
  expect(readPrdBackplane(project.project_id).user_confirmed_at).toBeTruthy()
  expect(readPrdBackplane(project.project_id).lean_brief?.preview).toBe('skip')
  expect(readConfirmedUxBinding(project.project_id, readPrdBackplane(project.project_id))).toBeUndefined()
  expect(existsSync(join(project.root_path, '00_UX/confirmed.html'))).toBe(false)
  expect(authorizesDirectBuild('不要直接做，先确认')).toBe(false)
  expect(authorizesDirectBuild('用户说“直接做”是什么意思')).toBe(false)
  const undecided = createProject({ request_id: 'create-2', mode: 'quick' }, { workflowVersion: 'software-v1' })
  await handleGuideMessage({ project_id: undecided.project_id, session_id: 's2', request_id: 'r2', mode: 'quick', current_stage: 'clarifying', content: '做加法工具，不需要草图，先确认任务单' }, () => {},
    { query, env: {}, signal: new AbortController().signal, sessionId: 's2', history: [], maxTokens: 8192, persistAssistant: vi.fn() })
  expect(readPrdBackplane(undecided.project_id).user_confirmed_at).toBeUndefined()
  expect(readPrdBackplane(undecided.project_id).lean_brief?.preview).toBe('skip')
  expect(enterDesktopLine).toHaveBeenCalledTimes(1)
})

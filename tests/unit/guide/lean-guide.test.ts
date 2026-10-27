import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { handleGuideMessage } from '../../../main/guide/stages/guide-pipeline'
import { getDocumentsDir } from '../../../storage/config-paths'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import type { AgentEvent, AgentSendMessageInput } from '../../../shared/types'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-guide-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true }) })
function fixture(reply: unknown) {
  const project = createProject({ request_id: 'create', mode: 'longterm' }, { workflowVersion: 'software-v1' })
  const calls: string[] = [], events: AgentEvent[] = []
  const query: SDKQuery = async function* (prompt) { calls.push(prompt); yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(reply) }] } }; yield { type: 'result', subtype: 'success' } }
  const input: AgentSendMessageInput = { project_id: project.project_id, session_id: 'session', request_id: 'run', mode: 'longterm',
    current_stage: 'clarifying', content: '做一个保存记录的小工具，关掉重开还在', metadata: { source: 'chat' } }
  const options = { query, env: {}, signal: new AbortController().signal, sessionId: 'session', history: [], maxTokens: 8192, persistAssistant: vi.fn() }
  const publish = (event: AgentEvent) => events.push(event)
  return { project, input, options, publish, calls, events }
}
const brief = { action: 'brief', name: '记录', goal: '记录并重开保留', ui: 'required', requirements: [{ description: '保存记录', expected: '重开后记录仍在' }], constraints: ['本地使用'], out_of_scope: [], assumptions: [] }
it('one model request produces one task confirmation, without audit, research or longterm document expansion', async () => {
  const f = fixture(brief)
  await handleGuideMessage(f.input, f.publish, f.options)
  expect(f.calls).toHaveLength(1)
  expect(f.events.filter(e => e.type === 'user_decision_required').map(e => e.payload.kind)).toEqual(['lean_scope'])
  expect(f.events.some(e => e.type.startsWith('delegation_'))).toBe(false)
  const saved = readPrdBackplane(f.project.project_id)
  expect(saved.requirements_model).toBeUndefined()
  expect(saved.requirements[0].behavior_assertions).toEqual(['重开后记录仍在'])
  expect(saved.lean_brief?.source_session_id).toBe('session')
  expect(saved.user_confirmed_at).toBeUndefined()
  const dir = getDocumentsDir(f.project.workspace_slug, f.project.project_id)
  expect(readdirSync(dir)).toContain('task.md')
  expect(readdirSync(dir)).not.toContain('plantuml')
  expect(findProject(f.project.project_id).desktop_phase).toBeUndefined()
})
it('a real critical question remains a question, with no timeout or task generation', async () => {
  const f = fixture({ action: 'clarify', question: '记录要保留在本机还是同步？', options: ['只在本机', '同步'] })
  await handleGuideMessage(f.input, f.publish, f.options)
  expect(f.calls).toHaveLength(1)
  expect(f.events.some(e => e.payload.kind === 'lean_scope')).toBe(false)
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(0)
})
it('continue after pausing only redisplays the accepted candidate and does not spend another request', async () => {
  const f = fixture(brief)
  await handleGuideMessage(f.input, f.publish, f.options)
  await handleGuideMessage({ ...f.input, metadata: { source: 'card_option', selected_option_id: 'lean_pause' } }, f.publish, f.options)
  await handleGuideMessage({ ...f.input, content: '继续' }, f.publish, f.options)
  expect(f.calls).toHaveLength(1)
  expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined()
  expect(f.events.filter(e => e.payload.kind === 'lean_scope')).toHaveLength(2)
})
it('rejects stale confirmation and does not treat a malformed saved brief as empty', async () => {
  const f = fixture(brief)
  await handleGuideMessage(f.input, f.publish, f.options)
  await expect(handleGuideMessage({ ...f.input, metadata: { source: 'card_option', selected_option_id: 'lean_confirm:old' } }, f.publish, f.options)).rejects.toThrow('LEAN_CONFIRMATION_STALE')
  const path = join(getDocumentsDir(f.project.workspace_slug, f.project.project_id), 'prd.json')
  const old = readFileSync(path, 'utf8')
  expect(old).toContain('lean_brief')
  writeFileSync(path, 'broken')
  expect(() => readPrdBackplane(f.project.project_id)).toThrow('LEAN_BRIEF_UNREADABLE')
  expect(readFileSync(path, 'utf8')).toBe('broken')
})

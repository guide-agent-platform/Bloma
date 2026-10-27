import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { handleLeanGuide } from '../../../main/guide/lean-guide'
import { readPendingDecision } from '../../../main/guide/pending-decision'
import { guideConfirmationPath, readGuideConfirmation } from '../../../main/guide/confirmation-journal'
import { parseLeanSuggestions } from '../../../main/guide/lean-suggestions'
import { prdScopeFingerprint, trustedAcceptance } from '../../../main/project/requirement-contract'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import type { AgentEvent, AgentSendMessageInput, LeanScopeView } from '../../../shared/types'

vi.mock('../../../main/desktop/desktop-route', () => ({ enterDesktopLine: vi.fn(async () => true) }))
let home: string, old: string | undefined
beforeEach(() => { vi.clearAllMocks(); old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-ideas-')); process.env.PROMA_HOME = home })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true }) })
const idea = { title: '按关键词查找', description: '按关键词查找已保存记录', benefit: '记录多了也能快速找到', expected: '输入关键词，只显示匹配的记录' }
const other = { title: '导出备份', description: '导出本地记录备份', benefit: '换电脑时可以带走记录', expected: '导出文件包含现有记录' }
async function setup(content = '做个本地保存记录的命令工具，先确认任务单') {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const query = vi.fn<SDKQuery>(async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({
      action: 'brief', goal: '保存并查看本地记录', ui: 'none', delivery: 'command',
      requirements: [{ description: '保存记录', expected: '重开后记录仍在' }], constraints: ['无需联网'], out_of_scope: ['账号'], suggestions: [idea, other],
    }) }] } }; yield { type: 'result', subtype: 'success' }
  })
  const input: AgentSendMessageInput = { request_id: 'run', project_id: project.project_id, session_id: 'owner', mode: 'quick', current_stage: 'clarifying', content }
  const model = { query, env: {}, signal: new AbortController().signal, sessionId: 'owner', history: [], maxTokens: 8192, persistAssistant: vi.fn() }
  const events: AgentEvent[] = [], publish = (event: AgentEvent) => { events.push(event) }
  await handleLeanGuide(input, publish, model)
  const card = events.find(event => event.payload.kind === 'lean_scope')!
  const scope = card.payload.scope as unknown as LeanScopeView
  return { project, input, model, events, publish, query, scope }
}

it('returns optional ideas in the same extraction without adding them to authoritative requirements', async () => {
  const f = await setup(), brief = readPrdBackplane(f.project.project_id)
  expect(f.query).toHaveBeenCalledTimes(1)
  expect(f.scope.suggestions).toHaveLength(2)
  expect(brief.requirements.map(row => row.description)).toEqual(['保存记录'])
  expect(brief.constraints).toEqual(['无需联网']); expect(brief.out_of_scope).toEqual(['账号'])
  expect(JSON.stringify(brief)).not.toContain(idea.description)
  expect(enterDesktopLine).not.toHaveBeenCalled()
})

it('adopts only saved selections, keeps original ids and expectations, and requires confirmation of the updated sheet', async () => {
  const f = await setup(), before = readPrdBackplane(f.project.project_id), scope = prdScopeFingerprint(before)
  const id = f.scope.suggestions![0].id
  const adopt = { ...f.input, content: '采纳所选建议，更新任务单', metadata: { source: 'card_option' as const, selected_option_id: `lean_adopt:${scope}`, selected_suggestion_ids: [id] } }
  await handleLeanGuide(adopt, f.publish, f.model)
  const after = readPrdBackplane(f.project.project_id), pending = readPendingDecision(f.project.project_id, 'owner')!
  expect(after.requirements[0]).toEqual(before.requirements[0]); expect(after.acceptance['F-001']).toBe('重开后记录仍在')
  expect(after.requirements[1]).toMatchObject({ id: 'F-002', description: idea.description })
  expect(trustedAcceptance(after, after.requirements[1])).toBe(idea.expected)
  expect(after.constraints).toEqual(before.constraints); expect(after.out_of_scope).toEqual(before.out_of_scope)
  expect(after.user_confirmed_at).toBeUndefined(); expect(enterDesktopLine).not.toHaveBeenCalled()
  expect(pending.payload).toMatchObject({ scope: { suggestions: [{ title: other.title }] } })
  expect(readGuideConfirmation('prd', f.project.project_id)?.data.adopted_suggestions).toEqual([f.scope.suggestions![0]])
  await expect(handleLeanGuide(adopt, f.publish, f.model)).rejects.toThrow('LEAN_CONFIRMATION_STALE')
  await expect(handleLeanGuide({ ...f.input, metadata: { source: 'card_option', selected_option_id: `lean_confirm:${scope}` } }, f.publish, f.model)).rejects.toThrow('LEAN_CONFIRMATION_STALE')
  await handleLeanGuide({ ...f.input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: `lean_confirm:${prdScopeFingerprint(after)}` } }, f.publish, f.model)
  expect(f.query).toHaveBeenCalledTimes(1); expect(enterDesktopLine).toHaveBeenCalledTimes(1)
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(2)
})

it('restores saved suggestions after pause without another request or mutation', async () => {
  const f = await setup(), file = guideConfirmationPath('prd', f.project.project_id)
  const bytes = readFileSync(file, 'utf8')
  expect(readPendingDecision(f.project.project_id, 'owner')?.payload).toMatchObject({ scope: { suggestions: f.scope.suggestions } })
  expect(readFileSync(file, 'utf8')).toBe(bytes)
  await handleLeanGuide({ ...f.input, metadata: { source: 'card_option', selected_option_id: 'lean_pause' } }, f.publish, f.model)
  await handleLeanGuide({ ...f.input, content: '继续' }, f.publish, f.model)
  expect(f.events.filter(event => event.payload.kind === 'lean_scope').at(-1)?.payload.scope).toMatchObject({ suggestions: f.scope.suggestions })
  expect(readPendingDecision(f.project.project_id, 'owner')?.payload).toMatchObject({ scope: { suggestions: f.scope.suggestions } })
  await handleLeanGuide({ ...f.input, metadata: { source: 'card_option', selected_option_id: `lean_adopt:${prdScopeFingerprint(readPrdBackplane(f.project.project_id))}`, selected_suggestion_ids: [f.scope.suggestions![0].id] } }, f.publish, f.model)
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(2)
  expect(f.query).toHaveBeenCalledTimes(1)
})

it('rejects unknown, duplicate and foreign-session picks without changing scope or requesting a model', async () => {
  const f = await setup(), before = readPrdBackplane(f.project.project_id), hash = prdScopeFingerprint(before), id = f.scope.suggestions![0].id
  for (const ids of [['S-unknown'], [id, id], []]) {
    await expect(handleLeanGuide({ ...f.input, metadata: { source: 'card_option', selected_option_id: `lean_adopt:${hash}`, selected_suggestion_ids: ids } }, f.publish, f.model)).rejects.toThrow('LEAN_SUGGESTION_SELECTION_INVALID')
  }
  await expect(handleLeanGuide({ ...f.input, session_id: 'foreign', metadata: { source: 'card_option', selected_option_id: `lean_adopt:${hash}`, selected_suggestion_ids: [id] } }, f.publish, f.model)).rejects.toThrow('LEAN_CONFIRMATION_OWNER_MISMATCH')
  await expect(handleLeanGuide({ ...f.input, metadata: { source: 'card_option', selected_option_id: `lean_confirm:${hash}`, selected_suggestion_ids: [id] } }, f.publish, f.model)).rejects.toThrow('LEAN_SUGGESTIONS_NOT_APPLIED')
  expect(prdScopeFingerprint(readPrdBackplane(f.project.project_id))).toBe(hash); expect(f.query).toHaveBeenCalledTimes(1)
})

it('confirmation without picks and explicit direct build never adopt optional suggestions', async () => {
  const f = await setup(), hash = prdScopeFingerprint(readPrdBackplane(f.project.project_id))
  await handleLeanGuide({ ...f.input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: `lean_confirm:${hash}` } }, f.publish, f.model)
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(1); expect(f.query).toHaveBeenCalledTimes(1)
  const direct = await setup('做个保存记录的命令工具，直接做')
  expect(readPrdBackplane(direct.project.project_id).requirements).toHaveLength(1)
  expect(readPrdBackplane(direct.project.project_id).user_confirmed_at).toBeTruthy(); expect(direct.query).toHaveBeenCalledTimes(1)
})

it('invalid optional output cannot block a valid brief, and idea ids track their complete content', () => {
  expect(parseLeanSuggestions([null, idea, { ...idea, title: '重复建议' }, { ...other, expected: '' }], []).map(row => row.title)).toEqual([idea.title])
  expect(parseLeanSuggestions([idea], [idea.description])).toEqual([])
  expect(parseLeanSuggestions({ suggestions: [idea] })).toEqual([])
  expect(parseLeanSuggestions([idea])[0].id).not.toBe(parseLeanSuggestions([{ ...idea, expected: '不同结果' }])[0].id)
})

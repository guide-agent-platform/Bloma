import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { enterDesktopLine, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { SDKQueryOptions, SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { readCorrectionSubmission, saveCorrectionSubmission } from '../../../main/desktop/correction-outbox'
import { cliSuitePath } from '../../../main/desktop/lean-cli-check'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-build-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }) })
function setup(mode: 'quick' | 'longterm') {
  const project = createProject({ request_id: 'create', mode }, { workflowVersion: 'lean-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出42', ui: 'none', requirements: [{ description: '计算结果', expected: '输出42' }] }),
    { projectId: project.project_id, sessionId: 's', source: '输出42', previous: readPrdBackplane(project.project_id) })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief)
  markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' }))
  const messages: SDKQueryOptions[] = []
  const query: SDKQuery = async function* (_prompt, options) {
    messages.push(options)
    yield { type: 'assistant', message: { role: 'assistant', content: messages.length === 1
      ? [{ type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'app.py', content: 'print(42)\n' } }]
      : [{ type: 'text', text: '实现已保存。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 } }
  }
  const deps: DesktopRouteDeps = { publish: vi.fn(), persistAssistant: vi.fn(), persistSystem: vi.fn(), complete: vi.fn(),
    coreVerification: vi.fn(async () => ({ status: 'passed' as const, summary: 'checked', checked_at: new Date().toISOString(), missing: [], evidence: [] })),
    securityScan: vi.fn(() => ({ passed: true, blocking: 0, scanned: 1, listing: '' })), launchSmoke: vi.fn(async () => ({ passed: true, detail: 'normal entry checked' })) }
  const input = { projectId: project.project_id, sessionId: 's', requestId: 'run', content: '按目标实现', maxTokens: 8192, signal: new AbortController().signal }
  return { project, messages, query, deps, input }
}
it.each(['quick', 'longterm'] as const)('one real Pi executor edits and reaches host delivery for %s without stage markers or architecture documents', async mode => {
  const f = setup(mode)
  expect(await enterDesktopLine(f.input, f.query, {}, f.deps)).toBe(true)
  expect(readFileSync(join(f.project.root_path, 'app.py'), 'utf8')).toContain('print(42)')
  expect(f.messages).toHaveLength(2)
  expect(JSON.stringify(f.messages)).not.toContain('PHASE_ADVANCE')
  expect(existsSync(join(f.project.root_path, '00_ARCH'))).toBe(false)
  expect(findProject(f.project.project_id)).toMatchObject({ desktop_phase: 'delivered', status: 'completed' })
  expect(f.deps.coreVerification).toHaveBeenCalledTimes(1); expect(f.deps.launchSmoke).toHaveBeenCalledTimes(1)
})
it('a host failure repairs in the same transcript; missing environment stops without blind repairs', async () => {
  const f = setup('longterm')
  vi.mocked(f.deps.coreVerification!).mockResolvedValueOnce({ status: 'failed', summary: 'wrong result', checked_at: '', missing: ['expected42 actual41'], evidence: [] })
  await enterDesktopLine(f.input, f.query, {}, f.deps)
  expect(f.messages).toHaveLength(3)
  expect(JSON.stringify(f.messages[2].messages)).toContain('expected42 actual41')
  expect(JSON.stringify(f.messages[2].messages)).toContain('print(42)')
  expect(findProject(f.project.project_id).status).toBe('completed')
  const blocked = setup('quick')
  vi.mocked(blocked.deps.coreVerification!).mockResolvedValue({ status: 'environment_blocked', summary: 'missing runtime', checked_at: '', missing: ['runtime unavailable'], evidence: [] })
  await enterDesktopLine(blocked.input, blocked.query, {}, blocked.deps)
  expect(blocked.messages).toHaveLength(2)
  expect(findProject(blocked.project.project_id).status).toBe('active')
  expect(blocked.deps.complete).toHaveBeenLastCalledWith('s', blocked.project.project_id, 'incomplete')
  expect(blocked.deps.launchSmoke).not.toHaveBeenCalled()
})
it('scope changes pause the native session before later tools and retain the operation budget and prior scope history', async () => {
  const f = setup('quick'), operation = f.project.lean_operation_id
  const query: SDKQuery = async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [
      { type: 'tool_use', id: 'scope', name: 'propose_scope_change', input: { goal: '输出42并保存记录', ui: 'none', requirements: [
        { id: 'F-001', description: '计算结果', expected: '输出42' }, { description: '保存记录', expected: '重开仍能读取记录' }] } },
      { type: 'tool_use', id: 'bad', name: 'write_file', input: { path: 'should-not-run.py', content: 'print(0)' } },
    ] } }
    yield { type: 'result', subtype: 'success', usage: { output_tokens: 10 } }
  }
  await enterDesktopLine({ ...f.input, content: '增加保存记录' }, query, {}, f.deps)
  expect(existsSync(join(f.project.root_path, 'should-not-run.py'))).toBe(false)
  expect(findProject(f.project.project_id)).toMatchObject({ lean_operation_id: operation, current_stage: 'blocked_for_user_decision' })
  expect(findProject(f.project.project_id).desktop_phase).toBeUndefined()
  expect(readPrdBackplane(f.project.project_id).user_confirmed_at).toBeUndefined()
  expect(readPrdBackplane(f.project.project_id).requirements).toHaveLength(2)
  expect(leanBudget(f.project.project_id, 'desktop-implement').snapshot().requests).toBe(1)
  expect(f.deps.coreVerification).not.toHaveBeenCalled()
})
it('a new explicit post-delivery change keeps the native transcript while starting its own operation; thanks spends nothing', async () => {
  const f = setup('quick')
  await enterDesktopLine(f.input, f.query, {}, f.deps)
  const operation = findProject(f.project.project_id).lean_operation_id
  await enterDesktopLine({ ...f.input, content: '谢谢' }, f.query, {}, f.deps)
  expect(f.messages).toHaveLength(2)
  expect(findProject(f.project.project_id).lean_operation_id).toBe(operation)
  saveCorrectionSubmission(f.project.project_id, '修改提示文字，其他功能保持', 1)
  await enterDesktopLine({ ...f.input, requestId: 'modify', content: '继续' }, f.query, {}, f.deps)
  expect(findProject(f.project.project_id).lean_operation_id).not.toBe(operation)
  expect(JSON.stringify(f.messages[2].messages)).toContain('print(42)')
})
it('cannot deliver if the final runtime accounting record becomes unreadable', async () => {
  const f = setup('quick')
  vi.mocked(f.deps.coreVerification!).mockImplementation(async () => {
    writeFileSync(leanBudget(f.project.project_id, 'desktop-implement').snapshot().file, 'broken')
    return { status: 'passed', summary: 'checked', checked_at: '', evidence: [], missing: [] }
  })
  await enterDesktopLine(f.input, f.query, {}, f.deps)
  expect(findProject(f.project.project_id).status).toBe('active')
  expect(f.deps.complete).toHaveBeenLastCalledWith('s', f.project.project_id, 'incomplete')
  expect(f.deps.persistAssistant).toHaveBeenCalledWith('s', expect.stringContaining('HARNESS_BUDGET_UNREADABLE'))
  expect(vi.mocked(f.deps.persistAssistant).mock.calls.every(([, text]) => !text.includes('本次目标已完成'))).toBe(true)
})
it('keeps correction outbox pending on admission failure, then resumes it into the same durable task', async () => {
  const f = setup('quick'), budget = leanBudget(f.project.project_id, 'desktop-implement')
  const correction = saveCorrectionSubmission(f.project.project_id, '点选按钮：修正文字，其余行为保持', 1)
  budget.recordRuntime(0)
  const state = budget.snapshot()
  writeFileSync(state.file, JSON.stringify({ ...state, requests: state.limits.requests }))
  await enterDesktopLine(f.input, f.query, {}, f.deps)
  expect(f.messages).toHaveLength(0)
  expect(readCorrectionSubmission(f.project.project_id)?.id).toBe(correction.id)
  writeFileSync(state.file, JSON.stringify({ ...budget.snapshot(), requests: 0 }))
  await enterDesktopLine({ ...f.input, requestId: 'resume', content: '继续' }, f.query, {}, f.deps)
  expect(readCorrectionSubmission(f.project.project_id)).toBeUndefined()
  expect(JSON.stringify(f.messages[0].messages)).toContain('点选按钮：修正文字')
  expect(findProject(f.project.project_id).status).toBe('completed')
})
it('rejects a verification-rule change between the host check and delivery', async () => {
  const f = setup('quick')
  vi.mocked(f.deps.securityScan!).mockImplementation(() => {
    mkdirSync(join(home, 'cli-acceptance'), { recursive: true })
    writeFileSync(cliSuitePath(f.project.project_id), 'changed after the core check')
    return { passed: true, blocking: 0, scanned: 1, listing: '' }
  })
  await enterDesktopLine(f.input, f.query, {}, f.deps)
  expect(findProject(f.project.project_id).status).toBe('active')
  expect(f.deps.complete).toHaveBeenLastCalledWith('s', f.project.project_id, 'incomplete')
})

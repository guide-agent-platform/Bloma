import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createQualityReview, readQualityLedger, qualityLedgerPath } from '../../../main/software/quality-review'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { buildLeanCliTool, cliSuitePath } from '../../../main/desktop/lean-cli-check'
import { registerParentLoopContext, disposeParentDelegationState, settleParentDelegationRuns, findDelegation } from '../../../main/agent/delegation/agent-collaboration'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'

let home: string, oldHome: string | undefined, project: ReturnType<typeof createProject>, policy: ReturnType<typeof createSoftwareCollaborationPolicy>, quality: ReturnType<typeof createQualityReview>
const parent = 'quality-parent'
const ctx = (sessionId = parent): ToolContext => ({ projectId: project.project_id, sessionId, requestId: 'r', state: createToolState(), signal: AbortSignal.timeout(60000) })
const finding = { requirement: 'F-001', expected_source: '2加3得5', category: 'data', severity: 'high', location: 'app.cjs:1', trigger: '输入2与3', evidence: '实现输出999', reproduction: '正常入口传2与3', unknowns: '', kind: 'suspected' }
beforeEach(async () => {
  oldHome = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-quality-')); process.env.PROMA_HOME = home
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '加法', ui: 'none', delivery: 'command', requirements: [{ description: '计算加法', expected: '2加3得5' }] }),
    { projectId: project.project_id, sessionId: parent, source: '加法', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: parent, checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  const registered = await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '2加3得5' }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] }, ctx())
  expect(registered.isError).not.toBe(true)
  policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, parent); quality = createQualityReview(project.project_id, parent, policy)
})
afterEach(async () => {
  disposeParentDelegationState(parent); await settleParentDelegationRuns(parent, 20000)
  if (oldHome === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = oldHome
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})
function register(query: SDKQuery) {
  registerParentLoopContext(parent, { query, env: {}, maxTokens: 2048, maxTurns: 4, delegationMaxTurns: 4, permissionMode: 'allow-all',
    system: 'A_SUCCESS_STORY_MUST_NOT_LEAK', temperature: .1, editFormat: 'diff', maxConcurrentDelegations: 2, allowChannelOverrides: false,
    prepareDelegation: quality.prepare, childSystemBuilder: (_role, child) => quality.system(child)!,
    childToolsBuilder: (id, role) => quality.reviewTools(buildSoftwareAgentTools(id, role, policy)), publish: () => {} })
}
async function review(findings: Record<string, unknown>[] = [finding]) {
  let calls = 0
  register(async function* (_prompt, options) {
    expect(JSON.stringify(options.messages?.filter(m => m.role === 'system'))).not.toContain('A_SUCCESS_STORY_MUST_NOT_LEAK')
    yield { type: 'assistant', message: { role: 'assistant', content: ++calls === 1
      ? [{ type: 'tool_use', id: 'materials', name: 'read_quality_review', input: {} }, { type: 'tool_use', id: 'source', name: 'read_file', input: { path: 'app.cjs' } }, { type: 'tool_use', id: 'submit', name: 'submit_quality_findings', input: { findings } }]
      : [{ type: 'text', text: '已提交疑点，未验证。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  })
  const child = await quality.begin(ctx()); await findDelegation(parent, child.delegation_id)!.completion; await settleParentDelegationRuns(parent)
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('complete')
  return child
}
it('actual Pi C submits host-bound findings; a real injected CLI defect fails, is repaired, and closes only after same-case host retest', async () => {
  await review()
  const initial = readQualityLedger(project.project_id).findings[0]
  expect(initial.disposition).toBe('suspected'); expect(await quality.gate()).toBeUndefined()
  const check = quality.parentTools.find(t => t.name === 'check_quality_finding')!
  await expect(check.execute({ finding_id: initial.id, case_name: 'sum', status: 'passed' }, ctx())).rejects.toThrow('INVALID')
  await check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())
  expect(readQualityLedger(project.project_id).findings[0].disposition).toBe('confirmed')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(Number(process.argv[2])+Number(process.argv[3]))')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
  await check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())
  const repaired = readQualityLedger(project.project_id).findings[0]
  expect(repaired.disposition).toBe('closed'); expect(repaired.checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(repaired.checks[0].observation).toContain('999'); expect(repaired.checks[1].observation).toContain('5')
  expect(repaired.checks[0].identity.source).not.toBe(repaired.checks[1].identity.source)
  await review([]); expect(await quality.gate()).toBeUndefined()
  // A different contract cannot reuse a closed finding, even with unchanged code.
  const file = cliSuitePath(project.project_id), bytes = readFileSync(file, 'utf8'); writeFileSync(file, bytes + '\n')
  expect(await quality.gate()).toContain('FINDINGS_OPEN')
  await expect(check.execute({ finding_id: initial.id, case_name: 'sum' }, ctx())).rejects.toThrow('CONTRACT_CHANGED')
}, 120000)
it('parent cannot forge a C submission; no-source opinions remain disputed/suggestions and cannot be reproduced as defects', async () => {
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx())).rejects.toThrow('DENIED')
  await review([{ ...finding, expected_source: '应当自动增加备份功能' }, { ...finding, requirement: 'unknown' }])
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings.map(f => f.disposition)).toEqual(['disputed', 'suggestion'])
  await expect(quality.parentTools.find(t => t.name === 'check_quality_finding')!.execute({ finding_id: ledger.findings[0].id, case_name: 'sum' }, ctx())).rejects.toThrow('UNGROUNDED')
})
it('review freezes writers and commands; external source changes and cancellation cannot submit stale findings', async () => {
  register(async function* () { await new Promise(() => {}) })
  const child = await quality.begin(ctx())
  expect(() => policy.assertFileWrite('app.cjs', ctx())).toThrow('FROZEN')
  expect(() => policy.assertCommand(ctx())).toThrow('FROZEN')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('MATERIALS_NOT_READ')
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(123)')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('STALE')
  disposeParentDelegationState(parent)
  expect(() => policy.assertCommand(ctx())).not.toThrow()
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  await expect(quality.childProtocol[1].execute({ findings: [] }, ctx(child.child_session_id))).rejects.toThrow('DENIED')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('a later cancelled review cannot revive a prior completed review of identical bytes', async () => {
  await review([]); expect(await quality.gate()).toBeUndefined()
  register(async function* () { await new Promise(() => {}) })
  await quality.begin(ctx()); disposeParentDelegationState(parent)
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('a model saying PASS without reading material and submitting the protocol cannot satisfy the completion gate', async () => {
  register(async function* () {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'PASS，所有问题已经修复。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  })
  const child = await quality.begin(ctx()); await findDelegation(parent, child.delegation_id)!.completion
  expect(readQualityLedger(project.project_id).reviews.at(-1)?.status).toBe('interrupted')
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
})
it('target/design changes invalidate old C evidence; corruption is not silently converted to an empty ledger', async () => {
  await review([])
  const { updateProject } = await import('../../../main/project/project-service')
  updateProject(project.project_id, { ux_confirmation: { token: 'changed' } as never })
  expect(await quality.gate()).toContain('REVIEW_REQUIRED')
  writeFileSync(qualityLedgerPath(project.project_id), '{broken')
  await expect(quality.gate()).rejects.toThrow()
})
it('complete production runs C, reproduces and repairs a finding, reruns C on the new candidate and delivers through the existing verifier', async () => {
  const { enterDesktopLine } = await import('../../../main/desktop/desktop-route')
  const { findProject } = await import('../../../main/project/project-service')
  let parentStep = 0, cReviews = 0
  const children = new Set<string>()
  const use = (name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id: `${parentStep}-${name}`, name, input })
  const query: SDKQuery = async function* (_prompt, options) {
    let content
    if (JSON.stringify(options.messages?.filter(m => m.role === 'system')).includes('独立只读代码/数据审阅C')) {
      if (!children.has(options.sessionId)) {
        children.add(options.sessionId); cReviews++
        content = [use('read_quality_review', {}), use('read_file', { path: 'app.cjs' }), use('submit_quality_findings', { findings: cReviews === 1 ? [finding] : [] })]
      } else content = [{ type: 'text' as const, text: '只读意见已提交。' }]
    } else {
      const id = readQualityLedger(project.project_id).findings[0]?.id
      switch (parentStep++) {
        case 0: content = [{ type: 'text' as const, text: '稳定候选已保留，请核查。' }]; break
        case 1: content = [use('check_quality_finding', { finding_id: id, case_name: 'sum' })]; break
        case 2: content = [use('read_file', { path: 'app.cjs' }), use('write_file', { path: 'app.cjs', content: 'console.log(Number(process.argv[2]||2)+Number(process.argv[3]||3))' })]; break
        case 3: content = [use('check_quality_finding', { finding_id: id, case_name: 'sum' })]; break
        default: content = [{ type: 'text' as const, text: '修复和复测已执行，请核对当前候选。' }]
      }
    }
    yield { type: 'assistant', message: { role: 'assistant', content } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId: parent, requestId: 'r', content: '完成已确认加法软件', maxTokens: 2048, signal: AbortSignal.timeout(90000) }, query, {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  expect(findProject(project.project_id).desktop_blocked, JSON.stringify(readQualityLedger(project.project_id))).toBeUndefined()
  expect(findProject(project.project_id).status).toBe('completed')
  expect(cReviews).toBe(2)
  const ledger = readQualityLedger(project.project_id)
  expect(ledger.findings[0].disposition).toBe('closed')
  expect(ledger.findings[0].checks.map(c => c.outcome)).toEqual(['failed', 'passed'])
  expect(ledger.reviews.filter(r => r.status === 'complete')).toHaveLength(2)
}, 120000)

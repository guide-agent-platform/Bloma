import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { setJsSyntaxCheckerForTests } from '../../../main/agent/tools/agent-tools'
import { registerParentLoopContext, startDelegation, stopDelegations, disposeParentDelegationState, continueDelegation, settleParentDelegationRuns, findDelegation } from '../../../main/agent/delegation/agent-collaboration'
import { createProductionBudget } from '../../../main/desktop/production-budget'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, policy: ReturnType<typeof createSoftwareCollaborationPolicy>
const parent = 'software-parent'
const context = (sessionId = parent, signal = new AbortController().signal): ToolContext => ({ projectId: project.project_id, sessionId, requestId: 'r', signal,
  state: { ...createToolState(), execution_scope: 'one-operation' } })
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-ownership-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }); policy = createSoftwareCollaborationPolicy(project.project_id, project.root_path, parent) })
afterEach(async () => { disposeParentDelegationState(parent); setJsSyntaxCheckerForTests(); await settleParentDelegationRuns(parent, 20000);
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 30000)
const assign = (session: string, paths: string[], role: 'implement' | 'review' = 'implement') => policy.prepare({ parent: context(), args: { task: 'bounded task', role, writePaths: paths }, childSessionId: session, delegationId: session })
it('actual file tools enforce ownership for root and children; integrator commands wait for writers', async () => {
  const lease = assign('child', ['owned.txt'])
  expect(() => assign('other', ['owned.txt'])).toThrow('CONFLICT')
  const child = buildSoftwareAgentTools(project.project_id, 'implement', policy)
  const root = buildSoftwareAgentTools(project.project_id, 'parent', policy)
  const write = (tools: typeof child, path: string, ctx: ToolContext) => tools.find(t => t.name === 'write_file')!.execute({ path, content: 'actual content' }, ctx)
  await expect(write(child, 'elsewhere.txt', context('child'))).rejects.toThrow('SCOPE_DENIED')
  await expect(write(root, 'owned.txt', context())).rejects.toThrow('OWNED')
  expect((await write(child, 'owned.txt', context('child'))).isError).not.toBe(true)
  expect((await write(root, 'integration.txt', context())).isError).not.toBe(true)
  expect(readFileSync(join(project.root_path, 'owned.txt'), 'utf8')).toBe('actual content')
  expect(child.some(t => t.name === 'run_command')).toBe(false)
  expect((await root.find(t => t.name === 'run_command')!.execute({ command: ['node', '-e', 'console.log(42)'] }, context())).isError).toBe(true)
  lease.release()
  expect((await root.find(t => t.name === 'run_command')!.execute({ command: ['node', '-e', 'console.log(42)'] }, context())).output).toContain('42')
})
it('read-only roles cannot write, and review results detect concurrent source changes', async () => {
  const lease = assign('review', [], 'review')
  const tools = buildSoftwareAgentTools(project.project_id, 'review', policy)
  expect(tools.some(t => ['write_file', 'edit_file', 'run_command', 'delegate_agent'].includes(t.name))).toBe(false)
  expect(() => policy.assertFileWrite('a.txt', context('review'))).toThrow('SCOPE_DENIED')
  const root = buildSoftwareAgentTools(project.project_id, 'parent', policy)
  await root.find(t => t.name === 'write_file')!.execute({ path: 'changed.ts', content: 'export const value = 1' }, context())
  expect(lease.completionNote?.()).toContain('源码已变化')
})
it('cancellation while syntax validation awaits cannot commit a late child write after ownership was released', async () => {
  const lease = assign('child', ['late.js']), abort = new AbortController()
  let release!: (value: { ok: true }) => void, started!: () => void
  const entered = new Promise<void>(resolve => { started = resolve })
  setJsSyntaxCheckerForTests(async () => { started(); return new Promise(resolve => { release = resolve }) })
  const write = buildSoftwareAgentTools(project.project_id, 'implement', policy).find(t => t.name === 'write_file')!
  const pending = write.execute({ path: 'late.js', content: 'console.log(1)' }, context('child', abort.signal))
  await entered; abort.abort(); lease.release(); release({ ok: true })
  await expect(pending).rejects.toThrow()
  expect(existsSync(join(project.root_path, 'late.js'))).toBe(false)
})
it('two actual child loops consume the shared request budget; the parent gets no fresh quota', async () => {
  const budget = createProductionBudget(project.project_id, 'shared-operation', 'desktop-implement', { requests: 2, output: 4096, perResponse: 1024, phaseRequests: 2 })
  const query = budget.wrap(async function* () { yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '已检查，供主负责人集成' }] } }; yield { type: 'result', subtype: 'success', usage: { output_tokens: 10 } } })
  registerParentLoopContext(parent, { query, env: {}, maxTokens: 512, maxTurns: 2, delegationMaxTurns: 2,
    permissionMode: 'allow-all', temperature: .1, system: 'main', editFormat: 'diff', runtime: 'pi', maxConcurrentDelegations: 2, allowChannelOverrides: false,
    prepareDelegation: policy.prepare, publish: () => undefined, childToolsBuilder: (id, role) => buildSoftwareAgentTools(id, role, policy) })
  const a = startDelegation(context(), { task: 'read one', role: 'review' }), b = startDelegation(context(), { task: 'read two', role: 'review' })
  await Promise.all([a, b].map(value => findDelegation(parent, value.delegation_id)!.completion))
  await settleParentDelegationRuns(parent)
  expect(budget.snapshot().requests).toBe(2)
  await expect((async () => { for await (const _ of query('continue parent', { env: {}, sessionId: parent, maxTokens: 512, signal: new AbortController().signal })) {} })()).rejects.toThrow('REQUEST_BUDGET_EXHAUSTED')
}, 60000)
it('generic delegation honors two children, rejects model overrides and reacquires scopes on continuation', async () => {
  registerParentLoopContext(parent, { query: async function* () { await new Promise(() => undefined) }, env: {}, maxTokens: 128, maxTurns: 2, delegationMaxTurns: 2,
    permissionMode: 'allow-all', temperature: .1, system: 'main', editFormat: 'diff', runtime: 'pi', maxConcurrentDelegations: 2, allowChannelOverrides: false,
    prepareDelegation: policy.prepare, publish: () => undefined, childToolsBuilder: (id, role) => buildSoftwareAgentTools(id, role, policy) })
  const first = startDelegation(context(), { task: 'one', role: 'implement', writePaths: ['a.txt'] })
  startDelegation(context(), { task: 'two', role: 'review' })
  expect(() => startDelegation(context(), { task: 'third', role: 'review' })).toThrow('2')
  stopDelegations(parent)
  expect(() => policy.assertFileWrite('a.txt', context())).not.toThrow()
  expect(() => startDelegation(context(), { task: 'override', role: 'review', channelId: 'another' })).toThrow('OVERRIDE')
  continueDelegation(context(), first.delegation_id, 'continue bounded changes')
  expect(() => policy.assertFileWrite('a.txt', context())).toThrow('OWNED')
  stopDelegations(parent)
})

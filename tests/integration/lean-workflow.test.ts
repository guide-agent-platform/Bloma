import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ dialog: {} }))
import { registerProjectsIpc } from '../../main/ipc/projects'
import { IPC_CHANNELS, type AgentEvent, type Project, type AgentSendMessageInput } from '../../shared/types'
import { handleGuideMessage } from '../../main/guide/stages/guide-pipeline'
import { findProject } from '../../main/project/project-service'
import { readPrdBackplane } from '../../main/project/prd-store'
import { runCoreVerification } from '../../main/desktop/core-verification'
import { leanBudget } from '../../main/desktop/lean-budget'
import type { SDKQuery, SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-lean-e2e-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
async function publicProject(): Promise<Project> {
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<{ ok: boolean; data: Project }>>()
  registerProjectsIpc({ handle: (name: string, handler: never) => handlers.set(name, handler) } as never, {} as never)
  const result = await handlers.get(IPC_CHANNELS.PROJECT_CREATE)!({}, { request_id: 'create', mode: 'longterm' })
  expect(result.ok).toBe(true)
  expect(result.data.workflow_version).toBe('software-v1')
  return result.data
}
const nativePython = resolve('run-artifacts/workflow-gui-runtime/Scripts/python.exe')
it.each(['cli', ...(process.platform === 'win32' && existsSync(nativePython) ? ['gui'] : [])])('public creation → goal → %s → real Pi writes → actual host behavior/security/startup → delivery; broken behavior fails', async kind => {
  const ui = kind === 'gui', project = await publicProject(), calls: SDKQueryOptions[] = [], events: AgentEvent[] = []
  const expected = ui ? '保存后关闭重开仍能看到记录' : '2加3得到5'
  const requirement = ui ? '保存与重开记录' : '计算加法'
  const query: SDKQuery = async function* (_prompt, options) {
    calls.push(options)
    let content: Array<Record<string, unknown>>
    const index = calls.length
    if (index === 1) content = [{ type: 'text', text: JSON.stringify({ action: 'brief', goal: requirement, ui: ui ? 'required' : 'none', requirements: [{ description: requirement, expected }] }) }]
    else if (ui && index === 2) content = [{ type: 'text', text: '<!DOCTYPE html><html><body><input placeholder="记录"><button>保存</button><ul></ul></body></html>' }]
    else if (ui && index === 3) content = [{ type: 'tool_use', id: 'read-existing', name: 'read_file', input: { path: 'app.py' } }]
    else if (index === (ui ? 4 : 2)) {
      const file = (path: string, text: string) => ({ type: 'tool_use', id: path, name: 'write_file', input: { path, content: text } })
      content = ui ? [
        file('app.py', readFileSync(resolve('tests/fixtures/gui-acceptance/app.py'), 'utf8')),
        file('index.html', readFileSync(resolve('tests/fixtures/gui-acceptance/index.html'), 'utf8')),
        file('bridge.js', readFileSync(resolve('main/templates/skeletons/desktop-python/ui/bridge.js'), 'utf8')),
        file('LAUNCH.json', JSON.stringify({ schema_version: 1, command: [nativePython, 'app.py'], window_title: 'Bloma native GUI acceptance fixture', ui: 'webview' })),
        { type: 'tool_use', id: 'register', name: 'register_gui_check', input: { expectations: { 'F-001': expected }, steps: [
          { id: 'type', kind: 'fill', selector: '#name', value: 'host saved record' }, { id: 'save', kind: 'click', selector: '#save' },
          { id: 'saved', kind: 'expect', selector: '#count', equals: '1' }, { id: 'reopen', kind: 'restart' },
          { id: 'persisted', kind: 'expect', selector: '#items', equals: 'host saved record' },
        ], acceptance_refs: { saved: ['F-001'], persisted: ['F-001'] } } },
      ] : [
        file('app.py', 'import sys\nprint(sum(map(int, sys.argv[1:])) if len(sys.argv)>1 else 5)\n'),
        file('LAUNCH.json', JSON.stringify({ schema_version: 1, command: ['python', 'app.py'], mode: 'command' })),
        { type: 'tool_use', id: 'register', name: 'register_cli_check', input: { expectations: { 'F-001': expected }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] } },
      ]
    } else content = [{ type: 'text', text: '程序已保存，交由宿主验证。' }]
    yield { type: 'assistant', message: { role: 'assistant', content: content as never } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 50, output_tokens: 50 } }
  }
  const input: AgentSendMessageInput = { project_id: project.project_id, session_id: 's', request_id: 'brief', mode: 'longterm', current_stage: 'clarifying', content: requirement }
  const model = { query, env: {}, signal: AbortSignal.timeout(180000), sessionId: 's', history: [], maxTokens: 8192, persistAssistant: vi.fn() }
  const publish = (event: AgentEvent) => events.push(event)
  await handleGuideMessage(input, publish, model)
  const scope = (events.find(e => e.payload.kind === 'lean_scope')!.payload.questions as Array<{ id: string }>)[0].id
  await handleGuideMessage({ ...input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: scope } }, publish, model)
  if (ui) await handleGuideMessage({ ...input, content: '确认草图', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } }, publish, model)
  expect(findProject(project.project_id), JSON.stringify(events.slice(-8))).toMatchObject({ status: 'completed', desktop_phase: 'delivered' })
  expect(calls).toHaveLength(ui ? 5 : 3)
  expect(leanBudget(project.project_id, 'desktop-implement').snapshot().requests).toBe(calls.length)
  expect(existsSync(join(project.root_path, 'CORE_CHECK.json'))).toBe(false)
  const positive = JSON.parse(readFileSync(join(project.root_path, '00_VERIFY/core-verification.json'), 'utf8'))
  const startup = JSON.parse(readFileSync(join(project.root_path, '00_VERIFY/launch-smoke.json'), 'utf8'))
  expect(positive.status).toBe('passed')
  expect(startup.passed).toBe(true)
  if (ui) expect(startup.criteria).toMatchObject({ window_found: true, responsive: true, stable: true, closed_gracefully: true })
  expect(readPrdBackplane(project.project_id).requirements).toHaveLength(1)
  writeFileSync(join(project.root_path, 'app.py'), ui ? 'raise RuntimeError("deliberately broken")\n' : 'print(999)\n')
  const negative = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path, reuse: true, signal: model.signal })
  expect(negative.status).not.toBe('passed')
  writeFileSync(resolve(`run-artifacts/lean-e2e-${kind}.json`), JSON.stringify({ scripted_model: true, paid_requests: 0, requests: calls.length,
    preparation_requests: ui ? 2 : 1, actual_host_positive: positive, actual_normal_startup: startup, broken_product_negative: negative }, null, 2))
}, 210000)

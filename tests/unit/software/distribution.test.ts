import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief, renderLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import { launchSoftwareForUser } from '../../../main/software/user-launch'
import { qualifySoftwareArtifact } from '../../../main/software/artifact-qualification'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-distribution-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it.skipIf(process.platform !== 'win32')('keeps an actually checked local trial but never completes a portable promise without a clean-machine observation', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }), root = project.root_path
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5并能复制给同学直接运行', ui: 'none', delivery: 'command', distribution: 'portable', requirements: [{ description: '输出5', expected: '输出5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '复制给同学直接运行', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  expect(renderLeanBrief(parsed.brief)).toContain('可复制到其他电脑直接使用')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  copyFileSync(process.execPath, join(root, 'program.exe')); writeFileSync(join(root, 'app.cjs'), 'console.log(5)')
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['program.exe', 'app.cjs'], artifact: 'program.exe' }))
  let calls = 0
  const query: SDKQuery = async function* () {
    calls++
    yield { type: 'assistant', message: { role: 'assistant', content: calls === 1 ? [{ type: 'tool_use', id: 'check', name: 'register_cli_check', input: {
      expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] } }] : [{ type: 'text', text: '程序已保留，等待宿主检查。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  const messages: string[] = [], deps: DesktopRouteDeps = { publish: (_input, type, payload) => { if (type === 'message_delta') messages.push(String(payload.text)) }, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} }
  await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '验证并保留试用版本', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, query, {}, deps)
  expect(calls).toBe(2); expect(findProject(project.project_id).status).toBe('active')
  const trial = await activeSoftwareRelease(project.project_id)
  expect(trial).toBeDefined()
  const core = JSON.parse(readFileSync(join(trial!.root, '00_VERIFY/core-verification.json'), 'utf8'))
  expect(core).toMatchObject({ status: 'environment_blocked', local_status: 'passed', distribution: { clean_environment: 'unverified' } })
  expect(messages.join()).toContain('独立交付尚未完成')
  expect(await launchSoftwareForUser(project.project_id, root, trial!.launch, async () => {})).toMatchObject({ started: true, detail: '5' })
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  expect((await qualifySoftwareArtifact(root, parsed.brief)).status).toBe('unverified')
}, 120000)

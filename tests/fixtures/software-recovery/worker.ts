import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProject, findProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { readSoftwareRunState } from '../../../main/software/run-state'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import type { SDKQuery } from '../../../main/orchestration/stages/orchestration-contracts'
import { withEmptyQualityReview } from '../quality-review-query'

export async function main() {
  const home = process.env.SOFTWARE_CRASH_HOME!, phase = process.env.SOFTWARE_CRASH_PHASE!
  process.env.PROMA_HOME = home
  const profile = join(home, `profile-${phase}`); mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); await app.whenReady()
  const identity = join(home, 'identity.json'), sessionId = 'crash-session'
  let project
  if (phase === 'before') {
    project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
    const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '输出5', ui: 'none', delivery: 'command', requirements: [{ description: '输出5', expected: '输出5' }] }),
      { projectId: project.project_id, sessionId, source: '输出5', previous: readPrdBackplane(project.project_id), software: true })!
    if (parsed.action !== 'brief') throw Error('fixture')
    syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: sessionId, checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
    writeFileSync(identity, JSON.stringify({ projectId: project.project_id, root: project.root_path }))
  } else project = findProject(JSON.parse(readFileSync(identity, 'utf8')).projectId)
  let calls = 0, historyRestored = false
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* (_prompt, options) {
    calls++
    if (phase === 'before' && calls === 2) {
      writeFileSync(join(home, 'ready.json'), JSON.stringify({ pid: process.pid, budget: leanBudget(project.project_id, 'desktop-implement').snapshot() }))
      await new Promise(() => {}) // Parent test kills this actual native host.
    }
    if (phase === 'after') historyRestored ||= JSON.stringify(options.messages).includes('setup.cjs')
    yield { type: 'assistant', message: { role: 'assistant', content: phase === 'before' ? [
      use('app', 'write_file', { path: 'app.cjs', content: 'console.log(999)' }),
      use('setup', 'write_file', { path: 'setup.cjs', content: 'require("fs").appendFileSync("side-effect.txt","once\\n")' }),
      use('launch', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }) }),
      use('check', 'register_cli_check', { expectations: { 'F-001': '输出5' }, cases: [{ name: 'five', covers: ['F-001'], args: [], stdout: '5', exit_code: 0 }] }),
      use('effect', 'run_command', { command: ['node', 'setup.cjs'] }),
      use('service-file', 'write_file', { path: 'service.cjs', content: `require('http').createServer((q,s)=>s.end('owned-child')).listen(${Number(process.env.SOFTWARE_CRASH_PORT)},'127.0.0.1')` }),
      use('service', 'start_service', { command: ['node', 'service.cjs'], url: `http://127.0.0.1:${process.env.SOFTWARE_CRASH_PORT}` }),
    ] : calls === 2 ? [use('read-bug', 'read_file', { path: 'app.cjs' }), use('repair-bug', 'edit_file', { path: 'app.cjs', old_string: 'console.log(999)', new_string: 'console.log(5)' })]
      : [{ type: 'text', text: '交由宿主按当前文件实际验证。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 10 } }
  }
  await enterDesktopLine({ projectId: project.project_id, sessionId, requestId: phase, content: phase === 'before' ? '实现输出5' : '继续原任务', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {},
    { publish: () => {}, persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} })
  const release = await activeSoftwareRelease(project.project_id)
  writeFileSync(join(home, 'resumed.json'), JSON.stringify({ pid: process.pid, project: findProject(project.project_id), historyRestored, calls,
    budget: leanBudget(project.project_id, 'desktop-implement').snapshot(), checkpoint: readSoftwareRunState(project.project_id),
    core: release && existsSync(join(release.root, '00_VERIFY/core-verification.json')) ? JSON.parse(readFileSync(join(release.root, '00_VERIFY/core-verification.json'), 'utf8')) : null }))
}

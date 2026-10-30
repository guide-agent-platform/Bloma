import { withEmptyQualityReview } from '../../fixtures/quality-review-query'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { enterDesktopLine, isDesktopLineActive, type DesktopRouteDeps } from '../../../main/desktop/desktop-route'
import type { SDKQuery, SDKQueryOptions } from '../../../main/orchestration/stages/orchestration-contracts'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import { launchSoftwareForUser } from '../../../main/software/user-launch'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-loop-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it.each(['quick', 'longterm'] as const)('real Pi software loop writes JS, builds with bundled npm, host verifies and delivers for %s', async mode => {
  const project = createProject({ request_id: 'c', mode }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '计算加法', ui: 'none', delivery: 'command', requirements: [{ description: '计算加法', expected: '2加3得5' }] }),
    { projectId: project.project_id, sessionId: 's', source: '计算加法', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const calls: SDKQueryOptions[] = [], events: Array<{ type: string; payload: Record<string, unknown> }> = []
  const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
  const query: SDKQuery = async function* (_prompt, options) {
    calls.push(options)
    yield { type: 'assistant', message: { role: 'assistant', content: calls.length === 1 ? [
      use('package', 'write_file', { path: 'package.json', content: JSON.stringify({ name: 'real-software-loop', scripts: { build: 'node build.cjs' } }) }),
      use('source', 'write_file', { path: 'app.cjs', content: 'console.log(process.argv.length>2?Number(process.argv[2])+Number(process.argv[3]):5)' }),
      use('builder', 'write_file', { path: 'build.cjs', content: 'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.copyFileSync("app.cjs","dist/app.cjs");console.log("built real source")' }),
      use('build', 'run_command', { command: ['npm', 'run', 'build'] }),
      use('launch', 'write_file', { path: 'LAUNCH.json', content: JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'dist/app.cjs'] }) }),
      use('check', 'register_cli_check', { expectations: { 'F-001': '2加3得5' }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] }),
    ] : [{ type: 'text', text: '程序已实现，等待宿主检查。' }] } }
    yield { type: 'result', subtype: 'success', usage: { input_tokens: 10, output_tokens: 20 } }
  }
  const deps: DesktopRouteDeps = { publish: (_target, type, payload) => events.push({ type, payload }), persistAssistant: () => {}, persistSystem: () => {}, complete: () => {} }
  expect(await enterDesktopLine({ projectId: project.project_id, sessionId: 's', requestId: 'r', content: '直接实现', maxTokens: 4096, signal: AbortSignal.timeout(90000) }, withEmptyQualityReview(query), {}, deps)).toBe(true)
  if(mode==='longterm'){
    expect(findProject(project.project_id)).toMatchObject({status:'active',current_stage:'blocked_for_user_decision',longterm_summary:{status:'awaiting_confirmation'}})
    expect(await activeSoftwareRelease(project.project_id)).toBeUndefined()
    expect(events.some(event=>event.type==='user_decision_required'&&event.payload.kind==='longterm_milestone')).toBe(true)
    await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'user-confirm',content:'确认本阶段',maxTokens:4096,signal:AbortSignal.timeout(90000)},withEmptyQualityReview(query),{},deps)
  }
  expect(findProject(project.project_id)).toMatchObject({ status: 'completed', desktop_phase: 'delivered' })
  expect(readFileSync(join(project.root_path, 'dist/app.cjs'), 'utf8')).toContain('console.log')
  expect(existsSync(join(project.root_path, 'app.py'))).toBe(false)
  expect(calls).toHaveLength(2)
  expect(JSON.stringify(calls[0].messages)).not.toContain('schema_version\\":1,\\"command\\":[\\"python\\"')
  expect(events.some(event => event.type === 'stage_changed' && event.payload.stage === 'delivered')).toBe(true)
  expect(isDesktopLineActive({ ...findProject(project.project_id), desktop_phase: undefined })).toBe(true)
  const released = await activeSoftwareRelease(project.project_id)
  expect(released?.verified).toBeDefined(); expect(released?.root).not.toBe(project.root_path)
  expect(JSON.parse(readFileSync(join(released!.root, '00_VERIFY/core-verification.json'), 'utf8')).status).toBe('passed')
  writeFileSync(join(project.root_path, 'dist/app.cjs'), 'console.log("unverified working version")')
  expect(await launchSoftwareForUser(project.project_id, project.root_path, released!.launch, async () => {})).toMatchObject({ started: true, detail: '5' })
}, 120000)
it('confirmed desktop delivery cannot silently use a browser launch declaration', async () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '桌面记事', ui: 'required', delivery: 'desktop', requirements: [{ description: '保存文字', expected: '重开保留' }] }),
    { projectId: project.project_id, sessionId: 's', source: '桌面记事', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  const { writeFileSync } = await import('node:fs')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: ['node', 'server.cjs'], ui: 'browser', url: 'http://127.0.0.1:45679' }))
  const result = await runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path })
  expect(result.status).not.toBe('passed'); expect(result.missing.join()).toContain('DELIVERY_TARGET_MISMATCH')
})

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runSecurityScan } from '../../../main/verification/security-scan'
import { createProject } from '../../../main/project/project-service'
import { defaultQuickSecurityGate } from '../../../main/desktop/desktop-route'

let home: string, old: string | undefined
beforeEach(() => { old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-policy-')); process.env.PROMA_HOME = home })
afterEach(() => { if (old === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = old; rmSync(home, { recursive: true, force: true }) })
it('allows ordinary native tools and HTTPS in software while retaining historical web policy', () => {
  writeFileSync(join(home, 'server.js'), `const {spawn}=require('child_process');
function handle(req){const url=new URL(req.url,'http://127.0.0.1');return url.pathname}
function start(){const url='http://127.0.0.1:4173';spawn('cmd',['/c','start','',url],{detached:true})}
spawn('ffmpeg',['-version'],{shell:false});fetch('https://example.com/api');`)
  expect(runSecurityScan({ project_id: 'p', root_path: home }).passed).toBe(false)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' })).toMatchObject({ passed: true })
})
it.each([
  `const {exec:run}=require('node:child_process');function handle(req){run(req.body.command)}`,
  `import * as cp from 'node:child_process';function handle(request){const command=request.query.code;cp.execSync(command)}`,
  `const{spawn}=require('child_process');function handle(req){spawn('bash',['-c',req.body.command])}`,
  `const{spawn}=require('child_process');function handle(req){spawn('echo',[req.body.text],{shell:true})}`,
  `const cp=require('child_process');const run=cp.exec;function handle(req){run(req.body.command)}`,
  `const{exec}=require('child_process');function handle(req){let command='echo ok';command=req.body.command;exec(command)}`,
])('blocks dynamic shell input in any software source location', source => {
  writeFileSync(join(home, 'backend.cjs'), source)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' })).toMatchObject({ passed: false, issues: [{ category: 'dangerous_execution', severity: 'critical' }] })
})
it('does not confuse RegExp.exec or a scoped local constant with a process call/input', () => {
  writeFileSync(join(home, 'logic.js'), `import{exec as run}from'node:child_process';const expression=/foo/;expression.exec(userInput);function local(){const input='echo ok';run(input)}`)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' }).passed).toBe(true)
})
it('checks actual dynamic execution syntax rather than quoted test inputs or comments', () => {
  writeFileSync(join(home, 'logic.js'), `const example="eval(req.body.code)"; // new Function(userInput)
const constant=new Function('return 1');constant();`)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' }).passed).toBe(true)
  writeFileSync(join(home, 'logic.js'), `function handle(req){return eval(req.body.code)}`)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' }).passed).toBe(false)
  writeFileSync(join(home, 'logic.js'), `function handle(req){return globalThis.eval(req.body.code)}`)
  expect(runSecurityScan({ project_id: 'p', root_path: home, profile: 'local-software' }).passed).toBe(false)
})
it('selects software policy from host project metadata and scans the actual candidate', () => {
  const project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' })
  writeFileSync(join(project.root_path, 'server.js'), `const{spawn}=require('child_process');spawn('node',['--version'])`)
  expect(defaultQuickSecurityGate(project.project_id)?.passed).toBe(true)
  writeFileSync(join(home, 'danger.cjs'), `const{exec}=require('child_process');exec(userInput)`)
  expect(defaultQuickSecurityGate(project.project_id, home)?.passed).toBe(false)
})

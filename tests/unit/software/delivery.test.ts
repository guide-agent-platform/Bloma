import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { exportProjectHandoff } from '../../../main/delivery/project-export'
import { launchSoftwareForUser } from '../../../main/software/user-launch'
import { runHostLlmProbe } from '../../../main/desktop/llm-verification'
import { stopSoftwareSession } from '../../../main/software/process-manager'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-delivery-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(async () => { await stopSoftwareSession(project.project_id, 'user-launch'); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('source export preserves built assets and declared packaged dependencies without inventing a legacy architecture', () => {
  const root = project.root_path
  for (const directory of ['dist/assets', 'release/resources/app/node_modules/runtime', 'node_modules/dev', '.venv']) mkdirSync(join(root, directory), { recursive: true })
  for (const file of ['dist/index.html', 'dist/assets/built.js', 'release/app.exe', 'release/resources/app/node_modules/runtime/index.js', 'node_modules/dev/index.js', '.venv/pyvenv.cfg']) writeFileSync(join(root, file), 'actual output')
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, command: ['release/app.exe'], artifact: 'release/app.exe', window_title: 'App', ui: 'electron' }))
  const exported = exportProjectHandoff({ request_id: 'e', project_id: project.project_id }, join(home, 'exports')).destination!
  expect(existsSync(join(exported, 'dist/assets/built.js'))).toBe(true)
  expect(existsSync(join(exported, 'release/resources/app/node_modules/runtime/index.js'))).toBe(true)
  expect(existsSync(join(exported, 'node_modules'))).toBe(false)
  expect(existsSync(join(exported, '.venv'))).toBe(false)
  const readme = readFileSync(join(exported, 'README.md'), 'utf8')
  expect(readme).not.toContain('static-server.js'); expect(readme).not.toContain('express'); expect(readme).toContain('不等于独立安装包')
})
it('normal one-click command uses persistent user data distinct from verification and reports real output/errors', async () => {
  writeFileSync(join(project.root_path, 'app.cjs'), 'const fs=require("fs"),p=require("path").join(process.env.APP_DATA_DIR,"saved");console.log(fs.existsSync(p)?fs.readFileSync(p,"utf8"):"first");fs.writeFileSync(p,"persisted")')
  const launch = { schema_version: 2 as const, mode: 'command' as const, command: ['node', 'app.cjs'] }
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify(launch))
  expect(await launchSoftwareForUser(project.project_id, project.root_path, launch, async () => {})).toMatchObject({ started: true, detail: 'first' })
  expect(await launchSoftwareForUser(project.project_id, project.root_path, launch, async () => {})).toMatchObject({ started: true, detail: 'persisted' })
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ ...launch, command: ['node', 'missing.cjs'] }))
  expect(await launchSoftwareForUser(project.project_id, project.root_path, { ...launch, command: ['node', 'missing.cjs'] }, async () => {})).toMatchObject({ started: false })
})
it('Node AI entry makes five actual owned HTTP requests and rejects a fixed network-error implementation', async () => {
  writeFileSync(join(project.root_path, 'client.cjs'), `exports.Client=class Client { async enhance({prompt,config:c}) {
    if(!c.api_key)return {ok:false,kind:'unconfigured'};
    try { const r=await fetch(c.endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+c.api_key,'Content-Type':'application/json'},body:JSON.stringify({model:c.model,messages:[{role:'user',content:prompt}]})});
      if(!r.ok)return {ok:false,kind:({401:'auth_error',404:'model_error',429:'rate_limited'})[r.status]||'network_error'};
      const data=await r.json(),text=data.choices?.[0]?.message?.content;
      return typeof text==='string'?{ok:true,kind:'success',text}:{ok:false,kind:'invalid_response'};
    }catch{return {ok:false,kind:'network_error'}} } }`)
  const spec = { runtime: 'node' as const, module: 'client.cjs', factory: 'Client', method: 'enhance', covers: ['F-001'] }
  const result = await runHostLlmProbe(project.root_path, spec)
  expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed', request_count: 5 })
  writeFileSync(join(project.root_path, 'client.cjs'), 'exports.Client=class {enhance(){return {ok:false,kind:"network_error"}}}')
  expect((await runHostLlmProbe(project.root_path, spec)).status).toBe('failed')
}, 45000)
it('running user apps survive Agent cleanup, updated versions require explicit restart and back up durable data', async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve)); const address = probe.address()
  if (!address || typeof address === 'string') throw Error('port'); await new Promise<void>(resolve => probe.close(() => resolve()))
  const source = (version: string) => `const fs=require('fs'),path=require('path'),data=path.join(process.env.APP_DATA_DIR,'record.txt');if(!fs.existsSync(data))fs.writeFileSync(data,'user record');require('http').createServer((q,s)=>s.end('${version}')).listen(${address.port},'127.0.0.1')`
  writeFileSync(join(project.root_path, 'server.cjs'), source('v1'))
  const launch = { schema_version: 2 as const, ui: 'browser' as const, url: `http://127.0.0.1:${address.port}`, command: ['node', 'server.cjs'] }
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify(launch))
  const opened: string[] = [], open = async (url: string) => { opened.push(url) }
  expect((await launchSoftwareForUser(project.project_id, project.root_path, launch, open)).started).toBe(true)
  await stopSoftwareSession(project.project_id, 'some-agent-session')
  expect(await (await fetch(launch.url)).text()).toBe('v1')
  writeFileSync(join(project.root_path, 'server.cjs'), source('v2'))
  expect(await launchSoftwareForUser(project.project_id, project.root_path, launch, open)).toMatchObject({ started: false, needs_restart: true })
  expect(await (await fetch(launch.url)).text()).toBe('v1')
  expect((await launchSoftwareForUser(project.project_id, project.root_path, launch, open, true)).started).toBe(true)
  expect(await (await fetch(launch.url)).text()).toBe('v2')
  const backups = join(home, 'software-app-data', project.project_id, 'backups'), first = readdirSync(backups)[0]
  expect(readFileSync(join(backups, first, 'data', 'record.txt'), 'utf8')).toBe('user record')
  expect(opened).toHaveLength(2)
}, 45000)

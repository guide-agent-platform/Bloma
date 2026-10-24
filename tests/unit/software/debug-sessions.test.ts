import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { buildSoftwareInspectTool } from '../../../main/software/inspect-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { closeDebugSessions, readDebugSession } from '../../../main/software/debug-sessions'
import { createToolState, type ToolContext } from '../../../main/agent/loop/agent-loop'
import { startSoftwareProcess, stopSoftwareSession } from '../../../main/software/process-manager'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
const electron = resolve('node_modules/electron/dist/electron.exe')
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-debug-test-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(async () => { await closeDebugSessions(project.project_id, 's'); await stopSoftwareSession(project.project_id, 's');
  if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 }) }, 30000)
const ctx = (signal = new AbortController().signal): ToolContext => ({ projectId: project.project_id, sessionId: 's', requestId: 'r', signal, state: createToolState() })
async function freePort() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const a = server.address(); if (!a || typeof a === 'string') throw Error('port'); await new Promise<void>(done => server.close(() => done())); return a.port }
const html = `<!doctype html><title>Debug fixture</title><h1>Debug fixture</h1><button id="inc">Increment</button><button id="crash">Error</button><div id="count"></div><div id="version"></div><script>
const client=window.api||{count:()=>fetch('/count').then(r=>r.text()),inc:()=>fetch('/count',{method:'POST'}),version:()=>fetch('/version').then(r=>r.text())};async function refresh(){document.querySelector('#count').textContent=await client.count();document.querySelector('#version').textContent=await client.version()}document.querySelector('#inc').onclick=async()=>{await client.inc();await refresh()};document.querySelector('#crash').onclick=()=>{console.error('Authorization: Bearer PRIVATE_BEARER');console.log('api_key=PRIVATE_KEY token=PRIVATE_TOKEN');fetch('/fail?token=QUERY_SECRET').catch(()=>{});setTimeout(()=>{throw Error('real-renderer-bug')},0)};refresh()</script><input id="file" type="file"><pre id="file-text"></pre><script>document.querySelector('#file').onchange=async e=>document.querySelector('#file-text').textContent=await e.target.files[0].text()</script>`
const serverSource = (version: string) => `const fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'count');require('http').createServer((q,s)=>{if(q.url==='/count'){if(q.method==='POST')fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file):0)+1));s.end(fs.existsSync(file)?fs.readFileSync(file):'0')}else if(q.url==='/version')s.end('${version}');else if(q.url.startsWith('/fail')){s.writeHead(500);s.end('deliberate error')}else{s.setHeader('Content-Type','text/html');s.end(fs.readFileSync('index.html'))}}).listen(Number(process.argv[2]),'127.0.0.1')`
const mainSource = (version: string) => `const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'count');ipcMain.handle('count',()=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):'0');ipcMain.handle('inc',()=>fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file):0)+1)));ipcMain.handle('version',()=>'${version}');app.whenReady().then(()=>new BrowserWindow({webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}}).loadFile('index.html'));app.on('window-all-closed',()=>app.quit())`
it.skipIf(process.platform !== 'win32' || !existsSync(electron)).each(['electron', 'browser'] as const)('keeps real %s state across calls, observes errors, restarts changed backend with retained data, and cleans up', async ui => {
  const root = project.root_path, p = await freePort(), url = `http://127.0.0.1:${p}`, abort = new AbortController(), context = ctx(abort.signal)
  writeFileSync(join(root, 'index.html'), html)
  if (ui === 'electron') {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'main.cjs', name: 'debug-fixture' })); writeFileSync(join(root, 'main.cjs'), mainSource('v1'))
    writeFileSync(join(root, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{count:()=>ipcRenderer.invoke('count'),inc:()=>ipcRenderer.invoke('inc'),version:()=>ipcRenderer.invoke('version')})`)
    writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui, command: [electron, '.'], window_title: 'Debug fixture' }))
  } else { writeFileSync(join(root, 'server.cjs'), serverSource('v1')); writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui, command: ['node', 'server.cjs', String(p)], url })) }
  const policy = createSoftwareCollaborationPolicy(project.project_id, root, 's'), tool = buildSoftwareInspectTool(project.project_id, policy)
  const check = (id: string, selector: string, equals: string) => ({ id, kind: 'expect', selector, equals })
  writeFileSync(join(root, 'sample.txt'), 'frozen persistent fixture')
  const opened = await tool.execute({ mode: 'open', fixtures: [{ path: 'input/sample.txt', source: 'sample.txt' }], steps: [check('initial', '#count', '0'), check('version', '#version', 'v1')] }, context)
  expect(opened.isError, opened.output).not.toBe(true); const id = JSON.parse(opened.output).debug_session_id
  writeFileSync(join(root, 'sample.txt'), 'changed source must not replace frozen bytes')
  // Source edits require reload; the registered input remains the frozen copy.
  const uploaded = await tool.execute({ mode: 'reload', debug_session_id: id, fixtures: [{ path: 'input/extra.txt', text: 'additional input' }], steps: [{ id: 'upload', kind: 'upload', selector: '#file', path: 'input/sample.txt' }, check('imported', '#file-text', 'frozen persistent fixture')] }, context)
  expect(uploaded.isError, uploaded.output).not.toBe(true)
  expect(() => readDebugSession('foreign', 's', id)).toThrow('NOT_OWNED')
  expect(() => policy.prepare({ parent: context, args: { task: 'parallel writer', role: 'implement', writePaths: ['a.txt'] }, childSessionId: 'child', delegationId: 'd' })).toThrow('STOP_DEV_SERVICE')
  const clicked = await tool.execute({ mode: 'act', debug_session_id: id, steps: [{ id: 'inc', kind: 'click', selector: '#inc' }] }, context)
  expect(clicked.isError, clicked.output).not.toBe(true)
  const retained = await tool.execute({ mode: 'act', debug_session_id: id, steps: [check('retained', '#count', '1')] }, context)
  expect(retained.isError, retained.output).not.toBe(true)
  await tool.execute({ mode: 'act', debug_session_id: id, steps: [{ id: 'trigger', kind: 'click', selector: '#crash' }] }, context)
  await expect.poll(() => readDebugSession(project.project_id, 's', id).observations.some(row => row.message.includes('real-renderer-bug'))).toBe(true)
  const logs = JSON.stringify(readDebugSession(project.project_id, 's', id)); expect(logs).not.toMatch(/PRIVATE_BEARER|PRIVATE_KEY|PRIVATE_TOKEN|QUERY_SECRET/)
  if (ui === 'browser') expect(logs).toContain('HTTP 500')
  writeFileSync(join(root, ui === 'electron' ? 'main.cjs' : 'server.cjs'), ui === 'electron' ? mainSource('v2') : serverSource('v2'))
  expect(JSON.parse((await tool.execute({ mode: 'read', debug_session_id: id }, context)).output).stale).toBe(true)
  expect((await tool.execute({ mode: 'act', debug_session_id: id, steps: [check('stale', '#version', 'v1')] }, context)).isError).toBe(true)
  const reloaded = await tool.execute({ mode: 'reload', debug_session_id: id, steps: [check('new-backend', '#version', 'v2'), check('data', '#count', '1')] }, context)
  expect(reloaded.isError, reloaded.output).not.toBe(true); expect(JSON.parse(reloaded.output)).toMatchObject({ version: 3, stale: false })
  abort.abort(); await closeDebugSessions(project.project_id, 's')
  expect(readDebugSession(project.project_id, 's', id).state).toBe('closed')
  if (ui === 'browser') await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
}, 150000)
it('attaches only an owned ready browser service and never kills the borrowed service on debug close', async () => {
  const p = await freePort(), url = `http://127.0.0.1:${p}`, root = project.root_path, context = ctx()
  writeFileSync(join(root, 'index.html'), html); writeFileSync(join(root, 'server.cjs'), serverSource('v1'))
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(p)], url }))
  const service = await startSoftwareProcess({ projectId: project.project_id, sessionId: 's', root, command: ['node', 'server.cjs', String(p)], url, signal: context.signal })
  const tool = buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's'))
  const opened = await tool.execute({ mode: 'open', process_id: service.id }, context)
  expect(opened.isError, opened.output).not.toBe(true)
  await tool.execute({ mode: 'close', debug_session_id: JSON.parse(opened.output).debug_session_id }, context)
  expect(await (await fetch(`${url}/version`)).text()).toBe('v1')
}, 90000)

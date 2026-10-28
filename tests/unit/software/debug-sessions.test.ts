import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { debugWorkspace } from '../../../main/software/debug-workspace'
import { buildSoftwareInspectTool } from '../../../main/software/inspect-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { closeDebugSessions, readDebugSession, retainedDebugVersion } from '../../../main/software/debug-sessions'
import { softwareVerificationFingerprint } from '../../../main/desktop/verification-fingerprint'
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
const html = `<!doctype html><meta charset="utf-8"><title>Debug fixture</title><h1>Debug fixture</h1><input id="draft"><select id="flavor" onchange="document.querySelector('#flavor-value').textContent=this.value"><option value="a">甲</option><option value="b">乙</option></select><output id="flavor-value"></output><button id="download" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['native download']));a.download='native.txt';a.click()">Export</button><script>draft.value=localStorage.getItem('draft')||'';draft.oninput=()=>localStorage.setItem('draft',draft.value)</script><button id="inc">Increment</button><button id="crash">Error</button><button id="slow" onclick="fetch('/slow?token=PRIVATE_QUERY').catch(()=>{})">Slow request</button><div id="count"></div><div id="version"></div><script>
const client=window.api||{count:()=>fetch('/count').then(r=>r.text()),inc:()=>fetch('/count',{method:'POST'}),version:()=>fetch('/version').then(r=>r.text())};async function refresh(){document.querySelector('#count').textContent=await client.count();document.querySelector('#version').textContent=await client.version()}document.querySelector('#inc').onclick=async()=>{await client.inc();await refresh()};document.querySelector('#crash').onclick=()=>{console.error('Authorization: Bearer PRIVATE_BEARER');console.log('api_key=PRIVATE_KEY token=PRIVATE_TOKEN');fetch('/fail?token=QUERY_SECRET').catch(()=>{});setTimeout(()=>{throw Error('real-renderer-bug')},0)};refresh()</script><input id="file" type="file"><pre id="file-text"></pre><script>document.querySelector('#file').onchange=async e=>document.querySelector('#file-text').textContent=await e.target.files[0].text()</script>`
const serverSource = (version: string) => `const fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'count');require('http').createServer((q,s)=>{if(q.url==='/count'){if(q.method==='POST')fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file):0)+1));s.end(fs.existsSync(file)?fs.readFileSync(file):'0')}else if(q.url==='/version')s.end('${version}');else if(q.url.startsWith('/fail')){setTimeout(()=>{s.writeHead(500);s.end('deliberate error')},125)}else if(q.url.startsWith('/slow'))setTimeout(()=>s.end('slow actual response'),1100);else{s.setHeader('Content-Type','text/html');s.end(fs.readFileSync('index.html'))}}).listen(Number(process.argv[2]),'127.0.0.1')`
const mainSource = (version: string) => `const{app,BrowserWindow,ipcMain}=require('electron'),fs=require('fs'),path=require('path'),file=path.join(process.env.APP_DATA_DIR,'count');ipcMain.handle('count',()=>fs.existsSync(file)?fs.readFileSync(file,'utf8'):'0');ipcMain.handle('inc',()=>fs.writeFileSync(file,String(Number(fs.existsSync(file)?fs.readFileSync(file):0)+1)));ipcMain.handle('version',()=>'${version}');app.whenReady().then(()=>{const window=new BrowserWindow({webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});window.webContents.setWindowOpenHandler(()=>({action:'allow',overrideBrowserWindowOptions:{webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}}}));window.loadFile('index.html')});app.on('window-all-closed',()=>app.quit())`
it.skipIf(process.platform !== 'win32' || !existsSync(electron))('reports the real Electron backend port conflict and owned process exit instead of a generic page timeout', async () => {
  const root = project.root_path, occupied = createServer()
  await new Promise<void>(done => occupied.listen(0, '127.0.0.1', done))
  const address = occupied.address(); if (!address || typeof address === 'string') throw Error('port')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'no-window-fixture', main: 'main.cjs' }))
  writeFileSync(join(root, 'main.cjs'), `const{app}=require('electron');app.whenReady().then(()=>{const s=require('net').createServer();s.on('error',e=>{console.error(e.code+' api_key=PRIVATE_STARTUP_KEY');setTimeout(()=>app.exit(9),1500)});s.listen(${address.port},'127.0.0.1')})`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'electron', command: [electron, '.'], window_title: 'No window expected' }))
  const tool = buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's'))
  try {
    const result = await tool.execute({ mode: 'open' }, ctx())
    expect(result.isError).toBe(true); expect(result.output).toContain('APP_PORT_IN_USE')
    expect(result.output).toContain('process_id'); expect(result.output).toContain('exit_code')
    expect(result.output).not.toContain('PRIVATE_STARTUP_KEY'); expect(result.output).not.toContain('waiting for event "page"')
  } finally { await new Promise<void>(done => occupied.close(() => done())) }
}, 45000)
it.skipIf(process.platform !== 'win32' || !existsSync(electron)).each(['electron', 'browser'] as const)('keeps real %s state across calls, observes errors, restarts changed backend with retained data, and cleans up', async ui => {
  const root = project.root_path, p = await freePort(), url = `http://127.0.0.1:${p}`, abort = new AbortController(), context = ctx(abort.signal)
  writeFileSync(join(root, 'index.html'), html)
  if (ui === 'electron') {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ main: 'main.cjs', name: 'debug-fixture' })); writeFileSync(join(root, 'main.cjs'), mainSource('v1'))
    writeFileSync(join(root, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{count:()=>ipcRenderer.invoke('count'),inc:()=>ipcRenderer.invoke('inc'),version:()=>ipcRenderer.invoke('version')})`)
    writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui, command: [electron, '.'], window_title: 'Debug fixture' }))
  } else { writeFileSync(join(root, 'server.cjs'), serverSource('v1')); writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui, command: ['node', 'server.cjs', String(p)], url })) }
  const policy = createSoftwareCollaborationPolicy(project.project_id, root, 's'), tool = buildSoftwareInspectTool(project.project_id, policy)
  writeFileSync(join(root, 'browser-check.mjs'), `import{readFileSync}from'node:fs';import{join}from'node:path';export default async({page,expect,assert,dataDir})=>{
    assert.equal(Boolean(process.env.ANTHROPIC_AUTH_TOKEN),false);assert.equal(Boolean(process.env.OPENAI_API_KEY),false);
    await page.locator('#flavor').selectOption({label:'乙'});await expect(page.locator('#flavor-value')).toHaveText('b');
    const done=page.waitForEvent('download');await page.locator('#download').click();const file=await done;await file.saveAs(join(dataDir,'native-export.txt'));assert.equal(readFileSync(join(dataDir,'native-export.txt'),'utf8'),'native download');return{native:true};}`)
  writeFileSync(join(root, 'browser-failure.mjs'), `export default async({page,expect})=>{await expect(page.locator('h1')).toHaveText('deliberately wrong',{timeout:250})}`)
  writeFileSync(join(root, 'browser-timeout.mjs'), 'export default async()=>{while(true){}}')
  writeFileSync(join(root,'browser-duplicate.mjs'),'export default async({page,context,assert})=>{const created=context.waitForEvent("page");await page.evaluate(()=>window.open(location.href,"duplicate"));const duplicate=await created;await duplicate.waitForLoadState();assert.equal(await page.locator("#flavor").inputValue(),"b");return true}')
  writeFileSync(join(root,'browser-bound-page.mjs'),'export default async({page,assert})=>{assert.equal(await page.locator("#flavor").inputValue(),"b");return true}')
  const check = (id: string, selector: string, equals: string) => ({ id, kind: 'expect', selector, equals })
  writeFileSync(join(root, 'sample.txt'), 'frozen persistent fixture')
  const opened = await tool.execute({ mode: 'open', fixtures: [{ path: 'input/sample.txt', source: 'sample.txt' }], steps: [check('initial', '#count', '0'), check('version', '#version', 'v1')] }, context)
  expect(opened.isError, opened.output).not.toBe(true); const id = JSON.parse(opened.output).debug_session_id
  expect(JSON.parse(opened.output).verification_readiness.verification).toBe('not_run')
  const scripted = await tool.execute({ script: 'browser-check.mjs' }, context)
  expect(scripted.isError, scripted.output).not.toBe(true)
  expect(JSON.parse(scripted.output).steps[0]).toMatchObject({ id: 'browser-script', passed: true })
  const duplicate=await tool.execute({script:'browser-duplicate.mjs'},context);expect(duplicate.isError,duplicate.output).not.toBe(true)
  const bound=await tool.execute({script:'browser-bound-page.mjs'},context);expect(bound.isError,bound.output).not.toBe(true)
  const scriptFailed = await tool.execute({ script: 'browser-failure.mjs' }, context)
  expect(scriptFailed.isError).toBe(true); expect(scriptFailed.output).toContain('deliberately wrong')
  const timedOut = await tool.execute({ script: 'browser-timeout.mjs', timeout_ms: 500 }, context)
  expect(timedOut.isError).toBe(true)
  const afterScript = await tool.execute({ steps: [{ id: 'selected-after-script', kind: 'expect', property: 'value', selector: '#flavor', equals: 'b' }] }, context)
  expect(afterScript.isError, afterScript.output).not.toBe(true)
  expect(JSON.parse(opened.output).ui.controls.some((control: { selector: string }) => control.selector === '#inc')).toBe(true)
  writeFileSync(join(root, 'sample.txt'), 'changed source must not replace frozen bytes')
  // Source edits require reload; the registered input remains the frozen copy.
  const uploaded = await tool.execute({ mode: 'reload', debug_session_id: id, fixtures: [{ path: 'input/extra.txt', text: 'additional input' }], steps: [{ id: 'upload', kind: 'upload', selector: '#file', path: 'input/sample.txt' }, check('imported', '#file-text', 'frozen persistent fixture')] }, context)
  expect(uploaded.isError, uploaded.output).not.toBe(true)
  expect(() => readDebugSession('foreign', 's', id)).toThrow('NOT_OWNED')
  expect(() => policy.prepare({ parent: context, args: { task: 'parallel writer', role: 'implement', writePaths: ['a.txt'] }, childSessionId: 'child', delegationId: 'd' })).toThrow('STOP_DEV_SERVICE')
  const clicked = await tool.execute({ mode: 'act', debug_session_id: id, steps: [{ id: 'inc', kind: 'click', selector: '#inc' }] }, context)
  expect(clicked.isError, clicked.output).not.toBe(true)
  expect(JSON.parse(clicked.output).observations.some((row: { kind: string }) => row.kind === 'backend.stdout')).toBe(false)
  const retained = await tool.execute({ mode: 'act', debug_session_id: id, steps: [check('retained', '#count', '1')] }, context)
  expect(retained.isError, retained.output).not.toBe(true)
  const automatic = await tool.execute({ steps: [check('automatic-state', '#count', '1')] }, context)
  expect(automatic.isError, automatic.output).not.toBe(true); expect(JSON.parse(automatic.output).debug_session_id).toBe(id)
  const restarted = await tool.execute({ steps: [{ id: 'restart', kind: 'restart' }, check('after-restart', '#count', '1')] }, context)
  expect(restarted.isError, restarted.output).not.toBe(true); expect(JSON.parse(restarted.output).version).toBe(3)
  await tool.execute({ mode: 'act', debug_session_id: id, steps: [{ id: 'trigger', kind: 'click', selector: '#crash' }] }, context)
  await expect.poll(() => readDebugSession(project.project_id, 's', id).observations.some(row => row.message.includes('real-renderer-bug'))).toBe(true)
  const logs = JSON.stringify(readDebugSession(project.project_id, 's', id)); expect(logs).not.toMatch(/PRIVATE_BEARER|PRIVATE_KEY|PRIVATE_TOKEN|QUERY_SECRET/)
  if (ui === 'browser') {
    await expect.poll(() => readDebugSession(project.project_id, 's', id).observations.find(row => row.kind === 'network.error' && row.url === `${url}/fail`)?.duration_ms).toBeGreaterThanOrEqual(100)
    expect(readDebugSession(project.project_id, 's', id).observations.find(row => row.kind === 'network.error' && row.url === `${url}/fail`)).toMatchObject({ action: 'trigger', version: 3, method: 'GET', status: 500, url: `${url}/fail` })
    await tool.execute({ mode: 'act', debug_session_id: id, steps: [{ id: 'slow-request', kind: 'click', selector: '#slow' }] }, context)
    await expect.poll(() => readDebugSession(project.project_id, 's', id).observations.find(row => row.kind === 'network.slow' && row.url === `${url}/slow`)?.duration_ms, { timeout: 5000 }).toBeGreaterThanOrEqual(1000)
    expect(readDebugSession(project.project_id, 's', id).observations.find(row => row.kind === 'network.slow' && row.url === `${url}/slow`)).toMatchObject({ action: 'slow-request', version: 3, status: 200, url: `${url}/slow` })
    expect(JSON.stringify(readDebugSession(project.project_id, 's', id))).not.toContain('PRIVATE_QUERY')
  }
  writeFileSync(join(root, ui === 'electron' ? 'main.cjs' : 'server.cjs'), ui === 'electron' ? mainSource('v2') : serverSource('v2'))
  expect(JSON.parse((await tool.execute({ mode: 'read', debug_session_id: id }, context)).output).stale).toBe(true)
  expect(retainedDebugVersion(project.project_id, 's')?.source).not.toBe(softwareVerificationFingerprint(root))
  // An explicit act from a persisted transcript has the same automatic reload
  // semantics as an omitted mode; it must observe the new backend, never v1.
  const reloaded = await tool.execute({ mode: 'act', debug_session_id: id, steps: [check('new-backend', '#version', 'v2'), check('data', '#count', '1')] }, context)
  expect(reloaded.isError, reloaded.output).not.toBe(true); expect(JSON.parse(reloaded.output)).toMatchObject({ version: 4, stale: false })
  expect(retainedDebugVersion(project.project_id, 's')).toEqual({ source: softwareVerificationFingerprint(root), version: 4 })
  if (ui === 'browser') expect((await tool.execute({ steps: [{ id: 'draft', kind: 'fill', selector: '#draft', value: 'retained browser storage' }] }, context)).isError).not.toBe(true)
  abort.abort(); await closeDebugSessions(project.project_id, 's')
  expect(readDebugSession(project.project_id, 's', id).state).toBe('closed')
  if (ui === 'browser') await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
  // Even an explicit stale id from the durable transcript reopens safely. The
  // process is new; business data, input bytes and browser state are retained.
  const resumed = await tool.execute({ mode: 'act', debug_session_id: id, steps: [check('resume-count', '#count', '1'), check('resume-version', '#version', 'v2'),
    ...(ui === 'browser' ? [{ id: 'draft-retained', kind: 'expect', property: 'value', selector: '#draft', equals: 'retained browser storage' }] : []),
    { id: 'input-again', kind: 'upload', selector: '#file', path: 'input/sample.txt' }, check('frozen-again', '#file-text', 'frozen persistent fixture')] }, ctx())
  expect(resumed.isError, resumed.output).not.toBe(true)
  expect(JSON.parse(resumed.output)).toMatchObject({ resumed_from: id, version: 5, stale: false })
  expect(JSON.parse(resumed.output).debug_session_id).not.toBe(id)
  expect(JSON.parse(resumed.output).data_dir).toBe(JSON.parse(reloaded.output).data_dir)
  const sourceCheckpoint = JSON.parse(resumed.output).source_checkpoint.id
  writeFileSync(join(root, 'index.html'), html.replace('<h1>Debug fixture</h1>', '<h1>Half edited UI</h1>'))
  const dirty = JSON.parse((await tool.execute({ mode: 'read', debug_session_id: JSON.parse(resumed.output).debug_session_id }, ctx())).output)
  expect(dirty.source_changes.changes).toContainEqual({ path: 'index.html', kind: 'modified' })
  const staleRestore = await tool.execute({ mode: 'restore', checkpoint_id: sourceCheckpoint, expected_source: sourceCheckpoint, paths: ['index.html'] }, ctx())
  expect(staleRestore.isError).toBe(true)
  expect(readDebugSession(project.project_id, 's', JSON.parse(resumed.output).debug_session_id).state).toBe('ready')
  const restored = await tool.execute({ mode: 'restore', checkpoint_id: sourceCheckpoint, expected_source: dirty.current_source, paths: ['index.html'] }, ctx())
  expect(restored.isError, restored.output).not.toBe(true)
  expect(JSON.parse(restored.output)).toMatchObject({ complete_source_match: true, verification: 'not_run' })
  const recovered = await tool.execute({ steps: [check('recovered-title', 'h1', 'Debug fixture'), check('recovered-data', '#count', '1')] }, ctx())
  expect(recovered.isError, recovered.output).not.toBe(true)
}, 150000)
it('attaches only an owned ready browser service and never kills the borrowed service on debug close', async () => {
  const p = await freePort(), url = `http://127.0.0.1:${p}`, root = project.root_path, context = ctx()
  writeFileSync(join(root, 'index.html'), html); writeFileSync(join(root, 'server.cjs'), serverSource('v1'))
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(p)], url }))
  const service = await startSoftwareProcess({ projectId: project.project_id, sessionId: 's', root, command: ['node', 'server.cjs', String(p)], url, signal: context.signal })
  mkdirSync(join(service.data_dir!, 'outputs'), { recursive: true })
  writeFileSync(join(service.data_dir!, 'outputs/service-file.txt'), 'actual service output')
  const tool = buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's'))
  const opened = await tool.execute({ mode: 'open', process_id: service.id, fixtures: [{ path: 'input/borrowed.txt', text: 'actual service data' }],
    steps: [{ id: 'actual-input', kind: 'upload', selector: '#file', path: 'input/borrowed.txt' },
      { id: 'input-readback', kind: 'expect', selector: '#file-text', equals: 'actual service data' },
      { id: 'actual-file', kind: 'expect_file', path: 'outputs/service-file.txt', equals: 'actual service output' }] }, context)
  expect(opened.isError, opened.output).not.toBe(true)
  expect(JSON.parse(opened.output).data_dir).toBe(service.data_dir)
  expect(readFileSync(join(service.data_dir!, 'input/borrowed.txt'), 'utf8')).toBe('actual service data')
  const wrongProcess = await tool.execute({ process_id: 'another-process' }, context)
  expect(wrongProcess.isError).toBe(true); expect(wrongProcess.output).toContain('DEBUG_PROCESS_MISMATCH')
  const sameProcess = await tool.execute({ process_id: service.id }, context)
  expect(sameProcess.isError, sameProcess.output).not.toBe(true)
  expect(JSON.parse(sameProcess.output).debug_session_id).toBe(JSON.parse(opened.output).debug_session_id)
  await tool.execute({ mode: 'close', debug_session_id: JSON.parse(opened.output).debug_session_id }, context)
  expect(readFileSync(join(service.data_dir!, 'input/borrowed.txt'), 'utf8')).toBe('actual service data')
  expect(await (await fetch(`${url}/version`)).text()).toBe('v1')
  const automatic = await tool.execute({ mode: 'open' }, context)
  expect(automatic.isError, automatic.output).not.toBe(true)
  await tool.execute({ mode: 'close', debug_session_id: JSON.parse(automatic.output).debug_session_id }, context)
  writeFileSync(join(root, 'server.cjs'), serverSource('v2'))
  expect((await tool.execute({ mode: 'open' }, context)).output).toContain('DEBUG_PROCESS_SOURCE_CHANGED')
}, 90000)
it('switches to an explicitly requested current owned service without killing either borrowed backend', async () => {
  const root = project.root_path, one = await freePort(), two = await freePort()
  writeFileSync(join(root, 'index.html'), html); writeFileSync(join(root, 'server.cjs'), serverSource('switch'))
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(one)], url: `http://127.0.0.1:${one}` }))
  const first = await startSoftwareProcess({ projectId: project.project_id, sessionId: 's', root, command: ['node', 'server.cjs', String(one)], url: `http://127.0.0.1:${one}` })
  const next = await startSoftwareProcess({ projectId: project.project_id, sessionId: 's', root, command: ['node', 'server.cjs', String(two)], url: `http://127.0.0.1:${two}` })
  const tool = buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's'))
  const before = await tool.execute({ process_id: first.id }, ctx()); expect(before.isError, before.output).not.toBe(true)
  const oldId = JSON.parse(before.output).debug_session_id
  const explicitConflict = await tool.execute({ debug_session_id: oldId, process_id: next.id }, ctx())
  expect(explicitConflict.isError).toBe(true); expect(readDebugSession(project.project_id, 's', oldId).state).toBe('ready')
  const after = await tool.execute({ process_id: next.id }, ctx()); expect(after.isError, after.output).not.toBe(true)
  expect(JSON.parse(after.output).debug_session_id).not.toBe(oldId)
  expect(JSON.parse(after.output).url).toBe(`http://127.0.0.1:${two}/`)
  expect(await (await fetch(`http://127.0.0.1:${one}/version`)).text()).toBe('switch')
  expect(await (await fetch(`http://127.0.0.1:${two}/version`)).text()).toBe('switch')
}, 90000)
it('isolates retained development data by operation and session, and rejects a redirected data directory without touching its target', () => {
  const first = debugWorkspace(project.project_id, 's')
  mkdirSync(join(first, 'data')); writeFileSync(join(first, 'data/count'), 'kept old operation')
  expect(debugWorkspace(project.project_id, 'another-session')).not.toBe(first)
  updateProject(project.project_id, { lean_operation_id: 'new-operation' })
  const next = debugWorkspace(project.project_id, 's')
  expect(next).not.toBe(first); expect(existsSync(join(next, 'data/count'))).toBe(false)
  const target = join(home, 'unrelated-owned-fixture'); mkdirSync(target); writeFileSync(join(target, 'marker'), 'must stay')
  symlinkSync(target, join(next, 'data'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => debugWorkspace(project.project_id, 's')).toThrow('DEBUG_WORKSPACE_LINK_UNSUPPORTED')
  expect(readFileSync(join(target, 'marker'), 'utf8')).toBe('must stay')
  expect(readFileSync(join(first, 'data/count'), 'utf8')).toBe('kept old operation')
})

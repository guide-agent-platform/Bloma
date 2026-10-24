import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { buildLeanCliTool, runLeanCliCheck } from '../../../main/desktop/lean-cli-check'
import { parseLaunchDeclaration, runLaunchSmoke } from '../../../main/desktop/launch-smoke'
import { installGuiAcceptanceSuite, runGuiAcceptance, type GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { buildSoftwareInspectTool } from '../../../main/software/inspect-tool'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'

let home: string, previous: string | undefined
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-software-verify-')); process.env.PROMA_HOME = home })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous; rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('v2 enables explicit runtimes without relaxing historical v1 validation', () => {
  expect(parseLaunchDeclaration(JSON.stringify({ schema_version: 1, command: ['electron', '.'], ui: 'electron' })).ok).toBe(false)
  expect(parseLaunchDeclaration(JSON.stringify({ schema_version: 2, command: ['electron', '.'], ui: 'electron', window_title: 'App' })).ok).toBe(true)
  expect(parseLaunchDeclaration(JSON.stringify({ schema_version: 2, command: ['node', 'server.cjs'], ui: 'browser', url: 'https://example.com' })).ok).toBe(false)
})
it('observes a real Node normal command and rejects a deliberately broken result', async () => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '加法', ui: 'none', requirements: [{ description: '计算加法', expected: '2加3得5' }] }), { projectId: project.project_id, sessionId: 's', source: '加法', previous: readPrdBackplane(project.project_id) })!
  if (parsed.action !== 'brief') throw Error('fixture')
  syncDocuments({ project_id: project.project_id, session_id: 's', request_id: 'sync', checkpoint: 'requirement_confirmed' }, parsed.brief); markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(process.argv.length>2?Number(process.argv[2])+Number(process.argv[3]):5)')
  writeFileSync(join(project.root_path, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, mode: 'command', command: ['node', 'app.cjs'] }))
  await buildLeanCliTool(project.project_id).execute({ expectations: { 'F-001': '2加3得5' }, cases: [{ name: 'sum', covers: ['F-001'], args: ['2', '3'], stdout: '5', exit_code: 0 }] },
    { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: new AbortController().signal, state: createToolState() })
  expect((await runLeanCliCheck(project.project_id, project.root_path)).status).toBe('passed')
  expect((await runLaunchSmoke(project.root_path, { allowCleanExit: true })).passed).toBe(true)
  writeFileSync(join(project.root_path, 'app.cjs'), 'console.log(999)')
  expect((await runLeanCliCheck(project.project_id, project.root_path)).status).toBe('failed')
})
const electron = resolve('node_modules/electron/dist/electron.exe'), scope = 'a'.repeat(64)
it.skipIf(process.platform !== 'win32' || !existsSync(electron)).each(['electron', 'browser'] as const)('really operates %s UI and reopens saved data; wrong expectations fail', async ui => {
  const project = createProject({ request_id: 'create', mode: 'quick' }, { workflowVersion: 'software-v1' }), root = project.root_path
  const html = '<!doctype html><title>Software fixture</title><input id="name"><button id="save">Save</button><div id="items"></div><script>async function refresh(){document.querySelector("#items").textContent=await api.read()}document.querySelector("#save").onclick=async()=>{await api.save(document.querySelector("#name").value);await refresh()};refresh()</script>'
  let launch: Record<string, unknown>
  if (ui === 'electron') {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'software-fixture', main: 'main.cjs' }))
    writeFileSync(join(root, 'main.cjs'), 'const{app,BrowserWindow,ipcMain}=require("electron"),fs=require("fs"),path=require("path");const data=path.join(process.env.APP_DATA_DIR,"record.txt");ipcMain.handle("read",()=>fs.existsSync(data)?fs.readFileSync(data,"utf8"):"");ipcMain.handle("save",(_,value)=>{fs.mkdirSync(path.dirname(data),{recursive:true});fs.writeFileSync(data,value)});app.whenReady().then(()=>{new BrowserWindow({title:"Software fixture",webPreferences:{preload:path.join(__dirname,"preload.cjs"),contextIsolation:true,nodeIntegration:false}}).loadFile("index.html")});app.on("window-all-closed",()=>app.quit())')
    writeFileSync(join(root, 'preload.cjs'), 'const{contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("api",{read:()=>ipcRenderer.invoke("read"),save:value=>ipcRenderer.invoke("save",value)})')
    writeFileSync(join(root, 'index.html'), html)
    launch = { schema_version: 2, ui, command: [electron, '.'], window_title: 'Software fixture' }
  } else {
    const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw Error('port')
    await new Promise<void>(done => server.close(() => done()))
    writeFileSync(join(root, 'index.html'), html.replace('async function refresh()', 'const api={read:()=>fetch("/record").then(r=>r.text()),save:v=>fetch("/record",{method:"POST",body:v})};async function refresh()'))
    writeFileSync(join(root, 'server.cjs'), 'const http=require("http"),fs=require("fs"),path=require("path");const file=path.join(process.env.APP_DATA_DIR,"record.txt");http.createServer((q,s)=>{if(q.url==="/record"){if(q.method==="POST"){let b="";q.on("data",d=>b+=d);q.on("end",()=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,b);s.end("ok")})}else s.end(fs.existsSync(file)?fs.readFileSync(file):"")}else{ s.setHeader("Content-Type","text/html");s.end(fs.readFileSync("index.html"))}}).listen(Number(process.argv[2]),"127.0.0.1")')
    launch = { schema_version: 2, ui, command: ['node', 'server.cjs', String(address.port)], url: `http://127.0.0.1:${address.port}` }
  }
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify(launch))
  const suite: GuiAcceptanceSuite = { version: 1, scope_hash: scope, covers: ['F-001'], steps: [
    { id: 'type', kind: 'fill', selector: '#name', value: 'saved by actual host' }, { id: 'save', kind: 'click', selector: '#save' },
    { id: 'saved', kind: 'expect', selector: '#items', equals: 'saved by actual host' }, { id: 'reopen', kind: 'restart' },
    { id: 'persisted', kind: 'expect', selector: '#items', equals: 'saved by actual host' }] }
  installGuiAcceptanceSuite(project.project_id, suite)
  const positive = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, signal: AbortSignal.timeout(90000) })
  expect(positive?.status, JSON.stringify(positive)).toBe('passed')
  const inspect = await buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's')).execute({ steps: suite.steps, include_image: true },
    { projectId: project.project_id, sessionId: 's', requestId: 'inspect', signal: AbortSignal.timeout(60000), state: createToolState() })
  expect(inspect.isError, inspect.output).not.toBe(true)
  expect(inspect.images?.[0].imageId).toMatch(/^s\//)
  if (ui === 'electron') {
    const plain = await buildSoftwareInspectTool(project.project_id, createSoftwareCollaborationPolicy(project.project_id, root, 's')).execute({},
      { projectId: project.project_id, sessionId: 's', requestId: 'plain-inspect', signal: AbortSignal.timeout(45000), state: createToolState() })
    expect(plain.isError, plain.output).not.toBe(true)
    expect(plain.images).toBeUndefined()
    expect(JSON.parse(plain.output).visual_review).toBe('not_reviewed_by_model')
  }
  installGuiAcceptanceSuite(project.project_id, { ...suite, steps: [{ id: 'wrong', kind: 'expect', selector: '#items', equals: '999', timeout_ms: 100 }] })
  const negative = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, signal: AbortSignal.timeout(45000) })
  expect(negative?.status).toBe('failed')
  writeFileSync(resolve(`run-artifacts/software-${ui}-verification.json`), JSON.stringify({ positive, wrong_expectation_negative: negative, real_normal_entry: launch, model_requests: 0 }, null, 2))
}, 150000)

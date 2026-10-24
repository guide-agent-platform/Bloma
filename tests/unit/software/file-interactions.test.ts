import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { buildLeanGuiTool } from '../../../main/desktop/lean-gui-tool'
import { guiSuitePath, runGuiAcceptance } from '../../../main/desktop/gui-acceptance'
import { sealGuiFixtures, guiDataPath } from '../../../main/desktop/gui-fixtures'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { parseGuiSuite, installGuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>
beforeEach(() => { previous = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-file-actions-')); process.env.PROMA_HOME = home;
  project = createProject({ request_id: 'c', mode: 'quick' }, { workflowVersion: 'software-v1' }) })
afterEach(() => { if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous;
  rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }, 30000)
async function port() { const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const a = server.address(); if (!a || typeof a === 'string') throw Error('port'); await new Promise<void>(done => server.close(() => done())); return a.port }
it('uses a real file chooser, keyboard, drag and download with frozen file bytes; corrupting a frozen blob cannot reuse PASS', async () => {
  const expected = '导入与导出固定文件内容保持一致', root = project.root_path
  const parsed = parseLeanBrief(JSON.stringify({ action: 'brief', goal: '文件工具', ui: 'required', delivery: 'browser', requirements: [{ description: '文件导入导出', expected }] }),
    { projectId: project.project_id, sessionId: 's', source: '浏览器文件工具', previous: readPrdBackplane(project.project_id), software: true })!
  if (parsed.action !== 'brief') throw Error('scope')
  parsed.brief.lean_brief!.preview = 'skip'
  syncDocuments({ request_id: 'sync', project_id: project.project_id, session_id: 's', checkpoint: 'requirement_confirmed' }, parsed.brief)
  const brief = markPrdUserConfirmed(project.project_id)!, scope = prdScopeFingerprint(brief)
  updateProject(project.project_id, { ux_confirmation: { prd_fingerprint: scope, design_hash: scope, html_hash: null } })
  const p = await port(), value = 'Frozen actual file bytes', digest = createHash('sha256').update(value).digest('hex')
  writeFileSync(join(root, 'sample.txt'), value)
  writeFileSync(join(root, 'index.html'), `<!doctype html><input type="file" id="file" hidden><button id="pick">Choose</button><pre id="out"></pre><input id="name"><div id="drag" draggable="true" style="width:100px;height:50px;background:lightblue">Drag</div><div id="drop" style="width:200px;height:100px;background:lightgray">Drop</div><button id="export">Export</button><div id="bottom" style="margin-top:1800px">Bottom</div><script>
const input=document.querySelector('#file');document.querySelector('#pick').onclick=()=>input.click();input.onchange=async()=>{document.querySelector('#out').textContent=await input.files[0].text()};document.querySelector('#drag').ondragstart=e=>e.dataTransfer.setData('text/plain','item');document.querySelector('#drop').ondragover=e=>e.preventDefault();document.querySelector('#drop').ondrop=e=>{e.preventDefault();e.currentTarget.textContent='dropped'};document.querySelector('#export').onclick=()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([document.querySelector('#out').textContent]));a.download='export.txt';a.click()};</script>`)
  writeFileSync(join(root, 'server.cjs'), `require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html');s.end(require('fs').readFileSync('index.html'))}).listen(${p},'127.0.0.1')`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'browser', url: `http://127.0.0.1:${p}`, command: ['node', 'server.cjs'] }))
  const input = { fixtures: [{ path: 'input/sample.txt', source: 'sample.txt' }], steps: [
    { id: 'upload', kind: 'upload', selector: '#pick', path: 'input/sample.txt' }, { id: 'read', kind: 'expect', selector: '#out', equals: value },
    { id: 'type', kind: 'fill', selector: '#name', value: 'erase' }, { id: 'select', kind: 'press', selector: '#name', key: 'Control+A' },
    { id: 'erase', kind: 'press', selector: '#name', key: 'Backspace' }, { id: 'empty', kind: 'expect', selector: '#name', property: 'value', equals: '' },
    { id: 'drag', kind: 'drag', selector: '#drag', target_selector: '#drop' }, { id: 'dropped', kind: 'expect', selector: '#drop', equals: 'dropped' },
    { id: 'scroll', kind: 'scroll', selector: '#bottom' }, { id: 'download', kind: 'download', selector: '#export', path: 'outputs/export.txt' },
    { id: 'file', kind: 'expect_file', path: 'outputs/export.txt', sha256: digest },
  ], acceptance_refs: { read: ['F-001'], file: ['F-001'] } }
  const tool = buildLeanGuiTool(project.project_id), context = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(90000), state: createToolState() }
  expect((await tool.execute(input, context)).isError).not.toBe(true)
  writeFileSync(join(root, 'sample.txt'), 'changed source must not change sealed fixture')
  const actual = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, designHash: scope, signal: context.signal })
  expect(actual?.status, JSON.stringify(actual)).toBe('passed')
  expect((await tool.execute(input, context)).output).toContain('GUI_EXISTING_EXPECTATIONS_CHANGED')
  const suite = JSON.parse(readFileSync(guiSuitePath(project.project_id), 'utf8'))
  const blob = join(home, 'gui-acceptance-fixtures', project.project_id, scope, `${suite.fixtures[0].sha256}.bin`)
  writeFileSync(blob, 'corrupt frozen input')
  const corrupted = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, designHash: scope, signal: context.signal })
  expect(corrupted?.status).toBe('unverified'); expect(corrupted?.error).toContain('FROZEN_BYTES_CHANGED')
}, 120000)
it('refuses source and isolated output symlinks escaping the project/data directory', () => {
  const outside = join(home, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'private.txt'), 'not for the fixture')
  symlinkSync(outside, join(project.root_path, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => sealGuiFixtures(project.project_id, project.root_path, { version: 1, scope_hash: 'a'.repeat(64), covers: ['F-001'],
    steps: [], fixtures: [{ path: 'input/private.txt', source: 'link/private.txt' }] })).toThrow('OUTSIDE_PROJECT')
  const data = join(home, 'data'); mkdirSync(data); symlinkSync(outside, join(data, 'outputs'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => guiDataPath(data, 'outputs/private.txt')).toThrow('OUTSIDE_ISOLATED_DIRECTORY')
  expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('not for the fixture')
})
it.skipIf(process.platform !== 'win32' || !existsSync(resolve('node_modules/electron/dist/electron.exe')))('selects a frozen file through an actual owned Electron native Open dialog', async () => {
  const root = project.root_path, scope = 'b'.repeat(64), text = '原生文件选择的真实内容'
  writeFileSync(join(root, 'sample.txt'), text); writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'native-file-fixture', main: 'main.cjs' }))
  writeFileSync(join(root, 'main.cjs'), `const{app,BrowserWindow,ipcMain,dialog}=require('electron'),fs=require('fs'),path=require('path');let window;ipcMain.handle('choose',async()=>{const result=await dialog.showOpenDialog(window,{properties:['openFile']});return result.canceled?'cancelled':fs.readFileSync(result.filePaths[0],'utf8')});app.whenReady().then(()=>{window=new BrowserWindow({webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false}});window.loadFile('index.html')});app.on('window-all-closed',()=>app.quit())`)
  writeFileSync(join(root, 'preload.cjs'), `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('api',{choose:()=>ipcRenderer.invoke('choose')})`)
  writeFileSync(join(root, 'index.html'), `<html><body><button id="choose">Choose native file</button><pre id="out"></pre><script>document.querySelector('#choose').onclick=async()=>{document.querySelector('#out').textContent=await window.api.choose()}</script></body></html>`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'electron', command: [resolve('node_modules/electron/dist/electron.exe'), '.'], window_title: 'Native file' }))
  const suite = sealGuiFixtures(project.project_id, root, parseGuiSuite({ version: 1, scope_hash: scope, covers: ['F-001'], fixtures: [{ path: 'input/sample.txt', source: 'sample.txt' }],
    steps: [{ id: 'native-open', kind: 'native_upload', selector: '#choose', path: 'input/sample.txt' }, { id: 'content', kind: 'expect', selector: '#out', equals: text }] }))
  installGuiAcceptanceSuite(project.project_id, suite)
  const result = await runGuiAcceptance({ projectId: project.project_id, root, scopeHash: scope, signal: AbortSignal.timeout(60000) })
  expect(result?.status, JSON.stringify(result)).toBe('passed')
}, 90000)

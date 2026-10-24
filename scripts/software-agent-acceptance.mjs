// Deterministic, unpaid model replay; real npm install/build and host GUI checks.
// Run after npm run build. Uses an isolated home, never the user's active app.
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = join(root, 'dist-main/main/software-acceptance-runtime.mjs')
if (!process.versions.electron) {
  const { build } = await import('esbuild')
  await build({ stdin: { contents: `export {registerProjectsIpc} from './main/ipc/projects';export {handleGuideMessage} from './main/guide/stages/guide-pipeline';export {findProject} from './main/project/project-service';export {runCoreVerification} from './main/desktop/core-verification';export {IPC_CHANNELS} from './shared/types'`, resolveDir: root },
    outfile: runtime, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [fileURLToPath(import.meta.url)], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
  child.once('error', error => { console.error(error); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app } = await import('electron')
  async function run() {
  const home = mkdtempSync(join(tmpdir(), 'bloma-sw-accept-'))
  process.env.PROMA_HOME = home; app.setPath('userData', join(home, 'electron-user'))
  let code = 1
  try {
    await app.whenReady()
    const api = await import(pathToFileURL(runtime).href), handlers = new Map(), events = []
    api.registerProjectsIpc({ handle: (name, handler) => handlers.set(name, handler) }, {})
    const created = await handlers.get(api.IPC_CHANNELS.PROJECT_CREATE)({}, { request_id: 'create', mode: 'longterm', initial_message: '做一个浏览器记事本' })
    if (!created.ok || created.data.workflow_version !== 'software-v1') throw Error('public software workflow missing')
    const project = created.data, probe = createServer()
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve))
    const expected = '保存文字后关闭重开仍能读到', calls = [], use = (id, name, input) => ({ type: 'tool_use', id, name, input })
    const file = (path, content) => use(path, 'write_file', { path, content })
    const server = `const http=require('http'),fs=require('fs'),path=require('path');const data=path.join(process.env.APP_DATA_DIR,'records.json');http.createServer((q,s)=>{if(q.url==='/records'){if(q.method==='POST'){let body='';q.on('data',d=>body+=d);q.on('end',()=>{fs.mkdirSync(path.dirname(data),{recursive:true});fs.writeFileSync(data,JSON.stringify([body]));s.end('ok')})}else{s.setHeader('Content-Type','application/json');s.end(fs.existsSync(data)?fs.readFileSync(data):'[]')}return}const rel=q.url.split('?')[0]==='/'?'index.html':q.url.split('?')[0].slice(1),file=path.resolve('dist',rel);if(!file.startsWith(path.resolve('dist')+path.sep)||!fs.existsSync(file)){s.writeHead(404);s.end();return}s.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');s.end(fs.readFileSync(file))}).listen(Number(process.argv[2]),'127.0.0.1')`
    const query = async function* (_prompt, options) {
      calls.push(options)
      const content = calls.length === 1 ? [{ type: 'text', text: JSON.stringify({ action: 'brief', goal: '浏览器记事本', ui: 'required', delivery: 'browser', requirements: [{ description: '保存并重开记录', expected }] }) }]
        : calls.length === 2 ? [{ type: 'text', text: '<!doctype html><html><body><h1>Notes</h1><input id="note"><button id="save">Save</button><div id="items"></div></body></html>' }]
          : calls.length === 3 ? [
            file('package.json', JSON.stringify({ name: 'bloma-real-react-acceptance', private: true, scripts: { build: 'vite build' }, dependencies: { react: '18.3.1', 'react-dom': '18.3.1', vite: '7.3.6' } })),
            file('index.html', '<!doctype html><html><head><title>Notes</title></head><body><div id="root"></div><script type="module" src="/src/main.jsx"></script></body></html>'),
            file('src/main.jsx', `import React,{useEffect,useState} from 'react';import{createRoot}from'react-dom/client';function App(){const[n,setN]=useState(''),[items,setItems]=useState([]);async function load(){setItems(await(await fetch('/records')).json())}useEffect(()=>{load()},[]);return <main style={{fontFamily:'system-ui',maxWidth:640,margin:'60px auto'}}><h1>Your notes</h1><input id="note" value={n} onChange={e=>setN(e.target.value)}/><button id="save" onClick={async()=>{await fetch('/records',{method:'POST',body:n});await load()}}>Save</button><div id="items">{items.join('|')}</div></main>}createRoot(document.getElementById('root')).render(<App/>);`),
            file('server.cjs', server),
            use('install', 'run_command', { command: ['npm', 'install', '--no-audit', '--no-fund'], timeout_ms: 300000 }),
            use('build', 'run_command', { command: ['npm', 'run', 'build'], timeout_ms: 120000 }),
            file('LAUNCH.json', JSON.stringify({ schema_version: 2, ui: 'browser', command: ['node', 'server.cjs', String(port)], url: `http://127.0.0.1:${port}` })),
            use('register', 'register_gui_check', { expectations: { 'F-001': expected }, steps: [
              { id: 'type', kind: 'fill', selector: '#note', value: 'real React npm persistence' }, { id: 'save', kind: 'click', selector: '#save' },
              { id: 'saved', kind: 'expect', selector: '#items', equals: 'real React npm persistence' }, { id: 'reopen', kind: 'restart' },
              { id: 'persisted', kind: 'expect', selector: '#items', equals: 'real React npm persistence' }], acceptance_refs: { saved: ['F-001'], persisted: ['F-001'] } }),
          ] : [{ type: 'text', text: '实现已保存，交由宿主实际检查。' }]
      yield { type: 'assistant', message: { role: 'assistant', content } }
      yield { type: 'result', subtype: 'success', usage: { input_tokens: 20, output_tokens: 20 } }
    }
    const input = { project_id: project.project_id, session_id: 's', request_id: 'goal', mode: 'longterm', current_stage: 'clarifying', content: '做一个浏览器记事本，保存后重开保留' }
    const model = { query, env: {}, signal: AbortSignal.timeout(480000), sessionId: 's', history: [], maxTokens: 8192, persistAssistant: () => {} }, publish = event => events.push(event)
    await api.handleGuideMessage(input, publish, model)
    const id = events.find(event => event.payload.kind === 'lean_scope').payload.questions[0].id
    await api.handleGuideMessage({ ...input, content: '按这份做', metadata: { source: 'card_option', selected_option_id: id } }, publish, model)
    await api.handleGuideMessage({ ...input, content: '确认草图', metadata: { source: 'card_option', selected_option_id: 'ux_confirm_go' } }, publish, model)
    const final = api.findProject(project.project_id)
    if (final.status !== 'completed') throw Error(JSON.stringify({ final, tail: events.slice(-8) }))
    const core = JSON.parse(readFileSync(join(project.root_path, '00_VERIFY/core-verification.json'), 'utf8')), startup = JSON.parse(readFileSync(join(project.root_path, '00_VERIFY/launch-smoke.json'), 'utf8'))
    if (core.status !== 'passed' || !startup.passed || !startup.http_ready) throw Error('host checks incomplete')
    const screenshots = join(root, 'run-artifacts/software-react-screenshots'); mkdirSync(screenshots, { recursive: true }); cpSync(join(project.root_path, '00_VERIFY/screenshots'), screenshots, { recursive: true })
    writeFileSync(join(project.root_path, 'server.cjs'), server.replace("s.end(fs.existsSync(data)?fs.readFileSync(data):'[]')", "s.end('[\"BROKEN\"]')"))
    const negative = await api.runCoreVerification({ projectId: project.project_id, sandboxRoot: project.root_path, signal: model.signal, reuse: true })
    if (negative.status === 'passed') throw Error('broken program incorrectly passed')
    const report = { status: 'PASS', scope: 'bundled domain in actual Electron main; public creation/short goal/one HTML/Pi/npm install/React+Vite build/actual GUI persistence/startup/delivery/negative', electron: process.versions.electron, node: process.versions.node,
      model: 'fixed SDK replay, no generated quality or paid-provider claim', paid_requests: 0, replay_requests: calls.length, workflow: final.workflow_version, core, startup, broken_product_negative: negative }
    writeFileSync(join(root, 'run-artifacts/software-bundled-acceptance.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ status: 'PASS', workflow: final.workflow_version, replay_requests: calls.length, paid_requests: 0, core: core.status, startup: startup.passed, negative: negative.status }))
    code = 0
  } catch (error) { console.error(error?.stack || error) }
  finally { rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); app.exit(code) }
  }
  void run()
}

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { launchSoftwareTrial, softwareTrial, trialFeedbackText, closeSoftwareTrial } from '../../../main/software/trial'
import { softwareProcess, stopSoftwareSession, ownedSoftwarePreview } from '../../../main/software/process-manager'
import { closeAllDebugSessions } from '../../../main/software/debug-sessions'
import { registerNativeGuiTests } from '../../../main/software/native-gui-registration'
import { verifySoftwareCandidate } from '../../../main/software/verification'

let home: string, old: string | undefined, project: ReturnType<typeof createProject>
beforeEach(async () => {
  old = process.env.PROMA_HOME; home = mkdtempSync(join(tmpdir(), 'bloma-trial-')); process.env.PROMA_HOME = home
  project = createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed = parseLeanBrief(JSON.stringify({action:'brief',goal:'save',ui:'required',delivery:'browser',requirements:[{description:'保存姓名',expected:'保存Alice后显示Alice'}]}),
    {projectId:project.project_id,sessionId:'s',source:'save',previous:readPrdBackplane(project.project_id),software:true})!
  if (parsed.action !== 'brief') throw Error('fixture')
  parsed.brief.lean_brief!.preview='skip'
  syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const confirmed=markPrdUserConfirmed(project.project_id)!, scope=prdScopeFingerprint(confirmed)
  updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  const server=createServer(); await new Promise<void>(done=>server.listen(0,'127.0.0.1',done)); const address=server.address()
  if(!address||typeof address==='string')throw Error('port');await new Promise<void>(done=>server.close(()=>done()))
  const root=project.root_path
  writeFileSync(join(root,'server.cjs'),`const fs=require('fs'),path=require('path');const file=path.join(process.env.APP_DATA_DIR,'trial-record.txt');require('http').createServer((q,s)=>{if(q.url==='/data'){if(q.method==='POST'){fs.writeFileSync(file,'trial-only');s.end('saved')}else s.end(fs.existsSync(file)?fs.readFileSync(file):'empty');return;}s.setHeader('Content-Type','text/html');s.end(fs.readFileSync('index.html'))}).listen(Number(process.env.PORT||process.argv[2]),'127.0.0.1')`)
  writeFileSync(join(root,'index.html'),`<title>Trial fixture</title><h1>v1</h1><input id="name"><button id="save" onclick="document.querySelector('#result').textContent=document.querySelector('#name').value">Save</button><output id="result"></output>`)
  writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs',String(address.port)],url:`http://127.0.0.1:${address.port}`}))
  mkdirSync(join(root,'tests'))
  writeFileSync(join(root,'tests/acceptance.mjs'),`export default async({test,page,expect})=>{await test('F-001 save',async()=>{await page.locator('#name').fill('Alice');await page.locator('#save').click();await expect(page.locator('#result')).toHaveText('Alice')})}`)
})
afterEach(async()=>{await closeAllDebugSessions();await stopSoftwareSession(project.project_id,'user-trial');await stopSoftwareSession(project.project_id,'s');if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})},30000)
it('keeps a versioned real trial usable and data isolated throughout successful and failing acceptance, then replaces it only when ready',async()=>{
  const first=await launchSoftwareTrial(project.project_id);expect(first.started,first.detail).toBe(true)
  const trial=first.trial!, originalUrl=JSON.parse(readFileSync(join(project.root_path,'LAUNCH.json'),'utf8')).url
  expect(trial.url).not.toBe(originalUrl);expect(softwareProcess(project.project_id,trial.process_id).purpose).toBe('trial')
  expect(()=>ownedSoftwarePreview(project.project_id,'user-trial',trial.process_id)).toThrow('NOT_OWNED')
  await fetch(new URL('/data',trial.url),{method:'POST'})
  registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')
  let requests=0
  const timer=setInterval(()=>{void fetch(trial.url!).then(response=>{if(response.ok)requests++}).catch(()=>{})},100)
  try{expect((await verifySoftwareCandidate(project.project_id,'r',AbortSignal.timeout(90000))).status).toBe('passed')}finally{clearInterval(timer)}
  expect(requests).toBeGreaterThan(2);expect(await(await fetch(new URL('/data',trial.url))).text()).toBe('trial-only')
  const html=readFileSync(join(project.root_path,'index.html'),'utf8')
  writeFileSync(join(project.root_path,'index.html'),html.replace(".value\"", ".value+'Wrong'\""))
  expect((await verifySoftwareCandidate(project.project_id,'bad',AbortSignal.timeout(90000))).status).not.toBe('passed')
  expect(await(await fetch(trial.url!)).text()).toContain('v1')
  writeFileSync(join(project.root_path,'server.cjs'),'this is broken JavaScript')
  expect((await launchSoftwareTrial(project.project_id,trial.release_id,true)).started).toBe(false)
  expect(softwareTrial(project.project_id)?.process_id).toBe(trial.process_id)
  expect(await(await fetch(trial.url!)).text()).toContain('v1')
  writeFileSync(join(project.root_path,'server.cjs'),`require('http').createServer((q,s)=>s.end('v2')).listen(Number(process.env.PORT),'127.0.0.1')`)
  const next=await launchSoftwareTrial(project.project_id,trial.release_id,true);expect(next.started,next.detail).toBe(true)
  expect(next.trial?.release_id).not.toBe(trial.release_id);expect(softwareProcess(project.project_id,trial.process_id).state).toBe('stopped')
  expect(trialFeedbackText(project.project_id,trial.release_id,'old feedback')).toContain(trial.release_id)
  expect(()=>trialFeedbackText(project.project_id,'f'.repeat(64),'unknown')).toThrow()
  await closeSoftwareTrial(project.project_id,next.trial!.release_id)
  expect(softwareTrial(project.project_id)?.state).toBe('stopped')
},180000)
it('never adopts a persisted live PID after a host restart',async()=>{
  const id='11111111-1111-4111-8111-111111111111',version='a'.repeat(64)
  const directory=join(home,'software-trials',project.project_id);mkdirSync(directory,{recursive:true});mkdirSync(join(home,'software-processes'),{recursive:true})
  writeFileSync(join(home,'software-processes',id+'.json'),JSON.stringify({id,projectId:project.project_id,sessionId:'user-trial',state:'running',pid:process.pid,stdout:'',stderr:''}))
  writeFileSync(join(directory,'current.json'),JSON.stringify({release_id:version,process_id:id,pid:process.pid,state:'running',qualification:'unverified_test_data'}))
  expect(softwareTrial(project.project_id)?.state).toBe('interrupted')
  expect((await launchSoftwareTrial(project.project_id)).detail).toContain('PREVIOUS_HOST_INSTANCE')
  expect(process.kill(process.pid,0)).toBe(true)
})
it.skipIf(process.platform!=='win32'||!existsSync(resolve('node_modules/electron/dist/electron.exe')))('isolates actual Electron single-instance locks and profiles during trial and host acceptance',async()=>{
  const root=project.root_path
  const brief=readPrdBackplane(project.project_id);brief.lean_brief!.delivery='desktop'
  syncDocuments({request_id:'desktop',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},brief)
  const confirmed=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(confirmed)
  updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  writeFileSync(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');if(!app.requestSingleInstanceLock())app.quit();else{app.whenReady().then(()=>new BrowserWindow().loadFile('index.html'));app.on('window-all-closed',()=>app.quit())}`)
  writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'electron',window_title:'Trial fixture',command:['electron','main.cjs','--user-data-dir=shared-bad-profile']}))
  const first=await launchSoftwareTrial(project.project_id);expect(first.started,first.detail).toBe(true)
  registerNativeGuiTests(project.project_id,'tests/acceptance.mjs')
  const checked=await verifySoftwareCandidate(project.project_id,'electron',AbortSignal.timeout(120000))
  expect(checked.status,checked.summary).toBe('passed')
  expect(softwareProcess(project.project_id,first.trial!.process_id).state).toBe('running')
  expect(existsSync(join(first.trial!.data_dir,'electron-profile'))).toBe(true)
},150000)

/** Isolated real Electron renderer/preload smoke; no provider requests. */
import { _electron } from 'playwright'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve('.'), folder=join(root,'run-artifacts/harness-ui-20261027'),home=mkdtempSync(join(tmpdir(),'blharness-'))
mkdirSync(folder,{recursive:true})
const helper=join(folder,'fixture.mjs'), env={...process.env,PROMA_HOME:home,BLOMA_DESKTOP_DISPATCH:'0'}
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
await build({stdin:{resolveDir:root,sourcefile:'harness-fixture.ts',contents:`
import {writeFileSync} from 'node:fs';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{createProject,updateProject}from'./main/project/project-service';import{parseLeanBrief}from'./main/guide/lean-brief';
import{readPrdBackplane,markPrdUserConfirmed}from'./main/project/prd-store';import{syncDocuments}from'./main/project/document-sync';
import{prdScopeFingerprint}from'./main/project/requirement-contract';
const p=createProject({request_id:'c',mode:'quick',initial_message:'试用演示'},{workflowVersion:'software-v1'}),sid=randomUUID();
const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'独立试用',ui:'required',delivery:'browser',requirements:[{description:'保存姓名',expected:'显示已保存姓名'}]}),{projectId:p.project_id,sessionId:sid,source:'试用演示',previous:readPrdBackplane(p.project_id),software:true});
parsed.brief.lean_brief.preview='skip';syncDocuments({request_id:'sync',project_id:p.project_id,session_id:sid,checkpoint:'requirement_confirmed'},parsed.brief);
const brief=markPrdUserConfirmed(p.project_id),scope=prdScopeFingerprint(brief);updateProject(p.project_id,{last_session_id:sid,current_stage:'generating_mvp',desktop_phase:'desktop-implement',ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}});
writeFileSync(join(p.root_path,'app.cjs'),"require('http').createServer((q,s)=>{s.setHeader('Content-Type','text/html;charset=utf-8');s.end('<title>Real trial</title><h1>实际运行的隔离试用</h1><input aria-label=姓名><button>保存</button>')}).listen(Number(process.env.PORT||33661),'127.0.0.1')");
writeFileSync(join(p.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','app.cjs'],url:'http://127.0.0.1:33661'}));console.log(JSON.stringify({pid:p.project_id,sid}));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'silent'})
const prepared=spawnSync(process.execPath,[helper],{cwd:root,env,encoding:'utf8'});assert.equal(prepared.status,0,prepared.stderr)
const {pid,sid}=JSON.parse(prepared.stdout.trim().split('\n').at(-1)),now=new Date().toISOString()
mkdirSync(join(home,'agent-sessions'),{recursive:true})
writeFileSync(join(home,'bloma-agent-sessions.json'),JSON.stringify({version:1,sessions:[{session_id:sid,project_id:pid,status:'active',jsonl_path:join(home,'agent-sessions',sid+'.jsonl'),created_at:now,updated_at:now}]}))
writeFileSync(join(home,'agent-sessions',sid+'.jsonl'),JSON.stringify({role:'user',content:[{type:'text',text:'准备试用'}],timestamp:Date.now()})+'\n')
const report={home,projectId:pid,checks:[],errors:[],layouts:[],model_requests:0,scope:'real renderer/preload + real isolated browser trial; message submit captured, no model work'}
let app
try{
  app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[`--user-data-dir=${join(home,'profile')}`,'.'],cwd:root,env,timeout:30000})
  const page=await app.firstWindow();page.on('pageerror',e=>report.errors.push(e.message))
  await app.evaluate(({BrowserWindow,ipcMain,session})=>{
    const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(200,200);win.setContentSize(1366,900);win.setPosition(-5000,0);win.webContents.setBackgroundThrottling(false)
    globalThis.__harnessInputs=[]
    ipcMain.removeHandler('chat:submit');ipcMain.handle('chat:submit',(_event,input)=>{globalThis.__harnessInputs.push(input);return{ok:true,request_id:input.request_id,data:{client_message_id:input.client_message_id,session_id:input.session_id,request_id:input.request_id,status:'accepted',run_generation:1}}})
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>callback({cancel:!/^http:\/\/127\.0\.0\.1:/.test(details.url)}))
  })
  await page.reload()
  await page.locator('[data-ai-id="software-trial-launch"]').click()
  await page.getByText(/版本 [a-f0-9]{12}/).waitFor()
  const trial=await page.evaluate(async pid=>(await window.electronAPI.projectDeliverables.get({request_id:crypto.randomUUID(),project_id:pid})).data.trial,pid)
  assert.equal(trial.state,'running');assert.equal(trial.qualification,'unverified_test_data')
  const frame=page.frameLocator('iframe[title="独立程序试用（测试数据，尚未验收）"]')
  await frame.getByRole('heading',{name:'实际运行的隔离试用'}).waitFor()
  await app.evaluate(({BrowserWindow},event)=>BrowserWindow.getAllWindows()[0].webContents.send('agent:stream-event',event),{event_id:randomUUID(),project_id:pid,session_id:sid,type:'software_preview_changed',payload:{preview_url:null},created_at:now})
  await frame.getByRole('textbox',{name:'姓名'}).fill('still usable')
  report.checks.push('real trial starts before delivery','debug preview cleanup preserves interactive trial','qualification and version are visible')
  for(const width of [1366,390]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width)
    const switcher=page.getByRole('button',{name:'草图与程序',exact:true});if(await switcher.isVisible())await switcher.click()
    await page.locator('[data-ai-id="software-trial-update"]').scrollIntoViewIfNeeded()
    report.layouts.push(await page.evaluate(()=>({viewport:[innerWidth,innerHeight],width:document.documentElement.scrollWidth})))
    await page.screenshot({path:join(folder,`trial-${width}.png`)})
  }
  await page.getByRole('button',{name:'关闭试用',exact:true}).click()
  await page.getByText('独立试用已关闭，测试数据和版本记录保留。',{exact:true}).waitFor()
  report.checks.push('user can close owned trial independently');assert.deepEqual(report.errors,[])
}finally{
  if(app){
    const page=(await app.windows())[0]
    if(page)await page.evaluate(async pid=>{const api=window.electronAPI?.projectDeliverables;if(!api)return;const result=await api.get({request_id:crypto.randomUUID(),project_id:pid});if(result.ok&&result.data.trial?.state==='running')await api.launch({request_id:crypto.randomUUID(),project_id:pid,trial:true,stop_trial:true,trial_version:result.data.trial.release_id})},pid).catch(()=>{})
    await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})
  }
  writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2))
}
console.log(JSON.stringify(report,null,2))

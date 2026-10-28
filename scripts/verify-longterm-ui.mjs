/** Offline native renderer/preload and real CLI milestone check. No model calls. */
import { _electron } from 'playwright'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, cpSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const root=resolve('.'),folder=join(root,'run-artifacts/longterm-ui-20261027'),home=mkdtempSync(join(tmpdir(),'blmilestone-'))
mkdirSync(folder,{recursive:true})
const helper=join(folder,'fixture/main/longterm-ui-fixture.mjs'),env={...process.env,PROMA_HOME:home,BLOMA_DESKTOP_DISPATCH:'0',BLOMA_DISPATCH_EXPERIMENT:'0'}
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
mkdirSync(dirname(helper),{recursive:true});cpSync(join(root,'main/templates'),join(dirname(helper),'templates'),{recursive:true,filter:path=>!path.split(/[\\/]/).includes('__pycache__')})
await build({stdin:{resolveDir:root,sourcefile:'longterm-ui-fixture.ts',contents:`
import{writeFileSync}from'node:fs';import{join}from'node:path';import{randomUUID}from'node:crypto';
import{createProject,updateProject}from'./main/project/project-service';import{readPrdBackplane,markPrdUserConfirmed}from'./main/project/prd-store';import{prdScopeFingerprint}from'./main/project/requirement-contract';import{parseLeanBrief}from'./main/guide/lean-brief';import{syncDocuments}from'./main/project/document-sync';
import{buildLeanCliTool}from'./main/desktop/lean-cli-check';import{createToolState}from'./main/agent/loop/agent-loop';import{verifySoftwareCandidate}from'./main/software/verification';import{sealSoftwareRelease,activeSoftwareRelease}from'./main/software/release-store';
import{ensureLongtermState,stageLongtermMilestone,noteLongtermSuggestion,recordLongtermDecision}from'./main/software/longterm-state';import{parseLeanSuggestions}from'./main/guide/lean-suggestions';
const p=createProject({request_id:'c',mode:'longterm',initial_message:'阶段输出演示'},{workflowVersion:'software-v1'}),sid=randomUUID();updateProject(p.project_id,{last_session_id:sid});
const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'输出本阶段结果',ui:'none',delivery:'command',requirements:[{description:'输出阶段结果',expected:'显示5'}],constraints:['本地使用'],out_of_scope:['云同步']}),{projectId:p.project_id,sessionId:sid,source:'阶段输出',previous:readPrdBackplane(p.project_id),software:true});
syncDocuments({request_id:'sync',project_id:p.project_id,session_id:sid,checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(p.project_id);
const scope=prdScopeFingerprint(readPrdBackplane(p.project_id));updateProject(p.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}});ensureLongtermState(p.project_id,sid);
writeFileSync(join(p.root_path,'app.cjs'),'console.log(5)');writeFileSync(join(p.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}));
const ctx={projectId:p.project_id,sessionId:sid,requestId:'seed',signal:AbortSignal.timeout(120000),state:createToolState()};
const registered=await buildLeanCliTool(p.project_id).execute({expectations:{'F-001':'显示5'},cases:[{name:'five',covers:['F-001'],args:[],stdout:'5',exit_code:0}]},ctx);if(registered.isError)throw Error(registered.output);
recordLongtermDecision(p.project_id,sid,'保留现有入口','后续新功能保持本阶段输出回归');const suggestion=parseLeanSuggestions([{title:'导出结果',description:'将结果保存为文件',benefit:'下次可读取',expected:'文件包含本阶段结果'}])[0];noteLongtermSuggestion(p.project_id,sid,suggestion,'deferred');
const checked=await verifySoftwareCandidate(p.project_id,'seed',ctx.signal);if(checked.status!=='passed')throw Error(checked.summary);
await sealSoftwareRelease(checked.candidate,{version:checked.core.fingerprint,scope:checked.core.scope_hash??(await import('./main/project/requirement-contract')).prdScopeFingerprint(readPrdBackplane(p.project_id)),at:new Date().toISOString()},ctx.signal);
stageLongtermMilestone(p.project_id,sid,'seed',checked.candidate);if(await activeSoftwareRelease(p.project_id))throw Error('Pending milestone published early');
console.log(JSON.stringify({pid:p.project_id,sid,candidate:checked.candidate.id}));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron','playwright','typescript'],logLevel:'silent'})
const prepared=spawnSync(process.execPath,[helper],{cwd:root,env,encoding:'utf8',timeout:180000});assert.equal(prepared.status,0,prepared.stderr+prepared.stdout)
const{pid,sid,candidate}=JSON.parse(prepared.stdout.trim().split('\n').at(-1)),now=new Date().toISOString()
mkdirSync(join(home,'agent-sessions'),{recursive:true})
writeFileSync(join(home,'bloma-agent-sessions.json'),JSON.stringify({version:1,sessions:[{session_id:sid,project_id:pid,status:'active',jsonl_path:join(home,'agent-sessions',sid+'.jsonl'),created_at:now,updated_at:now}]}))
writeFileSync(join(home,'agent-sessions',sid+'.jsonl'),JSON.stringify({role:'user',content:[{type:'text',text:'核对本阶段并保留下一轮待办'}],timestamp:Date.now()})+'\n')
const report={home,projectId:pid,candidate,checks:[],errors:[],layouts:[],model_requests:0,scope:'real CLI candidate + native renderer/preload milestone/backlog; no model or microphone'}
let app
try{
  app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[`--user-data-dir=${join(home,'profile')}`,'.'],cwd:root,env,timeout:30000})
  const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
  await app.evaluate(({BrowserWindow,session})=>{
    const win=BrowserWindow.getAllWindows()[0];win.setMinimumSize(200,200);win.setContentSize(1366,900);win.setPosition(-5000,0);win.webContents.setBackgroundThrottling(false);win.webContents.setAudioMuted(true)
    globalThis.__longtermFetchAttempts=[];globalThis.fetch=async url=>{globalThis.__longtermFetchAttempts.push(String(url));throw Error('OFFLINE_FIXTURE_NO_PROVIDER_REQUESTS')}
    session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}))
  })
  await page.locator('[data-ai-id="longterm-confirm"]').waitFor()
  assert.equal(await page.getByRole('button',{name:'纳入下一轮并确认',exact:true}).isEnabled(),false)
  await page.reload();await page.locator('[data-ai-id="longterm-confirm"]').waitFor()
  const before=await page.evaluate(async pid=>(await window.electronAPI.projectDeliverables.get({request_id:crypto.randomUUID(),project_id:pid})).data,pid)
  assert.equal(before.stable_release,undefined);assert.equal(before.longterm.milestones[0].status,'awaiting_confirmation')
  await page.locator('[data-ai-id="software-trial-launch"]').click()
  await page.getByLabel('命令试用输出').waitFor();assert.equal((await page.getByLabel('命令试用输出').innerText()).trim(),'5')
  const trial=await page.evaluate(async pid=>(await window.electronAPI.projectDeliverables.get({request_id:crypto.randomUUID(),project_id:pid})).data.trial,pid)
  assert.equal(trial.release_id,candidate);assert.equal(trial.state,'exited')
  report.checks.push('pending milestone restores without consuming confirmation','sealed candidate leaves production pointer unchanged','one-shot trial executes the exact milestone with test data')
  for(const width of [1366,390]){
    await app.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setContentSize(width,900),width)
    const switcher=page.getByRole('button',{name:'草图与程序',exact:true});if(await switcher.isVisible())await switcher.click()
    await page.locator('[data-ai-id="longterm-confirm"]').scrollIntoViewIfNeeded()
    const layout=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],width:document.documentElement.scrollWidth}));assert.ok(layout.width<=layout.viewport[0]+1);report.layouts.push(layout)
    await page.screenshot({path:join(folder,`milestone-${width}.png`)})
  }
  await page.locator('[data-ai-id="longterm-confirm"]').click()
  await page.getByText('本阶段已交付',{exact:true}).first().waitFor({timeout:90000})
  const confirmed=await page.evaluate(async pid=>(await window.electronAPI.projectDeliverables.get({request_id:crypto.randomUUID(),project_id:pid})).data,pid)
  assert.equal(confirmed.stable_release,candidate);assert.equal(confirmed.longterm.milestones[0].status,'delivered');assert.equal(confirmed.longterm.backlog[0].state,'deferred')
  await page.getByRole('button',{name:'纳入下一轮并确认',exact:true}).click()
  await page.getByRole('button',{name:/按这份做/}).waitFor()
  await page.getByText('将结果保存为文件',{exact:true}).waitFor()
  const attempts=await app.evaluate(()=>globalThis.__longtermFetchAttempts);assert.deepEqual(attempts,[])
  report.checks.push('user confirmation rechecks and publishes the owned candidate without a model','backlog survives milestone completion and only stages scope on explicit adoption','new target requires its own confirmation; no automatic next iteration')
  assert.deepEqual(report.errors,[])
}catch(error){
  report.failure=String(error)
  if(app){const page=await app.firstWindow();report.visible_text=await page.locator('body').innerText();await page.screenshot({path:join(folder,'failure.png')})}
  throw error
}finally{
  if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}
  writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2))
}
console.log(JSON.stringify(report,null,2))

/** Native copy-migration and retired-entry check; isolated home, no provider. */
import { _electron } from 'playwright'
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
const historicalVersion=process.env.BLOMA_MIGRATION_FIXTURE_VERSION??'lean-v1'
if(!['lean-v1','unmarked'].includes(historicalVersion))throw Error('Invalid historical fixture version')
const retirementText=historicalVersion==='lean-v1'?'lean-v1 制作流程已退役':'旧版生成流程已退役'
const root=resolve('.'),home=mkdtempSync(join(tmpdir(),'blmigrate-')),folder=resolve(process.env.BLOMA_VALIDATION_OUTPUT??join(root,'run-artifacts/workflow-migration-20261027'))
mkdirSync(folder,{recursive:true})
const helper=join(folder,'fixture/main/migration-fixture.mjs'),env={...process.env,PROMA_HOME:home,BLOMA_DESKTOP_DISPATCH:'1',BLOMA_DISPATCH_EXPERIMENT:'1',BLOMA_MIGRATION_FIXTURE_VERSION:historicalVersion}
delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
mkdirSync(dirname(helper),{recursive:true});cpSync(join(root,'main/templates'),join(dirname(helper),'templates'),{recursive:true,filter:path=>!path.split(/[\\/]/).includes('__pycache__')})
await build({stdin:{resolveDir:root,sourcefile:'migration-fixture.ts',contents:`
import{writeFileSync,mkdirSync}from'node:fs';import{join}from'node:path';import{randomUUID}from'node:crypto';import{createProject,updateProject}from'./main/project/project-service';
const p=createProject({request_id:'old',mode:'longterm',initial_message:'保留旧笔记'},process.env.BLOMA_MIGRATION_FIXTURE_VERSION==='lean-v1'?{workflowVersion:'lean-v1'}:undefined),sid=randomUUID();updateProject(p.project_id,{last_session_id:sid});writeFileSync(join(p.root_path,'app.py'),'print("legacy user work")');mkdirSync(join(p.root_path,'data'));writeFileSync(join(p.root_path,'data/notes.json'),'真实笔记不能丢');console.log(JSON.stringify({pid:p.project_id,sid,source:p.root_path}));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'silent'})
const prepared=spawnSync(process.execPath,[helper],{cwd:root,env,encoding:'utf8',timeout:60000});assert.equal(prepared.status,0,prepared.stderr)
const {pid,sid,source}=JSON.parse(prepared.stdout.trim().split('\n').at(-1)),now=new Date().toISOString()
mkdirSync(join(home,'agent-sessions'),{recursive:true})
writeFileSync(join(home,'bloma-agent-sessions.json'),JSON.stringify({version:1,sessions:[{session_id:sid,project_id:pid,status:'active',jsonl_path:join(home,'agent-sessions',sid+'.jsonl'),created_at:now,updated_at:now}]}))
writeFileSync(join(home,'agent-sessions',sid+'.jsonl'),JSON.stringify({role:'user',content:[{type:'text',text:'这是历史记录'}],timestamp:Date.now()})+'\n')
mkdirSync(join(home,'usage-ledger'));writeFileSync(join(home,'usage-ledger','preserved.json'),'original accounting')
const before=JSON.parse(readFileSync(join(home,'projects.json'),'utf8')).projects[0],report={home,historical_version:historicalVersion,checks:[],errors:[]};let app
try{
  app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[`--user-data-dir=${join(home,'profile')}`,'.'],cwd:root,env,timeout:30000})
  const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
  await app.evaluate(({BrowserWindow,session})=>{const win=BrowserWindow.getAllWindows()[0];win.setPosition(-5000,0);win.webContents.setAudioMuted(true);globalThis.__migrationFetch=[];globalThis.fetch=async url=>{globalThis.__migrationFetch.push(String(url));throw Error('OFFLINE_MIGRATION_NO_MODEL')};session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_,cb)=>cb({cancel:true}))})
  await page.locator('[data-ai-id="all-projects-button"]').waitFor()
  const response=await page.evaluate(async({pid,sid})=>window.electronAPI.agent.sendMessage({request_id:crypto.randomUUID(),project_id:pid,session_id:sid,mode:'longterm',current_stage:'clarifying',content:'继续'}),{pid,sid})
  assert.equal(response.ok,true)
  await page.getByText(retirementText,{exact:false}).first().waitFor()
  const transcript=join(home,'agent-sessions',sid+'.jsonl')
  for(let i=0;i<100&&!readFileSync(transcript,'utf8').includes(retirementText);i++)await new Promise(done=>setTimeout(done,50))
  assert.ok(readFileSync(transcript,'utf8').includes(retirementText))
  const beforeCopy=JSON.parse(readFileSync(join(home,'projects.json'),'utf8')).projects.find(p=>p.project_id===pid)
  assert.deepEqual({...beforeCopy,updated_at:before.updated_at},before)
  await page.locator('[data-ai-id="all-projects-button"]').click()
  await page.locator('[data-ai-id="project-migrate-workflow"]').waitFor()
  await page.screenshot({path:join(folder,'before-copy.png')})
  await page.locator('[data-ai-id="project-migrate-workflow"]').click()
  await page.getByRole('heading',{name:'保留旧笔记（新流程副本）',exact:true}).waitFor()
  const projects=JSON.parse(readFileSync(join(home,'projects.json'),'utf8')).projects,original=projects.find(p=>p.project_id===pid),copy=projects.find(p=>p.workflow_migration?.source_project_id===pid)
  assert.deepEqual(original,beforeCopy);assert.equal(copy.workflow_version,'software-v1');assert.equal(copy.current_stage,'clarifying');assert.equal(copy.ux_confirmation,undefined)
  assert.equal(readFileSync(join(copy.root_path,'data/notes.json'),'utf8'),'真实笔记不能丢');assert.equal(readFileSync(join(source,'app.py'),'utf8'),'print("legacy user work")')
  assert.equal(readFileSync(join(home,'usage-ledger/preserved.json'),'utf8'),'original accounting')
  const delivery=await page.evaluate(async id=>(await window.electronAPI.projectDeliverables.get({request_id:crypto.randomUUID(),project_id:id})).data,copy.project_id)
  assert.equal(delivery.stable_release,undefined);assert.equal(delivery.can_launch,false)
  assert.deepEqual(await app.evaluate(()=>globalThis.__migrationFetch),[]);assert.deepEqual(report.errors,[])
  report.checks.push('old message returns retirement with old switch enabled and no provider call','history button creates explicit new software copy','copy leaves source metadata, source data and old ledger byte-identical; message records activity time','new copy has no old confirmation or delivery authority')
  report.copy=copy.project_id;await page.screenshot({path:join(folder,'new-copy.png')})
}catch(error){report.failure=String(error);if(app){const page=await app.firstWindow();report.visible_text=await page.locator('body').innerText();await page.screenshot({path:join(folder,'failure.png')})}throw error}
finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2))}
console.log(JSON.stringify(report,null,2))

/** Real isolated Electron renderer -> production preload -> production IPC.
 * Fixed local channel metadata, no provider requests or user home changes. */
import { build } from 'esbuild'
import { _electron } from 'playwright'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
const root=resolve('.'),folder=join(root,'run-artifacts/model-settings-ui-20261029'),home=mkdtempSync(join(tmpdir(),'bloma-settings-ui-'))
mkdirSync(folder,{recursive:true})
const env={...process.env,PROMA_HOME:home};delete env.ELECTRON_RUN_AS_NODE;delete env.VITE_DEV_SERVER_URL
const main=join(folder,'main.mjs'),renderer=join(folder,'ui.js')
await build({stdin:{resolveDir:root,sourcefile:'model-settings-fixture.ts',contents:`
import{app,BrowserWindow,ipcMain,session}from'electron';import{writeFileSync}from'node:fs';import{join}from'node:path';
import{createProject}from'./main/project/project-service';import{registerProjectDeliverablesIpc}from'./main/ipc/project-deliverables';
import{saveSoftwareRunState}from'./main/software/run-state';
app.whenReady().then(()=>{
 const p=createProject({request_id:'fixture',mode:'quick'},{workflowVersion:'software-v1'});
 globalThis.lockSettings=()=>saveSoftwareRunState({projectId:p.project_id,sessionId:'fixture',runId:'fixture',status:'running'});
 writeFileSync(join(process.env.PROMA_HOME,'bloma-channels.json'),JSON.stringify({version:1,channels:[{id:'b',name:'隔离测试渠道',provider_type:'deepseek',base_url:'https://b.invalid',api_key:'SECRET_SENTINEL',enabled:true,models:[{id:'b1',name:'fixture-b',enabled:true}]}]}));
 globalThis.externalRequests=[];session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(request,cb)=>{globalThis.externalRequests.push(request.url);cb({cancel:true})});
 const w=new BrowserWindow({width:1100,height:860,minWidth:300,show:true,webPreferences:{preload:${JSON.stringify(join(root,'dist-main/preload/bridge.cjs'))},contextIsolation:true,nodeIntegration:false,sandbox:false}});
 registerProjectDeliverablesIpc(ipcMain,w);w.loadFile(${JSON.stringify(join(folder,'index.html'))},{query:{project:p.project_id}});
});app.on('window-all-closed',()=>app.quit());`},outfile:main,bundle:true,platform:'node',format:'esm',external:['electron','playwright','typescript','@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-ai'],logLevel:'silent'})
await build({stdin:{resolveDir:root,sourcefile:'model-settings-ui.tsx',loader:'tsx',contents:`
import React from'react';import{createRoot}from'react-dom/client';import{Provider,createStore}from'jotai';
import{SoftwareModelSettingsPanel}from'./renderer/components/SoftwareModelSettingsPanel';import{currentProjectAtom}from'./renderer/agent-atoms';
import'./renderer/styles/tokens.css';import'./renderer/styles/refined.css';
const store=createStore();store.set(currentProjectAtom,{project_id:new URLSearchParams(location.search).get('project'),workflow_version:'software-v1',name:'独立验收配置演示'} as any);
createRoot(document.getElementById('root')!).render(<Provider store={store}><SoftwareModelSettingsPanel/></Provider>);`},outfile:renderer,bundle:true,platform:'browser',format:'iife',loader:{'.mp3':'dataurl'},logLevel:'silent'})
writeFileSync(join(folder,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><style>body{margin:0;background:#f8f6fa;font-family:system-ui}#root{max-width:860px;margin:auto}</style><div id="root"></div><script src="ui.js"></script></html>')
const report={home,checks:[],layouts:[],errors:[],external_requests:[]};let app
try{
 app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[`--user-data-dir=${join(home,'profile')}`,main],cwd:root,env,timeout:30000})
 const page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.message))
 await page.getByText('预算准入：开工时检查 · 设计：尚未准备').waitFor()
 await page.getByRole('radio',{name:/A＋B/}).check()
 await page.getByLabel('B 的渠道').selectOption('b');await page.getByLabel('B 的模型').selectOption('fixture-b')
 for(const [label,value]of [['B 独立设计预算','1'],['上下文上限','4096'],['输入单价','1'],['输出单价','2']])await page.getByLabel(label,{exact:true}).fill(value)
 assert.equal(await page.getByRole('button',{name:'保存并授权 B 预算'}).isDisabled(),true)
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'保存并授权 B 预算'}).click()
 await page.getByText(/配置已保存；未调用模型/).waitFor();await page.reload()
 await page.getByText(/已保存的 B 预算：1 元/).waitFor()
 assert.equal(await page.getByRole('radio',{name:/A＋B/}).isChecked(),true)
 assert.equal(await page.getByRole('checkbox').isChecked(),false)
 assert.equal(await page.getByLabel('B 的模型').inputValue(),'fixture-b')
 assert.equal(await page.getByLabel('上下文上限',{exact:true}).inputValue(),'4096')
 assert.equal(await page.getByLabel('输入单价',{exact:true}).inputValue(),'1')
 assert.equal(await page.getByLabel('输出单价',{exact:true}).inputValue(),'2')
 await page.getByText('计价与保守预留',{exact:true}).click()
 report.checks.push('actual preload/IPC save','new funding authorization persisted in isolated home','reload retains project route and pricing; consent resets')
 for(const width of [1100,420]){
   await app.evaluate(({BrowserWindow},width)=>{const w=BrowserWindow.getAllWindows()[0];w.setMinimumSize(300,400);w.setContentSize(width,900)},width)
   await page.screenshot({path:join(folder,`settings-${width}.png`),fullPage:true})
   const layout=await page.evaluate(()=>({viewport:[innerWidth,innerHeight],content:document.documentElement.scrollWidth}))
   report.layouts.push(layout);assert.ok(layout.content<=layout.viewport[0])
 }
 const projectId=new URL(page.url()).searchParams.get('project')
 const policy=JSON.parse(readFileSync(join(home,'software-independent-design',projectId,'policy.json'),'utf8')).policy
 const before=readFileSync(policy.monetary_policy_path+'.state.json','utf8')
 await page.getByRole('radio',{name:'单模型',exact:false}).check();await page.getByRole('button',{name:'保存单模型配置'}).click()
 await page.getByText(/配置已保存；未调用模型/).waitFor()
 assert.equal(readFileSync(policy.monetary_policy_path+'.state.json','utf8'),before)
 report.checks.push('single selection preserves prior funding state','two widths have no horizontal overflow')
 await app.evaluate(()=>globalThis.lockSettings());await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.getByText(/本轮已开始或已登记对照/).waitFor();assert.equal(await page.getByRole('button',{name:'保存单模型配置'}).isDisabled(),true)
 report.checks.push('fixed running-state fixture locks controls over actual IPC')
 report.external_requests=await app.evaluate(()=>globalThis.externalRequests);assert.deepEqual(report.external_requests,[]);assert.deepEqual(report.errors,[])
}finally{if(app){await app.evaluate(({app})=>app.exit(0)).catch(()=>{});await app.close().catch(()=>{})}writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2))}
console.log(JSON.stringify(report,null,2))

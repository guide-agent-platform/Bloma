import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {_electron as electron} from 'playwright'
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),out=path.resolve(process.env.BLOMA_VALIDATION_OUTPUT??path.join(root,'run-artifacts/flow-routing-ui-20261029')),home=fs.mkdtempSync(path.join(os.tmpdir(),'bloma-flow-routing-'))
fs.mkdirSync(out,{recursive:true});let app,page
const report={scope:'actual Bloma Electron settings and IPC in isolated home; invalid local fixture keys; no provider requests',cases:[],errors:[]},pass=name=>report.cases.push({name,status:'passed'})
async function start(){const env={...process.env,PROMA_HOME:home};delete env.ELECTRON_RUN_AS_NODE;app=await electron.launch({executablePath:require('electron'),args:[`--user-data-dir=${path.join(home,'profile')}`,'.'],cwd:root,env});page=await app.firstWindow();page.on('pageerror',error=>report.errors.push(error.stack));await page.waitForLoadState('domcontentloaded')}
async function api(method,input){const value=await page.evaluate(async({method,input})=>window.electronAPI.channels[method]({request_id:crypto.randomUUID(),...input}),{method,input});assert.equal(value.ok,true,JSON.stringify(value));return value.data}
async function stop(){const instance=app;if(!instance)return;const exited=new Promise(resolve=>instance.process().once('exit',resolve));await instance.evaluate(({app,BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.removeAllListeners('close');app.quit()}).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(Error('NORMAL_QUIT_TIMEOUT')),10000))]);app=undefined}
async function settings(){await page.getByRole('button',{name:'设置（模型渠道）',exact:true}).click();await page.getByRole('heading',{name:'流程模型路由',exact:true}).waitFor()}
try{
 await start()
 const a=await api('create',{name:'路由测试 A',provider_type:'anthropic',base_url:'https://routing-a.example.test',api_key:'LOCAL_ONLY_NOT_A_PROVIDER_KEY',models:[{id:'a',name:'fixture-a',enabled:true}]}),b=await api('create',{name:'路由测试 B',provider_type:'anthropic',base_url:'https://routing-b.example.test',api_key:'LOCAL_ONLY_NOT_A_PROVIDER_KEY',models:[{id:'b',name:'fixture-b',enabled:true}]})
 await api('categoryRoutingUpdate',{routing:{guide:{channel_id:a.id},sketch:{channel_id:a.id},mvp:{channel_id:b.id}}})
 await page.reload();await settings()
 assert.equal(await page.locator('[data-ai-id^="role-routing-row-"]').count(),2);assert.equal(await page.locator('[data-ai-id=legacy-routing-details]').count(),0)
 const panel=await page.locator('[data-ai-id=role-routing-section]').innerText();assert.ok(!/旧裁判|旧流程兼容|生效模型：/.test(panel));assert.ok(panel.includes('会话明确选择的渠道'));pass('only two current flow groups exist; retired judge/audit and compatibility drawer are absent')
 await page.getByLabel('需求沟通 渠道',{exact:true}).selectOption(b.id);await page.locator('[data-ai-id=role-routing-save]').click();await page.getByText('流程默认值已保存；未调用模型，未编辑的现役分组保持原配置。',{exact:true}).waitFor()
 let saved=await api('categoryRoutingList',{}),view=name=>saved.views.find(row=>row.category===name)
 assert.equal(view('guide').channel_id,b.id);assert.equal(view('sketch').channel_id,a.id);assert.equal(view('mvp').channel_id,b.id);pass('partial update preserves an untouched current generation group')
 await page.getByLabel('界面与制作 渠道',{exact:true}).selectOption(b.id);await page.locator('[data-ai-id=role-routing-save]').click();await page.getByText('流程默认值已保存；未调用模型，未编辑的现役分组保持原配置。',{exact:true}).waitFor()
 saved=await api('categoryRoutingList',{});assert.equal(view('sketch').channel_id,b.id);assert.equal(view('mvp').channel_id,b.id);assert.deepEqual(saved.views.map(row=>row.category),['guide','sketch','mvp']);pass('generation default expands only into the two active generation stages')
 await page.locator('[data-ai-id=role-routing-reset-all]').click();saved=await api('categoryRoutingList',{});assert.equal(view('guide').effective,'auto');assert.equal(view('mvp').effective,'auto');pass('explicit current-flow reset clears both active defaults')
 await page.getByLabel('界面与制作 渠道',{exact:true}).selectOption(a.id);await page.locator('[data-ai-id=role-routing-save]').click();await page.getByText('流程默认值已保存；未调用模型，未编辑的现役分组保持原配置。',{exact:true}).waitFor();await page.screenshot({path:path.join(out,'routing-default.png'),fullPage:true})
 await page.getByRole('tab',{name:'验收设计',exact:true}).click();await page.getByRole('heading',{name:'验收设计',exact:true}).waitFor();pass('acceptance design remains separate from flow default routing')
 await stop();await start();await settings();saved=await api('categoryRoutingList',{});assert.equal(view('mvp').channel_id,a.id);assert.equal(await page.locator('[data-ai-id^="role-routing-row-"]').count(),2);pass('isolated process relaunch retains current defaults without recreating a retired role')
 assert.deepEqual(report.errors,[]);report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1;if(page&&!page.isClosed()){report.visible_text=await page.locator('body').innerText().catch(()=> '');await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{})}}
finally{if(app)await stop().catch(()=>{});fs.writeFileSync(path.join(out,'native-report.json'),JSON.stringify(report,null,2));if(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep+'bloma-flow-routing-'))fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});console.log(JSON.stringify(report,null,2))}

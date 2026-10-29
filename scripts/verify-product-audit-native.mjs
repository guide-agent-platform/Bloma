import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {_electron as electron} from 'playwright'
const require=createRequire(import.meta.url),root=path.resolve(import.meta.dirname,'..'),out=path.join(root,'run-artifacts/template-audit-20261029'),home=fs.mkdtempSync(path.join(os.tmpdir(),'bloma-audit-native-')),data=path.join(home,'data')
fs.mkdirSync(out,{recursive:true});fs.mkdirSync(data)
for(const [folder,name]of [['data-store','product_store.cjs'],['jobs','product_jobs.cjs']])fs.copyFileSync(path.join(root,'main/templates/components',folder,name),path.join(home,name))
const resultFile=path.join(home,'close-result.json'),entry=path.join(home,'main.cjs')
fs.writeFileSync(entry,`const {app,BrowserWindow}=require('electron'),fs=require('fs');const queue=require('./product_jobs.cjs').createJobQueue({dataDir:process.env.APP_DATA_DIR,handlers:{hold:async(_,ctx)=>{ctx.beginEffect();await new Promise(()=>{})}}});queue.enqueue({type:'hold',dedupeKey:'owned-noncooperative-task'});let closing=false;app.whenReady().then(()=>new BrowserWindow({width:400,height:240}).loadURL('data:text/html,<h1>Task shutdown fault injection</h1>'));app.on('before-quit',event=>{if(!closing){event.preventDefault();closing=true;queue.close({timeoutMs:50}).then(result=>{fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(result));app.quit()})}});app.on('window-all-closed',()=>app.quit())`)
const report={scope:'actual Electron process exit with an owned noncooperative task; no external write or provider request',cases:[]};let app,queue
try{
 const env={...process.env,APP_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE
 app=await electron.launch({executablePath:require('electron'),args:[`--user-data-dir=${path.join(home,'profile')}`,entry],env});await app.firstWindow();const pid=app.process().pid
 const before=Date.now();await app.close();app=undefined;const elapsed=Date.now()-before,result=JSON.parse(fs.readFileSync(resultFile,'utf8'))
 assert.ok(elapsed<3000);assert.equal(result.closed,false);assert.equal(result.lock_released,false);assert.ok(fs.existsSync(path.join(data,'.jobs-owner.lock')))
 report.cases.push({name:'actual window/process close is bounded and retains unfinished ownership proof',status:'passed',elapsed_ms:elapsed})
 let alive=true;try{process.kill(pid,0)}catch(error){if(error.code==='ESRCH')alive=false;else throw error}assert.equal(alive,false)
 const {recoverJobLock,createJobQueue}=require(path.join(home,'product_jobs.cjs'));assert.equal(recoverJobLock(data).recovered,true)
 let calls=0;queue=createJobQueue({dataDir:data,handlers:{hold:async()=>{calls++}}});assert.equal(calls,0);assert.equal(queue.list()[0].state,'interrupted');assert.equal(queue.list()[0].needs_review,true)
 report.cases.push({name:'dead-owner recovery after real process exit keeps review required and performs no replay',status:'passed'});report.status='passed'
}catch(error){report.status='failed';report.failure=error.stack;process.exitCode=1}
finally{if(app)await app.close().catch(()=>{});if(queue)await queue.close();fs.writeFileSync(path.join(out,'native-close-report.json'),JSON.stringify(report,null,2));if(path.resolve(home).startsWith(path.resolve(os.tmpdir())+path.sep+'bloma-audit-native-'))fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});console.log(JSON.stringify(report,null,2))}

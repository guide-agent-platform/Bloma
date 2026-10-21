import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const cohort=path.resolve(process.argv[2]);
const version='r5a';
const evidence='C:/Users/17359/AppData/Local/Bloma/production-v2-L1-20261020';
const runtime='C:/Users/17359/.codex/worktrees/handoff-recovery-fix/guide-agent-platform-sprint0';
const credentials='C:/Users/17359/AppData/Local/Bloma/parallel-preflight-20261018/credentials.dpapi.json';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const put=(p,value)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(value,null,2),{flag:'wx'});};
const registry=read(path.join(cohort,'registry.json'));
assert.equal(registry.status,'prepared-not-started');
assert(!fs.existsSync(path.join(cohort,'readiness-release.json')));
const manifest=read(path.join(cohort,'snapshot/manifest.json'));
const events=row=>{const p=path.join(row.home,'dispatch-experiments/events',row.run_id+'.jsonl');return fs.readFileSync(p,'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);};
function child(command,args,log){return new Promise((done,reject)=>{
 const output=fs.createWriteStream(log,{flags:'wx'});
 const processChild=spawn(command,args,{cwd:runtime,windowsHide:true,env:{...process.env,BLOMA_DELEGATION_WORKTREE:'0'},stdio:['ignore','pipe','pipe']});
 processChild.stdout.pipe(output,{end:false});processChild.stderr.pipe(output,{end:false});
 processChild.on('error',error=>{output.end();reject(error);});
 processChild.on('exit',code=>{output.end();code===0?done():reject(Error('Qualification process failed; see '+log));});
});}
async function prepare(row){
 const dir=path.join(evidence,'env-'+version,row.group);fs.mkdirSync(dir,{recursive:true});
 await child(process.execPath,['dist-main/main/experiment-environment.mjs','--home',row.home,'--report',path.join(dir,'report.json'),'--python','C:/Users/17359/AppData/Local/Programs/Python/Python313/python.exe','--pins','C:/Users/17359/AppData/Local/Bloma/parallel-native-quick-20261018/source-environment.json','--wheelhouse','C:/Users/17359/AppData/Local/Bloma/parallel-native-quick-20261018/wheelhouse','--smoke'],path.join(dir,'preparation.log'));
 await child(process.execPath,['scripts/dispatch-experiment-native.mjs','seed','--home',row.home,'--no-monetary-limit','--glm-plan','coding','--credentials',credentials],path.join(dir,'seed.log'));
 await child(path.join(runtime,'node_modules/electron/dist/electron.exe'),['scripts/probe-isolated-channels.cjs',row.home,path.join(dir,'channels.json')],path.join(dir,'channels.log'));
 assert.equal(read(path.join(dir,'channels.json')).usable_count,2);
 console.log(JSON.stringify({group:row.group,environment:'ready',channels:2}));
}
// Limit host preparation concurrency; groups do not call models here.
const queue=[...registry.matrix];
await Promise.all(Array.from({length:3},async()=>{while(queue.length)await prepare(queue.shift());}));
const {_electron}=await import(pathToFileURL(path.join(runtime,'node_modules/playwright/index.mjs')).href);
const platform=[],draftChanges=[];
for(const row of registry.matrix){
 let application;
 try{
  const env={...process.env,PROMA_HOME:row.home,BLOMA_DESKTOP_DISPATCH:'1',BLOMA_DISPATCH_EXPERIMENT:'1',BLOMA_EXPERIMENT_UNLIMITED_MONETARY:'1',BLOMA_MONETARY_POLICY:'',BLOMA_EXPERIMENT_MAX_OUTPUT_TOKENS:'640000'};delete env.ELECTRON_RUN_AS_NODE;
  application=await _electron.launch({cwd:runtime,args:['.',`--user-data-dir=${path.join(row.home,'electron-user-data')}`],env,timeout:60000});
  await application.evaluate(({BrowserWindow})=>{for(const win of BrowserWindow.getAllWindows()){win.setBounds({x:-15000,y:-15000,width:1280,height:860});win.webContents.setBackgroundThrottling(false);}});
  const page=await application.firstWindow();await page.waitForLoadState('domcontentloaded');await page.waitForFunction(()=>!!window.electronAPI,{timeout:30000});
  const upgrade=page.locator('[data-ai-id="upgrade-cancel"]');if(await upgrade.isVisible())await upgrade.click();
  const history=page.getByRole('button',{name:'所有项目',exact:true});if(await history.isVisible())await history.click();
  const nav=page.getByRole('button',{name:'我的项目',exact:true});if(await nav.isVisible())await nav.click();
  await page.locator('[data-ai-id="project-list-item"]').click();
  const composer=page.locator('textarea');await composer.waitFor();await composer.fill('继续');
  const send=page.getByRole('button',{name:'发送消息',exact:true});await send.waitFor();assert(await send.isEnabled());
  await page.screenshot({path:path.join(evidence,`platform-${version}-${row.group}.png`)});
  await composer.fill('');
  await application.close();application=undefined;
  const parent='agent-sessions/'+manifest.parent_session_id+'.jsonl';
  assert.equal(sha(path.join(row.home,parent)),sha(path.join(cohort,'snapshot/home',parent)));
  const config=read(path.join(row.home,'dispatch-experiments',registry.project_id+'.json'));
  const project=read(path.join(row.home,'projects.json')).projects[0];
  assert.equal(events(row).filter(e=>e.event==='model_request').length,0);
  assert.equal(config.production_protocol,'v2');assert.equal(config.state,'running');assert(!config.started_at);
  assert.equal(project.current_stage,'blocked_for_user_decision');assert.equal(project.desktop_phase,'desktop-implement');
  const draft='bloma-composer/drafts/draft-'+manifest.parent_session_id+'.json';
  const actual=path.join(row.home,draft),canonical=path.join(cohort,'snapshot/home',draft);
  const before=read(actual),source=read(canonical);const {revision:a,...beforeFields}=before;const {revision:b,...sourceFields}=source;
  assert.equal(before.text,'');assert.deepEqual(before.attachment_refs,[]);assert.deepEqual(beforeFields,sourceFields);
  draftChanges.push({group:row.group,before,restored:source,sha256_before:sha(actual),sha256_restored:sha(canonical)});
  fs.copyFileSync(canonical,actual);
  platform.push({group:row.group,send_enabled:true,renderer_ready:true,parent_unchanged:true,current_stage:project.current_stage,desktop_phase:project.desktop_phase,model_calls:0});
  console.log(JSON.stringify({group:row.group,platform:'ready',model_calls:0}));
 }finally{if(application)await application.close();}
}
put(path.join(evidence,'ui-qualification-draft-changes-'+version+'.json'),{at:new Date().toISOString(),reason:'Restore unsent empty draft revision changed by qualification only; preserve before values.',rows:draftChanges});
put(path.join(evidence,'platform-'+version+'-ready.json'),platform);
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(dir,entry.name)):[path.join(dir,entry.name)]);
const runtimeFiles=Object.fromEntries(['dist','dist-main'].flatMap(dir=>walk(path.join(runtime,dir))).map(p=>[path.relative(runtime,p).replaceAll('\\','/'),sha(p)]));
const drivers=['dispatch-experiment-native.mjs','seed-experiment-channels.cjs','dispatch-experiment-native-control.mjs','dispatch-experiment-native-choices.mjs','dispatch-experiment-supervisor.mjs'];
const runtimeManifest={runtime_root:runtime,commit:execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim(),main_sha256:sha(path.join(runtime,'dist-main/main/index.js')),package_lock_sha256:sha(path.join(runtime,'package-lock.json')),node_modules_lock_sha256:sha(path.join(runtime,'node_modules/.package-lock.json')),runtime_files:runtimeFiles,driver_files:Object.fromEntries(drivers.map(name=>['scripts/'+name,sha(path.join(runtime,'scripts',name))]))};
const envNote='共同环境交接：平台骨架与 .venv 已准备并验证可启动，确切环境记录见 00_ENV/common-environment.json 和 requirements.lock。请先使用既有环境和本轮已确认 PRD、草图；仅在实际需要时调整依赖，正常完成业务实现与验证。';
const rows=registry.matrix.map(row=>{
 const changed=Object.entries(manifest.files).filter(([relative,hash])=>!['projects.json','bloma-agent-sessions.json'].includes(relative)&&sha(path.join(row.home,relative))!==hash).map(([p])=>p);assert.deepEqual(changed,[]);
 const config=read(path.join(row.home,'dispatch-experiments',registry.project_id+'.json'));
 const environment=read(path.join(evidence,'env-'+version,row.group,'report.json'));
 assert.equal(environment.outcome,'ready');assert.equal(environment.gui_smoke.passed,true);assert.equal(environment.inherited_version_match,true);
 assert.equal(config.runtime_hash,runtimeManifest.main_sha256);assert.equal(config.input_hash,registry.input_hash);
 const channels=read(path.join(row.home,'bloma-channels.json')).channels;const glm=channels.find(c=>c.provider_type==='zhipu-coding');assert(glm);
 const effectiveBindings=Object.fromEntries(Object.entries(config.models).map(([role,binding])=>{
   const channel=channels.find(c=>c.id===binding.channel_id),model=channel?.models.find(m=>m.id===binding.model_id);
   assert(channel?.enabled && model?.enabled);assert.equal(model.name,binding.model_id,'Upstream selector must be exact for '+role);
   return [role,{channel_id:channel.id,model:model.name,provider:channel.provider_type,base_url:channel.base_url}];
 }));
 const continuation=path.join(row.home,'continuation.txt');assert(fs.readFileSync(continuation,'utf8').startsWith(envNote+'\n'));
 return{group:row.group,input_hash:config.input_hash,runtime_hash:config.runtime_hash,evaluator_hash:config.evaluator_hash,environment_ready:true,packages_sha256:environment.packages_sha256,python_sha256:environment.interpreter_sha256,platform_ready:platform.find(p=>p.group===row.group),changed_frozen_files:changed,model_calls:0,stage:'blocked_for_user_decision',phase:'desktop-implement',glm_provider:glm.provider_type,effective_bindings:effectiveBindings,continuation_sha256:sha(continuation),passed:true};
});
for(const key of ['input_hash','runtime_hash','evaluator_hash','packages_sha256','python_sha256'])assert.equal(new Set(rows.map(row=>row[key])).size,1,key);
const release={at:new Date().toISOString(),kind:'before-first-model-execution',protocol_revision:'production-v2-supervised',passed:true,runtime:runtimeManifest,rows};
put(path.join(evidence,'isolated-runtime-'+version+'-manifest.json'),runtimeManifest);
put(path.join(cohort,'readiness-release.json'),release);put(path.join(evidence,'readiness-'+version+'.json'),release);
registry.worktree_isolation=true;registry.runtime_root=runtime;fs.writeFileSync(path.join(cohort,'registry.json'),JSON.stringify(registry,null,2));
console.log(JSON.stringify({passed:true,groups:rows.length,model_calls:0,input_hash:registry.input_hash,runtime_files:Object.keys(runtimeFiles).length}));

/** Genuine local ASR + Node bridge + native browser acceptance. No microphone
 * or paid endpoints. Installs pinned dependencies only in an owned short home;
 * existing public model assets are validated and read without downloading. */
import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, cpSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
const root=resolve('.'),folder=join(root,'run-artifacts/capability-native-20261027'),home=mkdtempSync(join(tmpdir(),'bcap-'))
mkdirSync(folder,{recursive:true})
const helper=join(folder,'fixture/main/capability-fixture-runtime.mjs')
const seed=process.env.BLOMA_CAPABILITY_FIXTURE_SEED
if(seed){const rel=relative(tmpdir(),resolve(seed));if(isAbsolute(rel)||rel.startsWith('..')||!/^bcap-/.test(basename(dirname(dirname(resolve(seed))))))throw Error('Only owned short-home fixture dependencies may be reused')}
mkdirSync(dirname(helper),{recursive:true})
cpSync(join(root,'main/templates'),join(dirname(helper),'templates'),{recursive:true,filter:path=>!path.split(/[\\/]/).includes('__pycache__')})
await build({stdin:{resolveDir:root,sourcefile:'capability-real-fixture.ts',contents:`
import{mkdirSync,writeFileSync,readFileSync,copyFileSync,cpSync}from'node:fs';import{join}from'node:path';import{createServer}from'node:net';
import{createProject,updateProject}from'./main/project/project-service';import{readPrdBackplane,markPrdUserConfirmed}from'./main/project/prd-store';
import{syncDocuments}from'./main/project/document-sync';import{parseLeanBrief}from'./main/guide/lean-brief';import{prdScopeFingerprint}from'./main/project/requirement-contract';
import{prepareSpeechCapability}from'./main/software/capability-tools';import{registerNativeGuiTests}from'./main/software/native-gui-registration';
import{verifySoftwareCandidate,recentSoftwareVerification}from'./main/software/verification';import{executeSoftwareCommand}from'./main/software/command-runtime';
import{speechCapabilityBinding}from'./main/software/capability-bindings';import{closeAllDebugSessions}from'./main/software/debug-sessions';
const home=process.env.PROMA_HOME,folder=process.argv[2],report={home,scope:'real pinned local ASR; Node/Python bridge and browser UI; no microphone or paid model',checks:[],errors:[]};
const p=createProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'}),root=join(home,'app');mkdirSync(root);updateProject(p.project_id,{root_path:root});
if(process.env.BLOMA_CAPABILITY_FIXTURE_SEED){cpSync(process.env.BLOMA_CAPABILITY_FIXTURE_SEED,join(root,'.venv'),{recursive:true});report.dependencies_reused_from_owned_fixture=true;}
const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'文件语音转写',ui:'required',delivery:'browser',requirements:[
 {description:'导入语音文件并转写',expected:'显示真实识别文字并在重开后保留',capabilities:['speech']},
 {description:'无效音频提示错误',expected:'无效音频不能覆盖原有识别结果'}]}),{projectId:p.project_id,sessionId:'s',source:'导入语音文件转写',previous:readPrdBackplane(p.project_id),software:true});
parsed.brief.lean_brief.preview='skip';syncDocuments({request_id:'sync',project_id:p.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);
const brief=markPrdUserConfirmed(p.project_id),scope=prdScopeFingerprint(brief);updateProject(p.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}});
const signal=AbortSignal.timeout(900000);
try{
 console.log('Preparing owned Python ASR provider; existing model cache is read-only.');
 report.preparation=await prepareSpeechCapability(p.project_id,root,signal,{install_dependencies:true,download_models:false});
 if(report.preparation.status!=='prepared')throw Error('Preparation did not produce a real fixed-audio result: '+JSON.stringify(report.preparation));
 report.checks.push('prepared pinned dependencies and components with real 3-shape decoding, no microphone');
 const server=createServer();await new Promise(done=>server.listen(0,'127.0.0.1',done));const port=server.address().port;await new Promise(done=>server.close(done));
 writeFileSync(join(root,'index.html'),'<meta charset="utf-8"><title>ASR real fixture</title><input id="file" type="file"><button id="run">转写</button><output id="status"></output><pre id="last"></pre><script>fetch("/last").then(r=>r.text()).then(t=>document.querySelector("#last").textContent=t);document.querySelector("#run").onclick=async()=>{document.querySelector("#status").textContent="识别中";try{const file=document.querySelector("#file").files[0];const r=await fetch("/transcribe",{method:"POST",body:file}),v=await r.json();if(!v.ok)throw Error(v.error);document.querySelector("#last").textContent=v.text;document.querySelector("#status").textContent="完成"}catch(e){document.querySelector("#status").textContent="错误："+e.message}}</script>');
 writeFileSync(join(root,'server.cjs'),String.raw\`const http=require('http'),fs=require('fs'),path=require('path'),{transcribeWav}=require('./speech_bridge.cjs');const saved=path.join(process.env.APP_DATA_DIR,'last.txt');http.createServer(async(q,s)=>{if(q.url==='/last'){s.end(fs.existsSync(saved)?fs.readFileSync(saved):'');return;}if(q.url==='/transcribe'){try{const chunks=[];let size=0;for await(const bytes of q){if((size+=bytes.length)>1024*1024)throw Error('fixture input too large');chunks.push(bytes)}const file=path.join(process.env.APP_DATA_DIR,'input.wav');fs.writeFileSync(file,Buffer.concat(chunks));const text=await transcribeWav(file);fs.writeFileSync(saved,text);s.setHeader('Content-Type','application/json');s.end(JSON.stringify({ok:true,text}));}catch(e){s.setHeader('Content-Type','application/json');s.end(JSON.stringify({ok:false,error:e.message}));}return;}s.setHeader('Content-Type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'))}).listen(Number(process.argv[2]),'127.0.0.1');\`);
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','server.cjs',String(port)],url:'http://127.0.0.1:'+port}));
 writeFileSync(join(root,'CORE_CHECK.json'),JSON.stringify({schema_version:2,speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe',rate_argument:true}}));
 mkdirSync(join(root,'tests'));copyFileSync(join(process.cwd(),'main/templates/tools/voice-golden.wav'),join(root,'tests/voice.wav'));
 writeFileSync(join(root,'tests/acceptance.mjs'),String.raw\`import{readFileSync}from'node:fs';export default async({test,page,expect,phase})=>{
 const sentence=/^我们下周四下午(?:三|3)点开会[。.]?$/;
 if(phase==='reopened'){await test('F-001 reopen',async()=>{await expect(page.locator('#last')).toHaveText(sentence)});return;}
 await test('F-001 real ASR',async()=>{await page.locator('#file').setInputFiles({name:'voice.wav',mimeType:'audio/wav',buffer:readFileSync(new URL('./voice.wav',import.meta.url))});await page.locator('#run').click();await expect(page.locator('#status')).toHaveText('识别中');await expect(page.locator('#last')).toHaveText(sentence,{timeout:45000})});
 await test('F-002 bad WAV',async()=>{await page.locator('#file').setInputFiles({name:'bad.wav',mimeType:'audio/wav',buffer:Buffer.from('bad')});await page.locator('#run').click();await expect(page.locator('#status')).toContainText('错误',{timeout:15000});await expect(page.locator('#last')).toHaveText(sentence)});}\`);
 registerNativeGuiTests(p.project_id,'tests/acceptance.mjs');console.log('Running actual browser -> Node bridge -> local ASR and persistence checks.');
 report.positive=await verifySoftwareCandidate(p.project_id,'capability-real',signal);if(report.positive.status!=='passed')throw Error(JSON.stringify({summary:report.positive.summary,core:report.positive.core}));
 report.checks.push('real browser upload/Node bridge/Python ASR, invalid audio and actual reopen');
 const data=join(home,'bridge-data');mkdirSync(data);copyFileSync(join(root,'tests/voice.wav'),join(data,'voice.wav'));
 const timed=await executeSoftwareCommand({projectId:p.project_id,root,dataDir:data,command:['node','-e',"require('./speech_bridge.cjs').transcribeWav(process.argv[1],{timeoutMs:100}).then(()=>process.exit(8),e=>{console.log(e.message);process.exit(e.message==='ASR_WORKER_TIMEOUT'?0:9)})",join(data,'voice.wav')],timeoutMs:15000});
 if(timed.code!==0)throw Error('Bounded bridge timeout failed: '+timed.stdout+timed.stderr);report.checks.push('bounded worker timeout reaps only its owned process tree');
 const original=readFileSync(join(root,'speech_runtime.py'));writeFileSync(join(root,'speech_runtime.py'),'class SpeechEngine:\\n def transcribe(self,samples,rate=16000): return "我们下周四下午三点开会"\\n');
 console.log('Running counterexample: constant text must not satisfy actual ASR evidence.');
 report.fake=await verifySoftwareCandidate(p.project_id,'capability-fake',signal,true);if(report.fake.status==='passed'||report.fake.core?.speech?.real_decode_calls!==0)throw Error('Fake ASR was not rejected: '+JSON.stringify(report.fake.core));
 writeFileSync(join(root,'speech_runtime.py'),original);if(await recentSoftwareVerification(p.project_id,'capability-real'))throw Error('Old PASS revived after failed ASR');report.checks.push('fake transcription rejected despite matching text; old PASS remains invalid');
 report.projectId=p.project_id;report.binding=speechCapabilityBinding(p.project_id);report.model_requests=0;
}catch(error){report.errors.push(String(error));throw error}finally{await closeAllDebugSessions();writeFileSync(join(folder,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({checks:report.checks,errors:report.errors,home,model_requests:0},null,2));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron','playwright','typescript'],logLevel:'silent'})
const env={...process.env,PROMA_HOME:home,BLOMA_SPEECH_MODEL_DIR:process.env.BLOMA_SPEECH_MODEL_DIR||join(homedir(),'.proma/speech-models/sensevoice-int8'),BLOMA_DISPATCH_EXPERIMENT:'0'}
const child=spawn(process.execPath,[helper,folder],{cwd:root,env,stdio:'inherit',windowsHide:true})
await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?done():reject(Error('Capability real-process fixture exited '+code)))})

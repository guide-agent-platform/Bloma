import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:net'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject,updateProject} from '../../../main/project/project-service'
import {startCorrectionSession,readCorrectionPicks,finishCorrectionSession,settleCorrectionTeardown} from '../../../main/desktop/correction-session'
import {activeSoftwareCorrectionPage} from '../../../main/software/correction-runtime'
import {readCorrectionSubmission} from '../../../main/desktop/correction-outbox'
import {startSoftwareProcess,stopSoftwareSession,softwareProcess} from '../../../main/software/process-manager'
import {parseLeanBrief} from '../../../main/guide/lean-brief'
import {readPrdBackplane,markPrdUserConfirmed} from '../../../main/project/prd-store'
import {syncDocuments} from '../../../main/project/document-sync'
import {prdScopeFingerprint} from '../../../main/project/requirement-contract'
import {launchSoftwareTrial,softwareTrial,closeSoftwareTrial,trialFeedbackText} from '../../../main/software/trial'
import {verificationFingerprint} from '../../../main/desktop/verification-fingerprint'
import {registerProjectDeliverablesIpc} from '../../../main/ipc/project-deliverables'
import {IPC_CHANNELS} from '../../../shared/types'
let home:string,old:string|undefined,project:ReturnType<typeof createProject>,url:string,port:number
beforeEach(async()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-browser-picks-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'});updateProject(project.project_id,{status:'completed',current_stage:'completed'})
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const addr=server.address();if(!addr||typeof addr==='string')throw Error('port');port=addr.port;await new Promise<void>(done=>server.close(()=>done()));url=`http://127.0.0.1:${port}`
  writeFileSync(join(project.root_path,'server.cjs'),`const fs=require('node:fs'),path=require('node:path');require('node:http').createServer((q,s)=>{if(q.url==='/change'){fs.writeFileSync(path.join(process.env.APP_DATA_DIR,'record.txt'),'preview-only');s.end('changed');return;}s.setHeader('content-type','text/html;charset=utf-8');s.end(fs.readFileSync('index.html'))}).listen(Number(process.env.PORT||process.argv[2]),'127.0.0.1')`)
  writeFileSync(join(project.root_path,'index.html'),'<html><title>点选修改测试</title><body style="font:20px sans-serif;padding:40px"><h1>我的应用</h1><button id="save" onclick="this.textContent=\'BUSINESS CLICK\'">保存</button></body></html>')
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',url,command:['node','server.cjs',String(port)]}))
})
afterEach(async()=>{finishCorrectionSession({projectId:project.project_id,discard:true});await settleCorrectionTeardown(project.project_id)
  await stopSoftwareSession(project.project_id,'original-user');const trial=softwareTrial(project.project_id);if(trial)await closeSoftwareTrial(project.project_id,trial.release_id)
  if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})},30000)
async function select(){const page=activeSoftwareCorrectionPage(project.project_id)!;await page.locator('#save').click();expect(await page.locator('#save').innerText()).toBe('保存');await page.getByLabel('修改意见').fill('把保存按钮改成紫色');await page.getByRole('button',{name:'记录这处修改'}).click();await expect.poll(()=>readCorrectionPicks({projectId:project.project_id}).picks.length).toBe(1);await page.getByRole('button',{name:'完成点选'}).click();return page}
it('refuses data links before starting a correction process',async()=>{
  const data=join(home,'software-app-data',project.project_id,'data'),outside=join(home,'separate-data');mkdirSync(data,{recursive:true});mkdirSync(outside);writeFileSync(join(outside,'record.txt'),'untouched');symlinkSync(outside,join(data,'linked'),'junction')
  const result=await startCorrectionSession({projectId:project.project_id});expect(result).toMatchObject({ok:false,reason:'spawn-failed'});expect(!result.ok&&result.error).toContain('DATA_SNAPSHOT_LINK_UNSUPPORTED')
  expect(activeSoftwareCorrectionPage(project.project_id)).toBeUndefined();expect(readFileSync(join(outside,'record.txt'),'utf8')).toBe('untouched')
})
it('opens a real browser on a separate owned port, captures user picks and preserves the running app/data',async()=>{
  const data=join(home,'software-app-data',project.project_id,'data');mkdirSync(data,{recursive:true});writeFileSync(join(data,'record.txt'),'user-original')
  const original=await startSoftwareProcess({projectId:project.project_id,root:project.root_path,sessionId:'original-user',command:['node','server.cjs',String(port)],url,dataDir:data,purpose:'user'})
  const before=verificationFingerprint(project.root_path),started=await startCorrectionSession({projectId:project.project_id});expect(started.ok,JSON.stringify(started)).toBe(true)
  const page=await select();expect(new URL(page.url()).port).not.toBe(String(port));await page.evaluate(()=>fetch('/change'))
  await page.screenshot({path:resolve('run-artifacts/correction-browser-20261101.png')})
  const result=finishCorrectionSession({projectId:project.project_id});await settleCorrectionTeardown(project.project_id)
  expect(result.feedback).toContain('#save');expect(result.feedback).toContain('紫色');expect(readCorrectionSubmission(project.project_id)?.id).toBe(result.feedback_id)
  expect(readFileSync(join(data,'record.txt'),'utf8')).toBe('user-original');expect(softwareProcess(project.project_id,original.id,'original-user').state).toBe('running')
  expect(verificationFingerprint(project.root_path)).toBe(before)
},60000)
it('allows correction of the frozen visible trial before delivery and retains that version through outbox recovery',async()=>{
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'保存',delivery:'browser',ui:'required',requirements:[{description:'显示保存按钮',expected:'显示保存按钮'}]}),{projectId:project.project_id,sessionId:'s',source:'保存',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('brief');parsed.brief.lean_brief!.preview='skip';syncDocuments({request_id:'s',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const scope=prdScopeFingerprint(markPrdUserConfirmed(project.project_id)!);updateProject(project.project_id,{status:'active',current_stage:'generating_mvp',ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  const launched=await launchSoftwareTrial(project.project_id);expect(launched.started,launched.detail).toBe(true);const version=launched.trial!.release_id
  // The maker may continue editing. Correction must inspect the frozen version
  // the user saw, not demand that working bytes still equal that old candidate.
  writeFileSync(join(project.root_path,'index.html'),'<h1>new unfinished working version</h1>')
  writeFileSync(join(project.root_path,'LAUNCH.json'),'{unfinished')
  const handlers=new Map<string,(event:unknown,payload:unknown)=>Promise<any>>()
  registerProjectDeliverablesIpc({handle:(name:string,handler:(event:unknown,payload:unknown)=>Promise<any>)=>handlers.set(name,handler)} as never,{} as never)
  const visible=await handlers.get(IPC_CHANNELS.PROJECT_DELIVERABLES)!({}, {request_id:'read',project_id:project.project_id})
  expect(visible.ok,JSON.stringify(visible)).toBe(true);expect(visible.data).toMatchObject({supports_point_selection:true,point_selection_version:version,launch:{parse_ok:false}})
  expect(await startCorrectionSession({projectId:project.project_id,observedVersion:'0'.repeat(64)})).toMatchObject({ok:false,reason:'launch-invalid'})
  expect(await startCorrectionSession({projectId:project.project_id})).toMatchObject({ok:false,reason:'not-delivered'})
  const correction=await startCorrectionSession({projectId:project.project_id,observedVersion:version});expect(correction.ok,JSON.stringify(correction)).toBe(true);await select()
  const finished=finishCorrectionSession({projectId:project.project_id});await settleCorrectionTeardown(project.project_id)
  expect(finished.observed_software_version).toBe(version);expect(finishCorrectionSession({projectId:project.project_id,recover:true}).observed_software_version).toBe(version)
  expect(trialFeedbackText(project.project_id,version,finished.feedback!)).toContain('用户所见试用版本');expect(softwareTrial(project.project_id)?.state).toBe('running')
},90000)

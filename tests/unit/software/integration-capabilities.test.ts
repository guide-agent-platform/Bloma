import {createRequire} from 'node:module'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs'
import {join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {prepareSoftwareRelease,validateSoftwareRelease} from '../../../main/software/release-store'
import {executeSoftwareCommand} from '../../../main/software/command-runtime'
const require=createRequire(import.meta.url),ocr=require('../../../main/templates/tools/ocr_runtime.cjs')
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-integrations-'));process.env.PROMA_HOME=home;project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})},30000)
const ctx=()=>({projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(60000),state:createToolState()})
const tools=()=>buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
it('prepares HTTP components without credentials or requests, exposes both topics and protects existing files and role boundaries',async()=>{
 const all=tools(),prepare=all.find(tool=>tool.name==='prepare_software_capability')!
 const result=await prepare.execute({capability:'http'},ctx());expect(result.isError,result.output).not.toBe(true)
 expect(JSON.parse(result.output)).toMatchObject({status:'prepared',product_verification:'unverified',external_effects:'unverified'})
 for(const topic of ['http-integration','multimodal'])expect((await all.find(tool=>tool.name==='read_production_context')!.execute({topic},ctx())).isError).not.toBe(true)
 writeFileSync(join(project.root_path,'http_connector.cjs'),'user source')
 expect((await prepare.execute({capability:'http'},ctx())).isError).toBe(true);expect(readFileSync(join(project.root_path,'http_connector.cjs'),'utf8')).toBe('user source')
 expect((await prepare.execute({capability:'http',language:'zh-Hans-CN'},ctx())).isError).toBe(true)
 expect((await prepare.execute({capability:'ocr',download_models:true},ctx())).isError).toBe(true)
 const research=buildSoftwareAgentTools(project.project_id,'research',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
 expect(research.some(tool=>tool.name==='prepare_software_capability')).toBe(false)
})
it.skipIf(process.platform!=='win32')('performs real Windows OCR from a frozen product, rejects missing languages and malformed input, and retains source identity',async()=>{
 const root=project.root_path,all=tools(),prepare=all.find(tool=>tool.name==='prepare_software_capability')!,context=ctx()
 const prepared=await prepare.execute({capability:'ocr'},context);expect(prepared.isError,prepared.output).not.toBe(true)
 const facts=JSON.parse(prepared.output),language=facts.runtime.languages[0];expect(typeof language).toBe('string')
 const missing=await prepare.execute({capability:'ocr',language:'zz-ZZ'},context);expect(missing.isError).toBe(true);expect(JSON.parse(missing.output).ready).toBe(false)
 const data=join(home,'image-data');mkdirSync(data)
 const {createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(1000,200),drawing=canvas.getContext('2d')
 drawing.fillStyle='white';drawing.fillRect(0,0,1000,200);drawing.fillStyle='black';drawing.font='54px Microsoft YaHei';drawing.fillText('集成测试 7263',30,100)
 const image=join(data,'printed.png');writeFileSync(image,canvas.toBuffer('image/png'))
 writeFileSync(join(root,'read.cjs'),`const path=require('node:path');require('./ocr_runtime.cjs').recognizeImage(path.join(process.env.APP_DATA_DIR,'printed.png'),{dataDir:process.env.APP_DATA_DIR,language:${JSON.stringify(language)}}).then(r=>console.log(JSON.stringify(r))).catch(e=>{console.error(e);process.exitCode=1})`)
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','read.cjs']}))
 const candidate=await prepareSoftwareRelease(project.project_id,root),run=await executeSoftwareCommand({projectId:project.project_id,root:candidate.root,dataDir:data,command:['node','read.cjs'],signal:context.signal})
 expect(run.code,run.stderr).toBe(0);const actual=JSON.parse(run.stdout.trim());expect(actual.text.replace(/\s/g,'')).toBe('集成测试7263');expect(actual.lines[0].words[0].width).toBeGreaterThan(0)
 const outside=join(home,'outside.png');writeFileSync(outside,canvas.toBuffer('image/png'))
 await expect(ocr.recognizeImage(outside,{dataDir:data,language})).rejects.toThrow('OUTSIDE_DATA_DIR')
 writeFileSync(join(data,'bad.png'),'not image bytes');await expect(ocr.recognizeImage(join(data,'bad.png'),{dataDir:data,language})).rejects.toThrow('OCR_UNAVAILABLE')
 drawing.fillStyle='white';drawing.fillRect(0,0,1000,200);writeFileSync(join(data,'blank.png'),canvas.toBuffer('image/png'))
 const blank=await ocr.recognizeImage(join(data,'blank.png'),{dataDir:data,language});expect(blank.status).toBe('no_text')
 const abort=new AbortController();abort.abort();await expect(ocr.recognizeImage(image,{dataDir:data,language,signal:abort.signal})).rejects.toThrow()
 expect(readdirSync(data).some(name=>name.startsWith('.ocr-'))).toBe(false)
 await validateSoftwareRelease(project.project_id,candidate)
 const evidence=resolve('run-artifacts/multimodal-http-20261029');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'real-ocr.json'),JSON.stringify({actual,blank,paid_requests:0,scope:'fixed printed image, Windows installed language, real product process; not general accuracy or AI quality'},null,2))
},60000)
it.skipIf(process.platform!=='win32')('combines actual image OCR, a product JSON API call and duplicate webhook handling in one frozen backend',async()=>{
 const root=project.root_path,context=ctx(),prepare=tools().find(tool=>tool.name==='prepare_software_capability')!
 for(const capability of ['ocr','http']){const result=await prepare.execute({capability},context);expect(result.isError,result.output).not.toBe(true)}
 const languages=JSON.parse((await tools().find(tool=>tool.name==='inspect_software_capabilities')!.execute({capability:'ocr'},context)).output).runtime.languages
 const data=join(home,'workflow-data');mkdirSync(data)
 const {createCanvas}=require('@napi-rs/canvas'),image=createCanvas(1000,200),drawing=image.getContext('2d');drawing.fillStyle='white';drawing.fillRect(0,0,1000,200);drawing.fillStyle='black';drawing.font='54px Microsoft YaHei';drawing.fillText('集成测试 7263',30,100);writeFileSync(join(data,'input.png'),image.toBuffer('image/png'))
 const calls:Array<{text:string;auth?:string}>=[]
 const api=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));calls.push({text:input.text,auth:request.headers.authorization});response.setHeader('Content-Type','application/json');response.end(JSON.stringify({id:'receipt-7263'}))})
 await new Promise<void>(done=>api.listen(0,'127.0.0.1',done));const address=api.address();if(!address||typeof address==='string')throw Error('port')
 writeFileSync(join(root,'workflow.cjs'),`const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),{createHmac}=require('node:crypto');const {recognizeImage}=require('./ocr_runtime.cjs'),{createHttpConnector}=require('./http_connector.cjs'),{createWebhookInbox}=require('./webhook_inbox.cjs');
 (async()=>{const data=process.env.APP_DATA_DIR,ocr=await recognizeImage(path.join(data,'input.png'),{dataDir:data,language:${JSON.stringify(languages[0])}}),api=createHttpConnector({baseUrl:process.argv[2],network:'loopback',methods:['POST'],auth:{header:'Authorization',value:'Bearer local-product-token'}}),created=await api.request('records',{method:'POST',body:{text:ocr.text}});if(!created.ok)throw Error(created.kind);const secret='local-webhook-secret-7263',inbox=createWebhookInbox(data);let effects=0;const receiver=http.createServer(async(req,res)=>{const parts=[];for await(const c of req)parts.push(c);const input=JSON.parse(Buffer.concat(parts)),rawBody=Buffer.from(input.raw,'utf8'),eventId=JSON.parse(input.raw).id,accepted=inbox.accept({secret,rawBody,timestamp:input.timestamp,signature:input.signature,eventId});if(accepted.accepted){effects++;fs.writeFileSync(path.join(data,'effect.txt'),String(effects));inbox.markDone(accepted.receipt)}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accepted:accepted.accepted,kind:accepted.kind||'applied'}))});await new Promise(done=>receiver.listen(0,'127.0.0.1',done));try{const timestamp=String(Math.floor(Date.now()/1000)),raw=JSON.stringify({id:created.data.id,text:ocr.text}),signature='sha256='+createHmac('sha256',secret).update(timestamp+'.').update(raw).digest('hex'),hook=createHttpConnector({baseUrl:'http://127.0.0.1:'+receiver.address().port+'/',network:'loopback',methods:['POST']}),body={raw,timestamp,signature};const first=await hook.request('hook',{method:'POST',body}),second=await hook.request('hook',{method:'POST',body});console.log(JSON.stringify({text:ocr.text,api:created.data,first:first.data,second:second.data,effects,source_sha256:ocr.source_sha256}))}finally{receiver.closeAllConnections();await new Promise(done=>receiver.close(done))}})().catch(e=>{console.error(e);process.exitCode=1})`)
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','workflow.cjs']}))
 try{
  const candidate=await prepareSoftwareRelease(project.project_id,root),actual=await executeSoftwareCommand({projectId:project.project_id,root:candidate.root,dataDir:data,command:['node','workflow.cjs',`http://127.0.0.1:${address.port}/`],signal:context.signal})
  expect(actual.code,actual.stderr).toBe(0);const result=JSON.parse(actual.stdout.trim());expect(result).toMatchObject({api:{id:'receipt-7263'},first:{accepted:true,kind:'applied'},second:{accepted:false,kind:'duplicate_done'},effects:1})
  expect(calls).toHaveLength(1);expect(calls[0].text.replace(/\s/g,'')).toBe('集成测试7263');expect(calls[0].auth).toBe('Bearer local-product-token')
  await validateSoftwareRelease(project.project_id,candidate)
  const evidence=resolve('run-artifacts/multimodal-http-20261029');mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,'workflow.json'),JSON.stringify({result,api_calls:calls.length,paid_requests:0,scope:'actual Windows OCR and product modules; controlled local external service and webhook convention, no real account integration'},null,2))
 }finally{api.closeAllConnections();await new Promise<void>(done=>api.close(()=>done()))}
},60000)

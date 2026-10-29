import {createRequire} from 'node:module'
import {createServer} from 'node:http'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {runHostLlmProbe} from '../../../main/desktop/llm-verification'
import {prepareSoftwareRelease,validateSoftwareRelease} from '../../../main/software/release-store'
const require=createRequire(import.meta.url),{VisionClient}=require('../../../main/templates/tools/vision_client.cjs')
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-vision-'));process.env.PROMA_HOME=home;project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const ctx=()=>({projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(30000),state:createToolState()})
it('prepares product vision without a supplier request and checks actual images and changed images from the frozen candidate',async()=>{
 const root=project.root_path,tools=buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,root,'s'))
 const prepared=await tools.find(t=>t.name==='prepare_software_capability')!.execute({capability:'vision'},ctx())
 expect(prepared.isError,prepared.output).not.toBe(true);expect(JSON.parse(prepared.output)).toMatchObject({status:'prepared',external_effects:'unverified'})
 expect((await tools.find(t=>t.name==='read_production_context')!.execute({topic:'vision'},ctx())).isError).not.toBe(true)
 writeFileSync(join(root,'app.cjs'),'console.log("vision fixture")');writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}))
 const candidate=await prepareSoftwareRelease(project.project_id,root)
 const actual=await runHostLlmProbe(candidate.root,{runtime:'node',module:'vision_client.cjs',factory:'VisionClient',method:'analyze',input:'vision',covers:['F-001']},undefined,ctx().signal,project.project_id)
 expect(actual.status,JSON.stringify(actual)).toBe('passed');expect(actual.request_count).toBe(6);expect(actual.tests).toHaveLength(7)
 expect(actual.tests?.find(row=>row.name==='image_changed')?.passed).toBe(true)
 await validateSoftwareRelease(project.project_id,candidate)
 writeFileSync(join(root,'fake.cjs'),`const{VisionClient}=require('./vision_client.cjs');exports.Fake=class extends VisionClient{async analyze(input){this.first??=input.images;return super.analyze({...input,images:this.first})}}`)
 const rejected=await runHostLlmProbe(root,{runtime:'node',module:'fake.cjs',factory:'Fake',method:'analyze',input:'vision',covers:['F-001']},undefined,ctx().signal,project.project_id)
 expect(rejected.status,JSON.stringify(rejected)).toBe('failed');expect(rejected.tests?.find(row=>row.name==='image_changed')?.passed).toBe(false)
},45000)
it('sends original local image bytes and never sends out-of-scope, invalid or unconfigured images',async()=>{
 const requests:any[]=[],server=createServer(async(req,res)=>{const chunks=[];for await(const chunk of req)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'controlled answer, not real visual reasoning'}}]}))})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('port')
 const data=join(home,'data');mkdirSync(data);const{createCanvas}=require('@napi-rs/canvas'),canvas=createCanvas(2,2),drawing=canvas.getContext('2d');drawing.fillStyle='red';drawing.fillRect(0,0,2,2);const bytes=canvas.toBuffer('image/png');writeFileSync(join(data,'red.png'),bytes);writeFileSync(join(home,'outside.png'),bytes);writeFileSync(join(data,'bad.png'),'file-name-is-not-an-image')
 const client=new VisionClient(),config={endpoint:`http://127.0.0.1:${address.port}/v1`,network:'loopback',model:'local-vision',api_key:'product-local-key'}
 try{
  const invoke=(file:string,other=config)=>client.analyze({prompt:'比较颜色',images:[file],dataDir:data,config:other})
  const result=await invoke(join(data,'red.png'));expect(result).toMatchObject({ok:true,kind:'success',input_images:[{media_type:'image/png',sha256:expect.stringMatching(/^[a-f0-9]{64}$/)}]})
  expect(requests[0].messages[0].content[1].image_url.url).toBe('data:image/png;base64,'+bytes.toString('base64'))
  expect((await invoke(join(home,'outside.png'))).ok).toBe(false);expect((await invoke(join(data,'bad.png'))).ok).toBe(false)
  expect(await invoke(join(data,'red.png'),{...config,api_key:''})).toMatchObject({ok:false,kind:'unconfigured'})
  expect(requests).toHaveLength(1)
  const controller=new AbortController();controller.abort();expect(await client.analyze({prompt:'x',images:[join(data,'red.png')],dataDir:data,config,signal:controller.signal})).toMatchObject({ok:false,kind:'cancelled'})
  expect(requests).toHaveLength(1)
 }finally{server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()))}
})

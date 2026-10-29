import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {createToolState} from '../../../main/agent/loop/agent-loop'
import {createSoftwareCollaborationPolicy} from '../../../main/software/collaboration-policy'
import {buildSoftwareAgentTools} from '../../../main/software/agent-tools'
import {PRODUCT_FILES} from '../../../main/software/component-contracts'
import {changeImpact} from '../../../main/software/change-impact'
import {createRequire} from 'node:module'
const require=createRequire(import.meta.url)
let root:string,previous:string|undefined
beforeEach(()=>{root=mkdtempSync(join(tmpdir(),'bloma-product-prepare-'));previous=process.env.PROMA_HOME;process.env.PROMA_HOME=root})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(root,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
it.each(Object.keys(PRODUCT_FILES))('prepares and inspects %s through real public Agent tools without any service call',async capability=>{
 const project=createProject({mode:'quick',request_id:'prepare'},{workflowVersion:'software-v1'}),ctx={projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(30000),state:createToolState()},tools=buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
 for(const name of ['prepare_software_capability','inspect_software_capabilities']){const result=await tools.find(tool=>tool.name===name)!.execute({capability},ctx);expect(result.isError,result.output).not.toBe(true);expect(JSON.parse(result.output)).toMatchObject({capability,contract:{id:capability},product_verification:'unverified',runtime:{scope:'module_load_only'}})}
})
it('exposes alias/dynamic uncertainty and registered template tests while keeping formal verification unchanged',()=>{
 mkdirSync(join(root,'src'));writeFileSync(join(root,'src/a.ts'),'import value from "@/alias"; import(dynamicName)')
 const partial=changeImpact(root,['src/a.ts'],['src/a.ts'],AbortSignal.timeout(5000));expect(partial.partial).toBe(true);expect(partial.unresolved_specifiers[0]).toMatchObject({kind:'package_or_alias',specifier:'@/alias'});expect(partial.executed).toBe(false)
 const template='main/templates/components/jobs/product_jobs.cjs',test='tests/unit/software/product-foundation.test.ts'
 const found=changeImpact(resolve('.'),[template,test],[template],AbortSignal.timeout(5000));expect(found.registered_components).toContain('jobs');expect(found.suggested_tests).toContain(test);expect(found.formal_acceptance).toBe('unchanged_full_gate');expect(found.source_digest).toMatch(/^[a-f0-9]{64}$/)
})
it('queues and deduplicates a real five-file preview without exceeding the task key bound',async()=>{
 const project=createProject({mode:'quick',request_id:'batch'},{workflowVersion:'software-v1'}),ctx={projectId:project.project_id,sessionId:'s',requestId:'r',signal:AbortSignal.timeout(30000),state:createToolState()},tools=buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
 const prepared=await tools.find(tool=>tool.name==='prepare_software_capability')!.execute({capability:'workbench'},ctx);expect(prepared.isError,prepared.output).not.toBe(true)
 const data=join(root,'data');mkdirSync(data);const paths=Array.from({length:5},(_,index)=>{const file=join(root,'source-'+index+'.txt');writeFileSync(file,'真实资料 '+index);return file})
 const workbench=require(join(project.root_path,'product_workbench.cjs')).createWorkbench({dataDir:data,safeStorage:{isEncryptionAvailable:()=>false},dialog:{showOpenDialog:async()=>({canceled:false,filePaths:paths})},nativeImage:{}})
 try{
  const imported=await workbench.dispatch('selectFiles',{kind:'document'}),ids=imported.value.imported.map((row:any)=>row.id)
  const first=await workbench.dispatch('parse',{ids}),second=await workbench.dispatch('parse',{ids});expect(first.ok,JSON.stringify(first)).toBe(true);expect(second.value.id).toBe(first.value.id)
  const deadline=Date.now()+10000;let job
  while(Date.now()<deadline){job=(await workbench.dispatch('status')).value.jobs[0];if(['succeeded','failed'].includes(job.state))break;await new Promise(done=>setTimeout(done,20))}
  expect(job.state,JSON.stringify(job)).toBe('succeeded');const inspected=await workbench.dispatch('inspect',{id:job.result.previewId});expect(inspected.value.previewRows).toHaveLength(5)
 }finally{await workbench.close()}
})

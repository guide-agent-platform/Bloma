import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { prepareSoftwareRelease, promoteSoftwareRelease, type SoftwareRelease } from '../../../main/software/release-store'
import { qualityIdentity, qualityHash, saveQualityLedger, readQualityLedger, type Identity } from '../../../main/software/quality-ledger'
import { selectQualityCollaboration } from '../../../main/software/collaboration-selection'
import { createQualityReview } from '../../../main/software/quality-review'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'

let home: string, previous: string | undefined, project: ReturnType<typeof createProject>, release: SoftwareRelease, original: Identity
const baseCss='p { color: #111; padding: 4px; display: block; }'
beforeEach(async()=>{
  previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-select-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'显示件数',ui:'required',delivery:'browser',requirements:[{description:'显示件数',expected:'显示3件'}]}),{projectId:project.project_id,sessionId:'s',source:'显示件数',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');parsed.brief.lean_brief!.preview='skip'
  syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief)
  const brief=markPrdUserConfirmed(project.project_id)!,scope=prdScopeFingerprint(brief);updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  writeFileSync(join(project.root_path,'index.html'),'<link rel="stylesheet" href="theme.css"><p>3件</p>')
  writeFileSync(join(project.root_path,'theme.css'),baseCss);writeFileSync(join(project.root_path,'app.cjs'),'console.log(3)')
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,ui:'browser',command:['node','app.cjs'],url:'http://127.0.0.1:49123'}))
  original=await qualityIdentity(project.project_id);release=await prepareSoftwareRelease(project.project_id,project.root_path)
  // Controlled host metadata is only a selector fixture, not a GUI acceptance
  // claim. The separate production test creates a real verified C/V baseline.
  saveQualityLedger(project.project_id,{version:1,findings:[],reviews:[{id:'C',kind:'code',identity:original,status:'complete',at:new Date().toISOString()},
    {id:'V',kind:'visual',identity:original,status:'complete',at:new Date().toISOString(),child:'fixture-child',image:{imageId:'fixture-child/frozen.png',media_type:'image/png'},visual:{project:project.project_id,parent:'s',review:'V',candidate:qualityHash(original),image_hash:'a'.repeat(64),manifest_hash:'b'.repeat(64),expires:0},visual_delivery:{at:new Date().toISOString(),image_hash:'a'.repeat(64),request_hash:'c'.repeat(64)},visual_observations:[{scope:'controlled_selector_fixture'}]}]})
  await promoteSoftwareRelease(release,{version:'controlled-selector-fixture',scope,at:new Date().toISOString()})
})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const select=async()=>selectQualityCollaboration(project.project_id,await qualityIdentity(project.project_id))
it('requires full review without a verified baseline, and records an unchanged decision without calling any model',async()=>{
  const unchanged=await select();expect(unchanged).toMatchObject({risk:'unchanged',required:[],changed_count:0,baseline:release.id})
  await select();expect(readQualityLedger(project.project_id).collaboration).toHaveLength(1)
  unlinkSync(join(home,'software-releases',project.project_id,'active.json'))
  expect(await select()).toMatchObject({risk:'full',required:['code','visual']})
})
it('only drops C for bounded changes to existing cosmetic CSS declarations; V still requires a current image',async()=>{
  writeFileSync(join(project.root_path,'theme.css'),baseCss.replace('#111','#236').replace('4px','8px'))
  expect(await select()).toMatchObject({risk:'visual_only',required:['visual'],changed_paths:['theme.css']})
  const quality=createQualityReview(project.project_id,'s',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
  expect(await quality.gate()).toContain('VISUAL_REVIEW_REQUIRED')
  const context={projectId:project.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  await expect(quality.parentTools.find(t=>t.name==='inspect_collaboration_plan')!.execute({risk:'unchanged',required:[]},context)).rejects.toThrow('HOST_ONLY')
})
it.each([
  ['app.cjs','console.log(4)'],['theme.css',baseCss.replace('display: block','display: none')],['theme.css',baseCss.replace('p {','button {')],
  ['theme.css',baseCss.replace('#111','url(https://example.invalid/a)')],['theme.css','p { color: red'],['theme.css',baseCss+'p::before{content:"0件"}'],
  ['new.css','p{color:red}'],['package-lock.json','{}'],['README.md','new instructions'],['theme.css','p{color:red}/*'+ 'x'.repeat(33000)+'*/']
])('keeps full review for unknown/behavioral change in %s',async(path,content)=>{
  writeFileSync(join(project.root_path,path),content)
  expect(await select()).toMatchObject({risk:'full',required:['code','visual']})
})
it('does not accept stale selection, modified release bytes, or a confirmed target revision as low risk',async()=>{
  writeFileSync(join(project.root_path,'theme.css'),baseCss.replace('#111','#236'));expect((await select()).risk).toBe('visual_only')
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(7)');expect((await select()).risk).toBe('full')
  writeFileSync(join(release.root,'app.cjs'),'corrupted frozen bytes');expect((await select()).risk).toBe('full')
  const revised=readPrdBackplane(project.project_id);revised.positioning+='新目标';syncDocuments({request_id:'rev',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},revised)
  const scope=prdScopeFingerprint(markPrdUserConfirmed(project.project_id)!);updateProject(project.project_id,{ux_confirmation:{prd_fingerprint:scope,design_hash:scope,html_hash:null}})
  expect((await select()).required).toEqual(['code','visual'])
})
it('never uses a small-change choice to discharge an important reproduced finding',async()=>{
  const ledger=readQualityLedger(project.project_id)
  ledger.findings.push({id:'defect',review:'C',identity:original,requirement:'F-001',expected_source:'显示3件',category:'data',severity:'high',location:'app.cjs',trigger:'实际操作',evidence:'失败',reproduction:'host-case',unknowns:'',disposition:'confirmed',checks:[{at:new Date().toISOString(),identity:original,case_name:'host-case',rules:'frozen',outcome:'failed',observation:'controlled_host_fixture'}]})
  saveQualityLedger(project.project_id,ledger);writeFileSync(join(project.root_path,'theme.css'),baseCss.replace('#111','#236'))
  expect((await select()).risk).toBe('full')
  const quality=createQualityReview(project.project_id,'s',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
  expect(await quality.gate()).toMatch(/REVIEW_REQUIRED|FINDINGS_OPEN/)
})
it('rejects even a checksum-consistent full-review certificate that omits GUI visual review',async()=>{
  const ledger=readQualityLedger(project.project_id);ledger.reviews=ledger.reviews.filter(r=>r.kind!=='visual')
  const facts={version:1 as const,identity:original,baseline:release.id,risk:'full' as const,required:['code' as const],reasons:['controlled malformed certificate'],changed_paths:[],changed_count:0}
  const certificate={...facts,id:qualityHash(facts)};ledger.collaboration=[certificate];saveQualityLedger(project.project_id,ledger)
  await promoteSoftwareRelease(release,{version:'controlled-selector-fixture',scope:prdScopeFingerprint(readPrdBackplane(project.project_id)),at:new Date().toISOString(),collaboration_id:certificate.id})
  expect(await select()).toMatchObject({risk:'full',required:['code','visual']})
})

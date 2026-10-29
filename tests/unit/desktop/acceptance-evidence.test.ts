import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
vi.mock('../../../main/project/document-engine',()=>({readPrdBackplane:vi.fn()}))
vi.mock('../../../main/desktop/workflow-policy',()=>({isSoftwareProject:()=>true}))
vi.mock('../../../main/desktop/lean-cli-check',()=>({runLeanCliCheck:vi.fn()}))
vi.mock('../../../main/desktop/llm-verification',()=>({runHostLlmProbe:vi.fn()}))
import { readPrdBackplane } from '../../../main/project/document-engine'
import { runLeanCliCheck } from '../../../main/desktop/lean-cli-check'
import { runHostLlmProbe } from '../../../main/desktop/llm-verification'
import { runCoreVerification } from '../../../main/desktop/core-verification'
import { acceptanceScopeNote } from '../../../main/desktop/acceptance-evidence'
let root:string
beforeEach(()=>{
 root=mkdtempSync(join(tmpdir(),'acceptance-rules-'))
 writeFileSync(join(root,'app.cjs'),'console.log(5)')
 writeFileSync(join(root,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}))
 writeFileSync(join(root,'CORE_CHECK.json'),JSON.stringify({llm:{runtime:'node',module:'client.cjs',factory:'Client',method:'enhance',covers:['F-001']}}))
 vi.mocked(readPrdBackplane).mockReturnValue({project_id:'p',positioning:'AI',user_confirmed_at:'confirmed',lean_brief:{version:1,ui:'none',delivery:'command',distribution:'local'},requirements:[{id:'F-001',description:'AI讲解',capabilities:['llm']}],acceptance:{'F-001':'讲解正确'},out_of_scope:[]} as never)
 vi.mocked(runLeanCliCheck).mockResolvedValue({status:'passed',cases:[{name:'local output',covers:['F-001'],passed:true}]} as never)
 vi.mocked(runHostLlmProbe).mockResolvedValue({probe_version:1,status:'passed',request_count:5,tests:[]} as never)
})
afterEach(()=>{vi.clearAllMocks();rmSync(root,{recursive:true,force:true})})
it('keeps local checks green without promoting implementation or real AI effects to passed',async()=>{
 const result=await runCoreVerification({projectId:'p',sandboxRoot:root})
 expect(result.status,result.missing.join('\n')).toBe('passed')
 expect(result.requirements?.[0]).toMatchObject({implementation:'unverified',verification:'passed',acceptance_evidence:{local_cases:'passed',capability_contracts:'passed',implementation:'not_assessed',external_model_effects:'unverified'}})
 expect(result.acceptance_evidence).toMatchObject({registered_checks:'passed',coverage:'registered_case_references',implementation:'not_assessed',external_model_effects:'unverified',complete_requirements:'not_assessed'})
 const saved=JSON.parse(readFileSync(join(root,'00_VERIFY/core-verification.json'),'utf8'))
 expect(saved.acceptance_evidence).toEqual(result.acceptance_evidence)
 expect(acceptanceScopeNote(result.acceptance_evidence)).toContain('真实供应商连通和模型效果尚未验证')
})
it('keeps local behavior and missing capability registration distinct and refuses delivery evidence',async()=>{
 writeFileSync(join(root,'CORE_CHECK.json'),'{}')
 const result=await runCoreVerification({projectId:'p',sandboxRoot:root})
 expect(result.status).toBe('unverified')
 expect(result.requirements?.[0].acceptance_evidence).toMatchObject({local_cases:'passed',capability_contracts:'unverified',external_model_effects:'unverified'})
 expect(runHostLlmProbe).not.toHaveBeenCalled()
})
it('does not let a passed protocol probe cover failed user-visible behavior',async()=>{
 vi.mocked(runLeanCliCheck).mockResolvedValue({status:'failed',cases:[{name:'wrong',covers:['F-001'],passed:false}]} as never)
 const result=await runCoreVerification({projectId:'p',sandboxRoot:root})
 expect(result.status).toBe('failed');expect(result.requirements?.[0].acceptance_evidence).toMatchObject({local_cases:'failed',capability_contracts:'passed'})
})
it('cannot pass a declared capability when its host verifier is omitted from the registry',async()=>{
 const result=await runCoreVerification({projectId:'p',sandboxRoot:root,capabilityVerifiers:[]})
 expect(result.status).toBe('unverified');expect(result.missing.join('\n')).toContain('缺少宿主能力检查结果 llm')
 expect(result.requirements?.[0].acceptance_evidence?.capability_contracts).toBe('unverified')
 const forged=await runCoreVerification({projectId:'p',sandboxRoot:root,capabilityVerifiers:[{id:'unrelated',async run(){return{verifier_id:'llm',status:'passed',missing:[],features:{'F-001':'passed'}}}}]})
 expect(forged.status).toBe('unverified');expect(forged.missing.join('\n')).toContain('缺少宿主能力检查结果 llm')
})
it('invalidates all newly layered local claims when source changes during checking',async()=>{
 vi.mocked(runHostLlmProbe).mockImplementationOnce(async()=>{writeFileSync(join(root,'changed.cjs'),'changed');return{probe_version:1,status:'passed'}})
 const result=await runCoreVerification({projectId:'p',sandboxRoot:root})
 expect(result.status).toBe('unverified');expect(result.acceptance_evidence?.registered_checks).toBe('unverified')
 expect(result.requirements?.[0].acceptance_evidence).toMatchObject({local_cases:'unverified',capability_contracts:'unverified'})
})
it('does not infer full acceptance from old unlayered evidence',()=>{
 expect(acceptanceScopeNote()).toContain('历史记录未分层')
})

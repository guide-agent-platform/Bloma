import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
const {verify}=vi.hoisted(()=>({verify:vi.fn()}))
vi.mock('../../../main/software/verification',async original=>({...await original<typeof import('../../../main/software/verification')>(),verifySoftwareCandidate:verify}))
vi.mock('../../../storage/json-store',async original=>{const actual=await original<typeof import('../../../storage/json-store')>();return{...actual,writeTextFileAtomic:vi.fn(actual.writeTextFileAtomic)}})
import { writeTextFileAtomic } from '../../../storage/json-store'
import { createProject, updateProject, findProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { prdScopeFingerprint } from '../../../main/project/requirement-contract'
import { ensureLongtermState, readLongtermState, saveLongtermState, stageLongtermMilestone, longtermPendingDecision, noteLongtermSuggestion, recordLongtermDecision } from '../../../main/software/longterm-state'
import { performLongtermAction, currentMilestoneAction } from '../../../main/software/longterm-control'
import { handleLongtermMessage } from '../../../main/software/longterm-message'
import { prepareSoftwareRelease, sealSoftwareRelease, activeSoftwareRelease } from '../../../main/software/release-store'
import { readPendingDecision } from '../../../main/guide/pending-decision'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { parseLeanSuggestions } from '../../../main/guide/lean-suggestions'

let home:string,old:string|undefined,project:ReturnType<typeof createProject>
const signal=()=>new AbortController().signal
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-longterm-'));process.env.PROMA_HOME=home;vi.clearAllMocks()
  project=createProject({request_id:'c',mode:'longterm'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'输出5',ui:'none',delivery:'command',requirements:[{description:'输出5',expected:'显示5'}],constraints:['本地使用'],out_of_scope:['云同步']}),{projectId:project.project_id,sessionId:'s',source:'输出5',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)');writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}))
})
afterEach(async()=>{const actual=await vi.importActual<typeof import('../../../storage/json-store')>('../../../storage/json-store');vi.mocked(writeTextFileAtomic).mockImplementation(actual.writeTextFileAtomic)
  if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
async function pending(){
  ensureLongtermState(project.project_id,'s');const candidate=await prepareSoftwareRelease(project.project_id,project.root_path)
  await sealSoftwareRelease(candidate,{version:'unit-fixture-only',scope:prdScopeFingerprint(readPrdBackplane(project.project_id)),at:new Date().toISOString()})
  const state=stageLongtermMilestone(project.project_id,'s','original-request',candidate)
  verify.mockResolvedValue({status:'passed',summary:'unit injected host outcome',candidate})
  return{candidate,state}
}
const action=(revision:number,kind:'confirm'|'later'|'archive'|'adopt_backlog'='confirm')=>({request_id:'user-choice',project_id:project.project_id,session_id:'s',revision,action:kind})
const emit=vi.fn()
it('persists one current milestone and scoped decisions, while quick projects do not acquire a longterm workflow',()=>{
  const first=ensureLongtermState(project.project_id,'s');expect(ensureLongtermState(project.project_id,'s').current_id).toBe(first.current_id)
  recordLongtermDecision(project.project_id,'s','保持数据格式','新增字段通过迁移补齐')
  expect(readLongtermState(project.project_id)?.decisions[0].decision).toBe('保持数据格式')
  expect(()=>ensureLongtermState(project.project_id,'another-session')).toThrow('SESSION_MISMATCH')
  updateProject(project.project_id,{mode:'quick'});expect(()=>ensureLongtermState(project.project_id,'s')).toThrow('SOFTWARE_REQUIRED')
})
it('holds a verified milestone for explicit review, restores it without model work, and confirms only the exact original candidate',async()=>{
  const {candidate,state}=await pending();expect(findProject(project.project_id).status).toBe('active');expect(readPendingDecision(project.project_id,'s')?.payload.kind).toBe('longterm_milestone')
  expect(await activeSoftwareRelease(project.project_id)).toBeUndefined()
  const snapshot=readFileSync(join(home,'software-longterm',project.project_id+'.json'),'utf8')
  readPendingDecision(project.project_id,'s');expect(readFileSync(join(home,'software-longterm',project.project_id+'.json'),'utf8')).toBe(snapshot)
  const deps={publish:vi.fn(),persistAssistant:vi.fn(),persistSystem:vi.fn(),complete:vi.fn()}
  expect(await handleLongtermMessage({projectId:project.project_id,sessionId:'s',requestId:'look',content:'继续',query:vi.fn(),env:{},maxTokens:1024},deps)).toBe(true)
  expect(verify).not.toHaveBeenCalled()
  const result=await performLongtermAction(action(state.revision),signal(),{busy:false,emit})
  expect(result.state.milestones[0].status).toBe('delivered');expect(findProject(project.project_id).status).toBe('completed')
  expect(verify).toHaveBeenCalledWith(project.project_id,'original-request',expect.anything(),false,expect.objectContaining({id:candidate.id}))
  expect(leanBudget(project.project_id,'desktop-verify').snapshot().requests).toBe(0)
})
it('rejects stale cards, revisions, foreign sessions, active writers and changed source before issuing confirmation',async()=>{
  const {state}=await pending()
  expect(()=>currentMilestoneAction(project.project_id,'s','longterm_confirm:unknown')).toThrow('STALE')
  await expect(performLongtermAction({...action(state.revision),session_id:'other'},signal(),{busy:false,emit})).rejects.toThrow('OWNER_MISMATCH')
  await expect(performLongtermAction(action(state.revision-1),signal(),{busy:false,emit})).rejects.toThrow('STATE_STALE')
  await expect(performLongtermAction(action(state.revision),signal(),{busy:true,emit})).rejects.toThrow('ACTIVE_WORK')
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(999)')
  await expect(performLongtermAction(action(state.revision),signal(),{busy:false,emit})).rejects.toThrow('WORKING_SOURCE_CHANGED')
  expect(verify).not.toHaveBeenCalled();expect(readLongtermState(project.project_id)?.milestones[0].status).toBe('awaiting_confirmation')
})
it('preserves pending state when cancellation or new verification failure occurs',async()=>{
  const {candidate,state}=await pending(),controller=new AbortController()
  verify.mockImplementation(async()=>{controller.abort();return{status:'passed',candidate}})
  await expect(performLongtermAction(action(state.revision),controller.signal,{busy:false,emit})).rejects.toThrow()
  expect(readLongtermState(project.project_id)?.milestones[0].status).toBe('awaiting_confirmation')
  verify.mockResolvedValue({status:'unverified',summary:'fresh evidence missing',candidate})
  await expect(performLongtermAction(action(state.revision),signal(),{busy:false,emit})).rejects.toThrow('CURRENT_VERIFICATION_REQUIRED')
  expect(findProject(project.project_id).status).toBe('active')
})
it('restores an interrupted confirmation as pending and needs a fresh explicit action before publication',async()=>{
  const {state,candidate}=await pending();state.milestones[0].status='confirming';state.milestones[0].confirmation_requested_at=new Date().toISOString()
  const interrupted=saveLongtermState(state);expect(await activeSoftwareRelease(project.project_id)).toBeUndefined()
  const deps={publish:vi.fn(),persistAssistant:vi.fn(),persistSystem:vi.fn(),complete:vi.fn()}
  await handleLongtermMessage({projectId:project.project_id,sessionId:'s',requestId:'look',content:'继续',query:vi.fn(),env:{},maxTokens:1024},deps)
  expect(verify).not.toHaveBeenCalled();expect(readLongtermState(project.project_id)?.milestones[0].status).toBe('confirming')
  await performLongtermAction(action(interrupted.revision),signal(),{busy:false,emit})
  expect((await activeSoftwareRelease(project.project_id))?.id).toBe(candidate.id)
})
it('keeps backlog outside the scope until selected, then preserves old features/constraints and requires a new task confirmation',async()=>{
  const {state}=await pending();await performLongtermAction(action(state.revision),signal(),{busy:false,emit})
  const idea=parseLeanSuggestions([{title:'备份',description:'导出本地备份',benefit:'避免丢失',expected:'文件包含原有数据'}])[0]
  const before=readPrdBackplane(project.project_id);noteLongtermSuggestion(project.project_id,'s',idea,'deferred')
  expect(readPrdBackplane(project.project_id)).toEqual(before)
  const saved=readLongtermState(project.project_id)!
  await performLongtermAction({...action(saved.revision,'adopt_backlog'),backlog_id:idea.id},signal(),{busy:false,emit})
  const next=readPrdBackplane(project.project_id);expect(next.requirements).toHaveLength(2);expect(next.requirements[0]).toEqual(before.requirements[0])
  expect(next.constraints).toEqual(before.constraints);expect(next.out_of_scope).toEqual(before.out_of_scope);expect(next.user_confirmed_at).toBeUndefined()
  expect(readPendingDecision(project.project_id,'s')?.payload.kind).toBe('lean_scope')
})
it('does not invent a building milestone merely by deferring an after-delivery suggestion, and archive stays read-only',async()=>{
  updateProject(project.project_id,{status:'completed',current_stage:'completed',desktop_phase:'delivered'})
  const idea=parseLeanSuggestions([{title:'查找',description:'关键词查找',benefit:'容易找到',expected:'显示匹配项'}])[0]
  noteLongtermSuggestion(project.project_id,'s',idea,'deferred')
  expect(readLongtermState(project.project_id)?.milestones).toHaveLength(0);expect(findProject(project.project_id).status).toBe('completed')
  const {state}=await pending();await performLongtermAction(action(state.revision),signal(),{busy:false,emit})
  const ready=readLongtermState(project.project_id)!
  await performLongtermAction(action(ready.revision,'archive'),signal(),{busy:false,emit})
  expect(findProject(project.project_id).status).toBe('archived');expect(readPendingDecision(project.project_id,'s')).toBeUndefined()
  await expect(performLongtermAction(action(readLongtermState(project.project_id)!.revision),signal(),{busy:false,emit})).rejects.toThrow('ARCHIVED')
})
it('fails closed on damaged records and on final state persistence failure without consuming the pending confirmation',async()=>{
  const {state}=await pending(),file=join(home,'software-longterm',project.project_id+'.json'),before=readFileSync(file,'utf8')
  writeFileSync(file,before.replace('awaiting_confirmation','delivered'))
  expect(()=>readLongtermState(project.project_id)).toThrow('STATE_INVALID');writeFileSync(file,before)
  const actual=await vi.importActual<typeof import('../../../storage/json-store')>('../../../storage/json-store')
  vi.mocked(writeTextFileAtomic).mockImplementation((...args)=>{if(args[0]===file)throw Error('fixture disk full');actual.writeTextFileAtomic(...args)})
  await expect(performLongtermAction(action(state.revision),signal(),{busy:false,emit})).rejects.toThrow('fixture disk full')
  expect(readFileSync(file,'utf8')).toBe(before);expect(findProject(project.project_id).status).toBe('active');expect(longtermPendingDecision(project.project_id,'s')).toBeTruthy()
})

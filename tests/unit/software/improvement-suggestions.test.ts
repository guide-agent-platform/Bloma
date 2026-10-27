import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createProject, findProject, updateProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { offerSoftwareSuggestions, readSoftwareSuggestions, decideSoftwareSuggestion, buildImprovementSuggestionTool } from '../../../main/software/improvement-suggestions'
import { readGuideConfirmation } from '../../../main/guide/confirmation-journal'
import { readPendingDecision } from '../../../main/guide/pending-decision'
import { createToolState } from '../../../main/agent/loop/agent-loop'
let home:string,old:string|undefined,project:ReturnType<typeof createProject>
const idea={title:'导出备份',description:'将笔记导出备份',benefit:'避免丢失',expected:'导出文件包含现有笔记'}
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-improvements-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'笔记',ui:'none',delivery:'command',requirements:[{description:'保存笔记',expected:'重开可读'}],constraints:['本地使用'],out_of_scope:['云同步']}),{projectId:project.project_id,sessionId:'s',source:'笔记',previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
  updateProject(project.project_id,{current_stage:'generating_mvp',desktop_phase:'desktop-implement'})
})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:3})})
const input=(value:ReturnType<typeof offerSoftwareSuggestions>,action:'adopt'|'defer'|'reject')=>({request_id:'r',project_id:project.project_id,session_id:'s',set_id:value.id,suggestion_id:value.items[0].id,action})
it('offers without pausing, changing scope or treating ideas as accepted; persists human defer/reject across repeated offers',()=>{
  const before=readPrdBackplane(project.project_id),value=offerSoftwareSuggestions(project.project_id,'s',[idea])
  expect(readPrdBackplane(project.project_id)).toEqual(before);expect(findProject(project.project_id).desktop_phase).toBe('desktop-implement')
  const emit=vi.fn();decideSoftwareSuggestion(input(value,'defer'),true,emit);expect(emit).not.toHaveBeenCalled()
  expect(offerSoftwareSuggestions(project.project_id,'s',[idea]).items[0].state).toBe('deferred')
  decideSoftwareSuggestion(input(value,'reject'),false,emit)
  expect(offerSoftwareSuggestions(project.project_id,'s',[idea,{...idea,title:'查找',description:'关键词查找'}]).items[0].state).toBe('rejected')
  expect(readPrdBackplane(project.project_id)).toEqual(before)
})
it('retains optional ideas after delivery without reopening the completed project',()=>{
  updateProject(project.project_id,{status:'completed',current_stage:'completed',desktop_phase:'delivered'})
  const value=offerSoftwareSuggestions(project.project_id,'s',[idea]);expect(value.items[0].state).toBe('offered')
  expect(findProject(project.project_id).status).toBe('completed');expect(findProject(project.project_id).desktop_phase).toBe('delivered')
})
it('records an explicit adoption during work, then stages a preserved task sheet at idle and requires fresh confirmation',()=>{
  const value=offerSoftwareSuggestions(project.project_id,'s',[idea]),emit=vi.fn(),before=readPrdBackplane(project.project_id)
  decideSoftwareSuggestion(input(value,'adopt'),true,emit);expect(emit).not.toHaveBeenCalled();expect(readPrdBackplane(project.project_id)).toEqual(before)
  expect(readSoftwareSuggestions(project.project_id)?.items[0].state).toBe('adopt_requested')
  decideSoftwareSuggestion(input(value,'adopt'),false,emit)
  const next=readPrdBackplane(project.project_id);expect(next.requirements).toHaveLength(2);expect(next.requirements[0].id).toBe(before.requirements[0].id)
  expect(next.acceptance['F-001']).toBe(before.acceptance['F-001']);expect(next.constraints).toEqual(before.constraints);expect(next.out_of_scope).toEqual(before.out_of_scope)
  expect(next.user_confirmed_at).toBeUndefined();expect(readGuideConfirmation('prd',project.project_id)?.state).toBe('pending')
  expect(readPendingDecision(project.project_id,'s')?.payload.kind).toBe('lean_scope')
  expect(emit).toHaveBeenCalledWith('user_decision_required',expect.anything())
  expect(()=>decideSoftwareSuggestion(input(value,'adopt'),false,emit)).toThrow('STALE')
})
it('rejects cross-session, unknown, stale operation and stale scope decisions',()=>{
  const value=offerSoftwareSuggestions(project.project_id,'s',[idea]),base=input(value,'adopt')
  expect(()=>decideSoftwareSuggestion({...base,session_id:'other'},false,vi.fn())).toThrow('OWNER_MISMATCH')
  expect(()=>decideSoftwareSuggestion({...base,suggestion_id:'unknown'},false,vi.fn())).toThrow('UNKNOWN')
  updateProject(project.project_id,{lean_operation_id:'new-operation'})
  expect(()=>decideSoftwareSuggestion(base,false,vi.fn())).toThrow('STALE')
})
it('uses the current parent tool turn without extra model calls or debug preview mutations; zero ideas is allowed',async()=>{
  const changed=vi.fn(),tool=buildImprovementSuggestionTool(project.project_id,changed)
  const ctx={projectId:project.project_id,sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  expect((await tool.execute({suggestions:[]},ctx)).isError).not.toBe(true);expect(changed).not.toHaveBeenCalled()
  expect((await tool.execute({suggestions:[idea]},ctx)).isError).not.toBe(true);expect(changed).toHaveBeenCalledOnce()
  expect(findProject(project.project_id).current_stage).toBe('generating_mvp')
})

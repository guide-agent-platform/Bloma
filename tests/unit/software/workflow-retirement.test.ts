import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createProject, findProject, updateProject } from '../../../main/project/project-service'
import { workflowRetirementReason } from '../../../main/desktop/workflow-retirement'
import { isLeanProject } from '../../../main/desktop/workflow-policy'
import { migrateLegacyWorkflow } from '../../../main/software/migrate-workflow'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { activeSoftwareRelease } from '../../../main/software/release-store'
import { enterDesktopLine, handleDesktopDispatchMessage } from '../../../main/desktop/desktop-route'
import { handleGuideMessage } from '../../../main/guide/guide-agent-service'
import { readPendingDecision } from '../../../main/guide/pending-decision'
import { runAgent } from '../../../main/orchestration/stages/agent-dispatch'
import * as channels from '../../../main/platform/llm/runtime-fallback'
import { guideConfirmationPath,saveGuideConfirmation } from '../../../main/guide/confirmation-journal'

let home:string,prior:string|undefined
beforeEach(()=>{prior=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'blretire-'));process.env.PROMA_HOME=home})
afterEach(()=>{vi.restoreAllMocks();if(prior===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=prior;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
it('copies legacy source and in-root data without changing the old project, journal, ledger or external data',async()=>{
  const p=createProject({request_id:'old',mode:'longterm',initial_message:'旧记事'})
  writeFileSync(join(p.root_path,'app.py'),'print("user work")');mkdirSync(join(p.root_path,'data'));writeFileSync(join(p.root_path,'data','notes.json'),'真实用户文字')
  for(const folder of ['pending-confirmations','usage-ledger','external-user-data'])mkdirSync(join(home,folder),{recursive:true})
  const sentinels=['pending-confirmations/old-card.json','usage-ledger/original.json','external-user-data/user.json']
  for(const file of sentinels)writeFileSync(join(home,file),'retained-'+file)
  const before=JSON.stringify(findProject(p.project_id)),copy=await migrateLegacyWorkflow(p.project_id)
  expect(JSON.stringify(findProject(p.project_id))).toBe(before)
  expect(copy).toMatchObject({workflow_version:'software-v1',status:'active',current_stage:'clarifying',mode:'longterm',workflow_migration:{source_project_id:p.project_id}})
  expect(copy.project_id).not.toBe(p.project_id);expect(copy.root_path).not.toBe(p.root_path)
  expect(readFileSync(join(copy.root_path,'app.py'),'utf8')).toBe('print("user work")')
  expect(readFileSync(join(copy.root_path,'data/notes.json'),'utf8')).toBe('真实用户文字')
  expect(readPrdBackplane(copy.project_id).user_confirmed_at).toBeUndefined();expect(copy.ux_confirmation).toBeUndefined();expect(await activeSoftwareRelease(copy.project_id)).toBeUndefined()
  for(const file of sentinels)expect(readFileSync(join(home,file),'utf8')).toBe('retained-'+file)
  writeFileSync(join(copy.root_path,'app.py'),'print("new copy")');expect(readFileSync(join(p.root_path,'app.py'),'utf8')).toBe('print("user work")')
})
it('rejects frozen identities even with experiment switches off and never silently upgrades a version',async()=>{
  const p=createProject({request_id:'frozen',mode:'quick'},{workflowVersion:'software-v1'});mkdirSync(join(home,'dispatch-experiments'))
  writeFileSync(join(home,'dispatch-experiments',p.project_id+'.json'),'{bad frozen file still proves identity')
  expect(workflowRetirementReason(p)).toContain('冻结实验');expect(isLeanProject(p.project_id)).toBe(false)
  await expect(migrateLegacyWorkflow(p.project_id)).rejects.toThrow()
  updateProject(p.project_id,{workflow_version:undefined});await expect(migrateLegacyWorkflow(p.project_id)).rejects.toThrow('FROZEN_EXPERIMENT')
  expect(findProject(p.project_id).workflow_version).toBeUndefined()
})
it('all guide and desktop message entry points return retirement before model or state-consuming work',async()=>{
  const p=createProject({request_id:'old',mode:'quick'}),snapshot=JSON.stringify(findProject(p.project_id)),query=vi.fn(),publish=vi.fn(),complete=vi.fn()
  const input={projectId:p.project_id,sessionId:'s',requestId:'r',content:'继续',query,env:{},maxTokens:1000}
  const deps={publish,persistAssistant:vi.fn(),persistSystem:vi.fn(),complete}
  expect(await enterDesktopLine(input,query,{},deps)).toBe(true)
  await handleDesktopDispatchMessage({...input,cardOptionId:'desktop_confirm:old'},deps)
  await handleGuideMessage({project_id:p.project_id,session_id:'s',request_id:'r',mode:'quick',current_stage:'clarifying',content:'确认'},vi.fn(),{query,env:{},signal:new AbortController().signal,sessionId:'s',history:[],maxTokens:1000,persistAssistant:vi.fn()},vi.fn())
  expect(query).not.toHaveBeenCalled();expect(JSON.stringify(findProject(p.project_id))).toBe(snapshot);expect(readPendingDecision(p.project_id,'s')).toBeUndefined()
  expect(complete).toHaveBeenCalledWith('s',p.project_id,'incomplete')
  const resolveChannel=vi.spyOn(channels,'resolveChannelEnv')
  await runAgent({project_id:p.project_id,session_id:'s',request_id:'primary-entry',mode:'quick',current_stage:'clarifying',content:'继续'})
  expect(resolveChannel).not.toHaveBeenCalled();expect(JSON.stringify(findProject(p.project_id))).toBe(snapshot)
})
it('keeps lean-v1 short workflow available, while explicit migration creates a new unconfirmed software copy',async()=>{
  const p=createProject({request_id:'lean',mode:'quick'},{workflowVersion:'lean-v1'});writeFileSync(join(p.root_path,'app.py'),'print(5)')
  expect(workflowRetirementReason(p)).toBeUndefined();expect(isLeanProject(p.project_id)).toBe(true)
  const copy=await migrateLegacyWorkflow(p.project_id);expect(copy.workflow_version).toBe('software-v1');expect(findProject(p.project_id).workflow_version).toBe('lean-v1')
})
it('does not consume or rewrite real historical confirmation envelopes, including damaged ones',async()=>{
  const p=createProject({request_id:'history',mode:'longterm'})
  saveGuideConfirmation({version:1,kind:'prd',id:'historic-card',project_id:p.project_id,session_id:'s',scope_hash:'a'.repeat(64),state:'pending',data:{historical:true}})
  const file=guideConfirmationPath('prd',p.project_id),before=readFileSync(file)
  expect(readPendingDecision(p.project_id,'s')).toBeUndefined()
  await handleGuideMessage({request_id:'legacy-card',project_id:p.project_id,session_id:'s',mode:'longterm',current_stage:'clarifying',content:'确认',metadata:{source:'card_option',selected_option_id:'prd_confirm_confirm'}},vi.fn())
  expect(readFileSync(file).equals(before)).toBe(true)
  writeFileSync(file,'{damaged old receipt');expect(readPendingDecision(p.project_id,'s')).toBeUndefined();expect(readFileSync(file,'utf8')).toBe('{damaged old receipt')
})

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
vi.mock('electron', () => ({ shell: {}, app: { isPackaged: false }, BrowserWindow: class {} }))
import { createProject } from '../../../main/project/project-service'
import { softwareModelSettings, saveSoftwareModelSettings } from '../../../main/software/independent-settings'
import { readIndependentPolicy } from '../../../main/software/independent-policy'
import { saveSoftwareRunState } from '../../../main/software/run-state'
import { registerProjectDeliverablesIpc } from '../../../main/ipc/project-deliverables'
import { registerBackgroundRun, unregisterBackgroundRun } from '../../../main/orchestration/stages/run-registry'
import { IPC_CHANNELS, type SoftwareModelSettingsSave } from '../../../shared/types'
let home: string, old: string|undefined, project: ReturnType<typeof createProject>
beforeEach(() => {
  old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-model-settings-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'new',mode:'quick'},{workflowVersion:'software-v1'})
  writeFileSync(join(home,'bloma-channels.json'),JSON.stringify({version:1,channels:[{id:'b',name:'测试渠道',base_url:'https://b.invalid',api_key:'SECRET_SENTINEL',enabled:true,provider_type:'deepseek',models:[{id:'bm',name:'model-b',enabled:true},{id:'off',name:'off',enabled:false}]}]}))
})
afterEach(() => { if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:4,retryDelay:100}) })
function input(): SoftwareModelSettingsSave { return { request_id:'save',project_id:project.project_id,revision:softwareModelSettings(project.project_id).revision,
  variant:'independent',channel_id:'b',model:'model-b',authorize_budget:true,budget:{cap_rmb:1,context_tokens:4096,input_rmb_per_million:1,output_rmb_per_million:2} } }
it('saves an explicitly authorized project budget without requesting models or exposing keys/host paths', () => {
  const result=saveSoftwareModelSettings(input())
  expect(result).toMatchObject({variant:'independent',admission:'not_checked',budget:{cap_rmb:1,accounted_upper_rmb:0,remaining_rmb:1},pricing:{context_tokens:4096}})
  expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL');expect(JSON.stringify(result)).not.toContain(home)
  const policy=readIndependentPolicy(project.project_id)!
  if(!policy.enabled)throw Error('fixture')
  const proof=JSON.parse(readFileSync(policy.authorization_path,'utf8'))
  expect(proof).toMatchObject({source:'direct_user_confirmation',source_ui:'project_model_settings',project_id:project.project_id,operation_id:project.lean_operation_id,model:'model-b',cap_rmb:1})
  expect(JSON.parse(readFileSync(policy.monetary_policy_path+'.state.json','utf8')).entries).toEqual([])
})
it('rejects absent consent, stale revisions, disabled models and insufficient complete-request reserve', () => {
  expect(()=>saveSoftwareModelSettings({...input(),authorize_budget:false})).toThrow('明确确认')
  expect(()=>saveSoftwareModelSettings({...input(),revision:'stale'})).toThrow('配置已变化')
  expect(()=>saveSoftwareModelSettings({...input(),model:'off'})).toThrow('已启用')
  expect(()=>saveSoftwareModelSettings({...input(),budget:{...input().budget!,cap_rmb:.000001}})).toThrow('保守预留')
})
it('preserves historical liability and refuses to replace a spent or unreadable local budget', () => {
  saveSoftwareModelSettings(input());const policy=readIndependentPolicy(project.project_id)!;if(!policy.enabled)throw Error('fixture')
  const file=policy.monetary_policy_path+'.state.json',state=JSON.parse(readFileSync(file,'utf8'))
  state.entries.push({id:'used',host:'b.invalid',model:'model-b',charged_micro_rmb:200000,reserved_micro_rmb:200000,status:'unknown'})
  writeFileSync(file,JSON.stringify(state));const bytes=readFileSync(file,'utf8')
  expect(softwareModelSettings(project.project_id).budget?.accounted_upper_rmb).toBe(.2)
  expect(()=>saveSoftwareModelSettings(input())).toThrow('未知责任');expect(readFileSync(file,'utf8')).toBe(bytes)
  writeFileSync(file,'{');expect(()=>saveSoftwareModelSettings(input())).toThrow('未知责任')
})
it('enforces execution locks through the actual IPC and returns current saved state after reload', async () => {
  const handlers=new Map<string, (...args:unknown[])=>Promise<any>>()
  registerProjectDeliverablesIpc({handle:(name:string,fn:(...args:unknown[])=>Promise<any>)=>handlers.set(name,fn)} as never,{} as never)
  const get=()=>handlers.get(IPC_CHANNELS.SOFTWARE_MODEL_SETTINGS_GET)!({}, {request_id:'get',project_id:project.project_id})
  expect((await get()).data.variant).toBe('single')
  const run=registerBackgroundRun('settings-test',new AbortController(),project.project_id,()=>{})
  try{expect((await get()).data.locked).toBe(true);expect((await handlers.get(IPC_CHANNELS.SOFTWARE_MODEL_SETTINGS_SAVE)!({},input())).ok).toBe(false)}finally{unregisterBackgroundRun('settings-test',run)}
  expect((await handlers.get(IPC_CHANNELS.SOFTWARE_MODEL_SETTINGS_SAVE)!({},input())).data.variant).toBe('independent')
  expect((await get()).data.model).toBe('model-b')
  saveSoftwareRunState({projectId:project.project_id,sessionId:'s',runId:'r',status:'running'})
  expect((await get()).data.locked).toBe(true)
  expect((await handlers.get(IPC_CHANNELS.SOFTWARE_MODEL_SETTINGS_SAVE)!({},input())).ok).toBe(false)
})

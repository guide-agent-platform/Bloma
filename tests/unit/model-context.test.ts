import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveModelContext, attachModelLimits } from '../../main/platform/llm/model-context'
import { runAgentLoop } from '../../main/agent/loop/agent-loop'
afterEach(()=>vi.unstubAllEnvs())
it.each([['https://api.deepseek.com/anthropic','deepseek-flash'],['https://open.bigmodel.cn/api/anthropic','glm-5.3']])('uses the installed provider catalog for million-token capacity on %s',async(base,model)=>{
  const policy=await resolveModelContext({ANTHROPIC_BASE_URL:base,ANTHROPIC_MODEL:model},16384)
  expect(policy).toMatchObject({contextWindow:1000000,source:'pi-catalog',keepRecentTokens:20000})
  expect(policy.reserveTokens).toBe(25600)
})
it('does not trust a proxy model name, allows a scoped explicit limit, and never carries it to another model',async()=>{
  const env={ANTHROPIC_BASE_URL:'https://proxy.invalid/v1',ANTHROPIC_MODEL:'deepseek-flash'}
  expect(await resolveModelContext(env,4096)).toMatchObject({contextWindow:128000,source:'fallback'})
  attachModelLimits(env,{context_window:1000000,max_output_tokens:64000})
  expect(await resolveModelContext(env,4096)).toMatchObject({contextWindow:1000000,maxOutputTokens:64000,source:'channel'})
  expect(await resolveModelContext({...env,ANTHROPIC_MODEL:'other'},4096)).toMatchObject({contextWindow:128000,source:'fallback'})
  expect(()=>attachModelLimits(env,{context_window:Infinity})).toThrow('MODEL_LIMITS_INVALID')
})
it('keeps the financial reservation distinct and unchanged while constraining effective context',async()=>{
  const home=mkdtempSync(join(tmpdir(),'bloma-context-policy-')),path=join(home,'policy.json')
  try{const bytes=JSON.stringify({version:1,models:[{host:'api.deepseek.com',model:'deepseek-flash',context_tokens:128000,cap_rmb:1}]});writeFileSync(path,bytes);vi.stubEnv('BLOMA_MONETARY_POLICY',path)
    expect(await resolveModelContext({ANTHROPIC_BASE_URL:'https://api.deepseek.com',ANTHROPIC_MODEL:'deepseek-flash'},4096)).toMatchObject({capacityWindow:1000000,contextWindow:128000,reservationLimit:128000})
    expect(readFileSync(path,'utf8')).toBe(bytes);expect(existsSync(path+'.state.json')).toBe(false)
  }finally{rmSync(home,{recursive:true,force:true})}
})
it('a real Pi loop on the published 1M model does not compact at 300k or require any provider call',async()=>{
  let calls=0;const compact=vi.fn(),observed=vi.fn()
  const result=await runAgentLoop({runtime:'pi',system:'fixture',task:'continue',projectId:'context-million',sessionId:'context-million',requestId:'r',
    query:async function*(){calls++;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}};yield{type:'result',stop_reason:'end_turn',usage:{input_tokens:300000,output_tokens:5}}},
    env:{ANTHROPIC_BASE_URL:'https://api.deepseek.com/anthropic',ANTHROPIC_MODEL:'deepseek-flash'},tools:[],maxTokens:4096,maxTurns:3,permissionMode:'allow-all',signal:AbortSignal.timeout(15000),publish:()=>{},onCompaction:compact,onRuntimeObservation:observed})
  expect(result.status).toBe('completed');expect(calls).toBe(1);expect(compact).not.toHaveBeenCalled();expect(observed.mock.calls[0][0].settings.contextWindow).toBe(1000000)
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runGuideLoopTurn } from '../../main/guide/stages/guide-pipeline'
import { buildDesktopChildBaseSystem, buildDispatcherSystemPrompt } from '../../main/desktop/dispatcher-prompt'
import { DESKTOP_PHASES } from '../../main/desktop/dispatcher-phases'
import { restorePromaHome } from '../support/proma-home-guard'
import type { SDKQueryOptions } from '../../main/orchestration/orchestrator'
const originalHome=process.env.PROMA_HOME
let home:string
beforeEach(() => { home=mkdtempSync(join(tmpdir(),'bloma-short-output-')); process.env.PROMA_HOME=home })
afterEach(() => { restorePromaHome(originalHome); rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:50}) })
describe('用户说明与内部契约分开', () => {
  it('真实向导 loop 请求在覆盖版基底后获得短回复约定，完整历史不被裁剪', async () => {
    const calls:SDKQueryOptions[]=[]
    const fullRequirement='必须保留的验收条件'.repeat(80)
    await runGuideLoopTurn({request_id:'r',session_id:'s',project_id:'missing',content:fullRequirement,mode:'quick',current_stage:'clarifying',metadata:{source:'chat'}},()=>{}, {
      sessionId:'s',env:{},signal:new AbortController().signal,maxTokens:2048,history:[],persistAssistant:()=>{},
      query:async function* (_prompt,options) { calls.push(options); yield {type:'assistant',message:{role:'assistant',content:[{type:'text',text:'收到，先确认目标。'}]}}; yield {type:'result',subtype:'success'} },
    }, '本地向导覆盖标记：完整整理需求')
    const system=String(calls[0]?.messages?.[0]?.content)
    expect(system).toContain('本地向导覆盖标记')
    expect(system).toContain('【工作区短回复约定】')
    expect(system).toContain('不缩减实际工作与验证')
    expect(JSON.stringify(calls[0]?.messages)).toContain(fullRequirement)
  })
  it('编排器短说明不缩减 worker 的需求与报告，并保留未验证声明', () => {
    const node=DESKTOP_PHASES['desktop-implement']
    const ctx={projectName:'离线摘记',requirementsDigest:'F-001 验收：关掉重开仍保留记录'}
    expect(buildDispatcherSystemPrompt(node,ctx)).toContain('【工作区短回复约定】')
    const child=buildDesktopChildBaseSystem(node,ctx)
    expect(child).toContain('关掉重开仍保留记录')
    expect(child).not.toContain('【工作区短回复约定】')
  })
})

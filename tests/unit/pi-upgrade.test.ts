import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { normalizeContext, type Tool } from '@earendil-works/pi-ai'
import { runAgentLoop, type AgentLoopInput } from '../../main/agent/loop/agent-loop'
import { createPiTransport } from '../../main/agent/loop/pi-transport'
import { piSessionPath } from '../../main/agent/loop/pi-session-store'
import { piToolArguments } from '../../main/agent/loop/pi-messages'
import { createProject } from '../../main/project/project-service'
import type { SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'

let home:string,previous:string|undefined
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-pi140-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const base=(extra:Partial<AgentLoopInput>={}):AgentLoopInput=>({runtime:'pi',runtimeScope:'desktop-implement',projectId:'test-project',sessionId:'test-session',requestId:'r140',system:'HOST_POLICY_140',task:'continue',tools:[],env:{ANTHROPIC_MODEL:'fixture',ANTHROPIC_BASE_URL:'https://fixture.invalid/v1'},query:async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}};yield{type:'result',stop_reason:'end_turn'}},maxTokens:1000,maxTurns:5,permissionMode:'allow-all',signal:AbortSignal.timeout(20000),publish:()=>{},...extra})

it('uses native v3 history from the old writer without replaying the completed write',async()=>{
  const fixture=readFileSync(resolve('tests/fixtures/pi-upgrade/v0.85.1-session.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  fixture[0].cwd=process.cwd()
  const file=piSessionPath('test-project','test-session','desktop-implement:',process.cwd());mkdirSync(dirname(file),{recursive:true});writeFileSync(file,fixture.map(line=>JSON.stringify(line)).join('\n')+'\n')
  const calls:SDKQueryOptions[]=[],write=vi.fn(async()=>({output:'must not run'}))
  const input=base({tools:[{name:'write_file',description:'fixture write',input_schema:{type:'object',properties:{}},execute:write}],query:async function*(_prompt,options){calls.push(options);yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'continued'}]}};yield{type:'result',stop_reason:'end_turn'}}})
  expect((await runAgentLoop(input)).status).toBe('completed')
  expect(calls).toHaveLength(1);expect(write).not.toHaveBeenCalled()
  expect(JSON.stringify(calls[0].messages)).toContain('legacy-write-completed-once')
  expect(JSON.stringify(calls[0].messages)).toContain('HOST_POLICY_140')
  expect(readFileSync(file,'utf8')).toContain('bloma-tool-receipt')
})

it('keeps ambient native extensions and MCP outside the exact host tool allowlist',async()=>{
  const project=createProject({request_id:'p',mode:'quick'},{workflowVersion:'software-v1'})
  const marker=join(home,'foreign-executed'),pi=join(project.root_path,'.pi');mkdirSync(join(pi,'extensions'),{recursive:true})
  writeFileSync(join(pi,'extensions','foreign.ts'),`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');export default function() {}`)
  writeFileSync(join(pi,'mcp.json'),JSON.stringify({mcpServers:{foreign:{command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'mcp')`]}}}))
  const calls:SDKQueryOptions[]=[]
  await runAgentLoop(base({projectId:project.project_id,tools:[{name:'host_only',description:'approved',input_schema:{type:'object',properties:{}},execute:async()=>({output:'ok'})}],query:async function*(_prompt,options){calls.push(options);yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}};yield{type:'result',stop_reason:'end_turn'}}}))
  expect(calls[0].tools?.map(t=>t.name)).toEqual(['host_only']);expect(existsSync(marker)).toBe(false)
})

it('replays native system sections and tool add/remove deltas using the upstream transcript helpers',async()=>{
  const tool=(name:string):Tool=>({name,description:name,parameters:{type:'object',properties:{}}} as Tool)
  const context=normalizeContext({messages:[{role:'system',content:'BASE',sections:{policy:'OLD_POLICY'},toolsAdded:[tool('keep'),tool('remove')],timestamp:0},
    {role:'user',content:'work',timestamp:1},{role:'system',content:'UPDATE',sections:{policy:'NEW_POLICY'},toolsRemoved:[{name:'remove'}],toolsAdded:[tool('added')],timestamp:2}]})
  const calls:SDKQueryOptions[]=[],usage=vi.fn()
  const input=base({query:async function*(_prompt,options){calls.push(options);yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}};yield{type:'result',stop_reason:'end_turn',usage:{input_tokens:7,output_tokens:3}}}})
  const stream=await createPiTransport(input,{beforeRequest:()=>{},isCompacting:()=>true,onUsage:usage,onFailure:error=>{throw error}})({id:'fixture'} as never,context,{maxTokens:90000})
  const result=await stream.result();expect(result.stopReason).toBe('stop')
  expect(calls[0].tools?.map(t=>t.name)).toEqual(['keep','added'])
  const wire=JSON.stringify(calls[0].messages);expect(wire).toContain('BASE');expect(wire).toContain('UPDATE');expect(wire).toContain('NEW_POLICY');expect(wire).not.toContain('OLD_POLICY')
  expect(calls[0]).toMatchObject({maxTokens:1000,accounting:{scope:'handoff'}});expect(usage).toHaveBeenCalledWith(7,3,true)
})

it('uses the upstream complete-argument parser and refuses non-object/cyclic payloads',()=>{
  expect(piToolArguments({items:[1,true,null,'文本']})).toEqual({items:[1,true,null,'文本']})
  expect(()=>piToolArguments([] as unknown as Record<string,unknown>)).toThrow('PI_TOOL_ARGUMENTS_NOT_JSON')
  const circular:Record<string,unknown>={};circular.self=circular
  expect(()=>piToolArguments(circular)).toThrow('PI_TOOL_ARGUMENTS_NOT_JSON')
})

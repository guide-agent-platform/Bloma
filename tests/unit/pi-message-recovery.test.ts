import { expect, it } from 'vitest'
import type { Message, Model } from '@earendil-works/pi-ai'
import { emptyAssistant, toTransportTurns } from '../../main/agent/loop/pi-messages'

const model = { id:'fixture',name:'fixture',api:'openai-completions',provider:'bloma-transport',baseUrl:'',reasoning:false,input:['text'],cost:{input:0,output:0,cacheRead:0,cacheWrite:0},contextWindow:128000,maxTokens:1000 } as Model<string>
function assistant(id:string,reason:'toolUse'|'error'|'aborted'='toolUse') {
  const message=emptyAssistant(model);message.content=[{type:'toolCall',id,name:'write_file',arguments:{}}];message.stopReason=reason;return message
}
const result=(id:string,text:string):Message=>({role:'toolResult',toolCallId:id,toolName:'write_file',content:[{type:'text',text}],isError:false,timestamp:0})

it.each(['error','aborted'] as const)('omits results of a suppressed %s assistant while preserving later paired evidence and input bytes',reason=>{
  const messages:Message[]=[assistant('failed',reason),result('failed','orphan-result'),assistant('good'),result('good','actual-durable-result')]
  const before=JSON.stringify(messages),wire=JSON.stringify(toTransportTurns({messages}))
  expect(wire).not.toContain('orphan-result');expect(wire).not.toContain('failed')
  expect(wire).toContain('actual-durable-result');expect(wire).toContain('good')
  expect(JSON.stringify(messages)).toBe(before)
})

it('does not send an orphan, a duplicate result, or a result for an earlier assistant round',()=>{
  const messages:Message[]=[result('lost','pre-context-orphan'),assistant('a'),result('a','kept-once'),result('a','duplicate'),assistant('b'),result('a','stale-round'),result('b','kept-b')]
  const wire=JSON.stringify(toTransportTurns({messages}))
  expect(wire).not.toMatch(/pre-context-orphan|duplicate|stale-round/)
  expect(wire).toContain('kept-once');expect(wire).toContain('kept-b')
})

it('keeps truncated text but omits a call with no corresponding result rather than inventing success',()=>{
  const pending=assistant('unsettled');pending.stopReason='length';pending.content.unshift({type:'text',text:'incomplete statement'})
  const wire=JSON.stringify(toTransportTurns({messages:[pending,{role:'user',content:'continue',timestamp:1}]}))
  expect(wire).toContain('incomplete statement');expect(wire).toContain('continue');expect(wire).not.toContain('unsettled')
})

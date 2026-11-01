import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {expect,it,vi} from 'vitest'
import {runAgentLoop} from '../../main/agent/loop/agent-loop'

it('uses Pi schema validation before host execution or budget use, without coercing side-effect arguments',async()=>{
  const previous=process.env.PROMA_HOME,home=mkdtempSync(join(tmpdir(),'bloma-native-schema-'));process.env.PROMA_HOME=home
  const execute=vi.fn(async(_input:Record<string,unknown>)=>({output:'saved'}));let calls=0
  const invalid=[{path:42,content:''},{path:'',content:''},{path:'  ',content:''},{path:'a'},
    {path:'a',content:'',extra:true},{path:'a',content:'',count:1.5},{path:'a',content:'',count:0},
    {path:'a',content:'',packages:[1]},{path:'a',content:'',mode:'delete'}]
  try{
    const result=await runAgentLoop({system:'host',task:'save',projectId:'schema',sessionId:'schema',requestId:'r',env:{},
      tools:[{name:'write_file',description:'write',input_schema:{type:'object',additionalProperties:false,required:['path','content'],properties:{path:{type:'string',minLength:1,pattern:'\\S'},content:{type:'string'},count:{type:'integer',minimum:1},packages:{type:'array',items:{type:'string'}},mode:{type:'string',enum:['read','write']}}},execute}],
      maxTokens:1000,maxTurns:2,toolBudget:{write_file:1},permissionMode:'allow-all',signal:AbortSignal.timeout(20000),publish:()=>{},
      query:async function*(_prompt,options){calls++
        if(calls===1)yield{type:'assistant',message:{role:'assistant',content:[...invalid,{path:'empty.txt',content:''}].map((input,i)=>({type:'tool_use' as const,id:'call-'+i,name:'write_file',input}))}}
        else{const wire=JSON.stringify(options.messages);expect(wire).toContain('TOOL_ARGUMENT_COERCION_REJECTED');expect(wire).toContain('Validation failed');yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}}}
        yield{type:'result',stop_reason:calls===1?'tool_use':'end_turn'}
      }})
    expect(result.status).toBe('completed');expect(calls).toBe(2);expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toEqual({path:'empty.txt',content:''})
  }finally{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true})}
},30000)

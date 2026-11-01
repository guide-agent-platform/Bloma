import {beforeEach,expect,it,vi} from 'vitest'
import {executeToolCall,createToolState,withAbort,type AgentLoopInput} from '../../main/agent/loop/agent-loop'
import {canUseTool} from '../../main/agent/permissions/permission-service'
vi.mock('../../main/agent/permissions/permission-service',()=>({canUseTool:vi.fn()}))
beforeEach(()=>{vi.mocked(canUseTool).mockReset()})
function invoke(permissionMode:'ask'|'safe'|'allow-all',signal=new AbortController().signal){
  const execute=vi.fn(async()=>({output:'written'})),tool={name:'write_file',description:'write',input_schema:{type:'object'},execute}
  const input={permissionMode,signal,projectId:'p',sessionId:'s',requestId:'r'} as AgentLoopInput
  return {execute,result:executeToolCall(input,new Map([[tool.name,tool]]),{},{name:tool.name,input:{}},{projectId:'p',sessionId:'s',requestId:'r',signal,state:createToolState()})}
}
it.each(['ask','safe'] as const)('rejects unattended %s tools without entering a permission dialog',async mode=>{
  const {execute,result}=invoke(mode);expect(await result).toMatchObject({isError:true,feedback:{category:'permission'}})
  expect(execute).not.toHaveBeenCalled();expect(canUseTool).not.toHaveBeenCalled()
})
it('cancels a pending host permission check before executing the tool',async()=>{
  vi.mocked(canUseTool).mockReturnValue(new Promise(()=>{}))
  const controller=new AbortController(),{result,execute}=invoke('allow-all',controller.signal)
  expect(canUseTool).toHaveBeenCalledTimes(1);controller.abort()
  await result // permission failure may be returned as evidence; no side effect is permitted
  expect(execute).not.toHaveBeenCalled()
})
it('observes already-rejected producers on cancellation and preserves ordinary promise results',async()=>{
  const controller=new AbortController();controller.abort()
  await expect(withAbort(Promise.reject(Error('producer failed')),controller.signal)).rejects.toThrow('AGENT_CANCELLED')
  const signal=new AbortController().signal
  await expect(withAbort(Promise.resolve('ok'),signal)).resolves.toBe('ok')
  await expect(withAbort(Promise.reject(Error('boom')),signal)).rejects.toThrow('boom')
})

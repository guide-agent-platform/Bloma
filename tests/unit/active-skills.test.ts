import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {buildActiveSkills} from '../../main/agent/tools/active-skills'
import {runAgentLoop,createToolState} from '../../main/agent/loop/agent-loop'
let home:string,previous:string|undefined
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-skills-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true})})
function seed(name='formatter',manual=false){const dir=join(home,'skills',name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: Format requested reports with the local procedure\n${manual?'disable-model-invocation: true\n':''}---\nPRIVATE_SKILL_BODY use the report procedure.\n`);return dir}
it('advertises only metadata and lets the actual Pi agent choose a skill without a user slash command',async()=>{
  seed();let calls=0;const observations=vi.fn()
  const result=await runAgentLoop({runtime:'pi',system:'host',task:'整理这份报告',projectId:'skill-project',sessionId:'skill-session',requestId:'r',env:{},tools:[],maxTokens:1000,maxTurns:5,permissionMode:'allow-all',signal:AbortSignal.timeout(15000),publish:()=>{},onRuntimeObservation:observations,
    query:async function*(_prompt,options){calls++;const wire=JSON.stringify(options.messages)
      if(calls===1){expect(wire).toContain('formatter');expect(wire).not.toContain('PRIVATE_SKILL_BODY');expect(options.tools?.some(t=>t.name==='read_skill')).toBe(true)
        yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'load',name:'read_skill',input:{name:'formatter'}}]}}
      }else{expect(wire).toContain('PRIVATE_SKILL_BODY');yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'done'}]}}}
      yield{type:'result',stop_reason:calls===1?'tool_use':'end_turn'}
    }})
  expect(result.status).toBe('completed');expect(calls).toBe(2);expect(observations.mock.calls[0][0].skills).toMatchObject({mode:'agent-selected',available:['formatter']})
})
it('honors manual-only skills, review isolation, scoped resources, and changed skill bytes',async()=>{
  const dir=seed();seed('manual-only',true);writeFileSync(join(home,'outside.txt'),'SECRET_OUTSIDE');writeFileSync(join(dir,'reference.txt'),'inside reference')
  const library=await buildActiveSkills(home);expect(library.available).toEqual(['formatter']);expect((await buildActiveSkills(home,true)).tools).toEqual([])
  const read=library.tools.find(t=>t.name==='read_skill')!,ctx={projectId:'p',sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  expect((await read.execute({name:'formatter',resource:'reference.txt'},ctx)).output).toContain('inside reference')
  expect(await read.execute({name:'formatter',resource:'../../outside.txt'},ctx)).toMatchObject({isError:true})
  expect((await read.execute({name:'manual-only'},ctx)).output).toContain('SKILL_NOT_AVAILABLE')
  writeFileSync(join(dir,'SKILL.md'),'changed');expect((await read.execute({name:'formatter'},ctx)).output).toContain('SKILL_CHANGED_RELOAD_REQUIRED')
})
it('loads shipped production skills without installation and respects overrides and review isolation',async()=>{
  expect((await buildActiveSkills(home)).available).toEqual([])
  const bundled=await buildActiveSkills(home,false,true)
  expect(bundled.available).toEqual(['software-change','software-verification'])
  expect(bundled.prompt).not.toContain('省略 `ui`')
  const ctx={projectId:'p',sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()}
  const read=bundled.tools.find(t=>t.name==='read_skill')!
  expect((await read.execute({name:'software-verification'},ctx)).output).toContain('command')
  seed('software-change')
  const customized=await buildActiveSkills(home,false,true)
  expect((await customized.tools.find(t=>t.name==='read_skill')!.execute({name:'software-change'},ctx)).output).toContain('PRIVATE_SKILL_BODY')
  const dir=join(home,'.bloma','skills','software-change');mkdirSync(dir,{recursive:true})
  writeFileSync(join(dir,'SKILL.md'),'---\nname: software-change\ndescription: Manual project override\ndisable-model-invocation: true\n---\nmanual only')
  expect((await buildActiveSkills(home,false,true)).available).toEqual(['software-verification'])
  expect((await buildActiveSkills(home,true,true)).tools).toEqual([])
})

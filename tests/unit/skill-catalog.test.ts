import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import {loadSkillCatalog,readCatalogSkill,prepareSkillTask} from '../../main/platform/mcp/skill-catalog'
import {buildActiveSkills} from '../../main/agent/tools/active-skills'
import {runAgentLoop,createToolState} from '../../main/agent/loop/agent-loop'
let home:string,previous:string|undefined
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-catalog-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true})})
function seed(root=join(home,'skills'),name='formatter',body='PRIVATE_BODY',extra=''){
  const dir=join(root,name);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,'SKILL.md'),`---\nname: ${name}\ndescription: >-\n  Format reports\n  using local rules\n${extra}---\n${body}`);return dir
}
const ctx=()=>({projectId:'p',sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()})
it('uses Pi YAML metadata and one content identity for explicit and agent-selected activation',async()=>{
  seed();const catalog=await loadSkillCatalog(home)
  expect(catalog.get('formatter')?.skill.description).toBe('Format reports using local rules')
  const library=await buildActiveSkills(home),prepared=await library.prepareTask('整理报告 /skill:formatter /skill:formatter')
  expect(library.prompt).not.toContain('PRIVATE_BODY');expect(prepared.activatedSkills).toEqual(['formatter'])
  expect(prepared.content).toContain('PRIVATE_BODY');expect(prepared.content).not.toContain('description:')
  const read=library.tools.find(t=>t.name==='read_skill')!
  expect(JSON.parse((await read.execute({name:'formatter'},ctx())).output).content).toBe(readCatalogSkill(catalog.get('formatter')!))
})
it('project overrides mask global skills for both routes, including manual-only entries',async()=>{
  seed();seed(join(home,'.bloma','skills'),'formatter','PROJECT_BODY','disable-model-invocation: true\n')
  const library=await buildActiveSkills(home)
  expect(library.available).toEqual([]);expect(library.tools).toEqual([])
  expect((await library.prepareTask('/skill:formatter 处理报告')).content).toContain('PROJECT_BODY')
  expect((await library.prepareTask('/skill:formatter 处理报告')).content).not.toContain('PRIVATE_BODY')
})
it('explicit commands can select bundled skills without installing user-home copies',async()=>{
  const library=await buildActiveSkills(home,false,true)
  expect((await library.prepareTask('/skill:software-verification 检查入口')).activatedSkills).toEqual(['software-verification'])
  expect((await library.prepareTask('/skill:software-verification 检查入口')).content).toContain('LAUNCH.json')
  expect((await loadSkillCatalog(home)).size).toBe(0)
})
it('rejects changed bytes and reference escapes identically for both readers',async()=>{
  const dir=seed(),catalog=await loadSkillCatalog(home),library=await buildActiveSkills(home),entry=catalog.get('formatter')!
  writeFileSync(join(dir,'reference.txt'),'REFERENCE');expect(readCatalogSkill(entry,'reference.txt')).toBe('REFERENCE')
  writeFileSync(join(home,'outside.txt'),'OUTSIDE');expect(()=>readCatalogSkill(entry,'../../outside.txt')).toThrow('SKILL_RESOURCE_OUTSIDE')
  writeFileSync(join(dir,'SKILL.md'),'changed')
  await expect(library.prepareTask('/skill:formatter task')).rejects.toThrow('SKILL_CHANGED_RELOAD_REQUIRED')
  expect((await library.tools.find(t=>t.name==='read_skill')!.execute({name:'formatter'},ctx())).output).toContain('SKILL_CHANGED_RELOAD_REQUIRED')
})
it('never advertises skills reached through a directory junction outside its root',async()=>{
  seed(join(home,'outside'),'escaped','OUTSIDE');mkdirSync(join(home,'skills'),{recursive:true})
  symlinkSync(join(home,'outside','escaped'),join(home,'skills','escaped'),'junction')
  expect((await loadSkillCatalog(home)).size).toBe(0)
})
it('does not recognize directory aliases or expand unavailable commands',async()=>{
  const dir=seed();writeFileSync(join(dir,'SKILL.md'),'---\nname: actual-name\ndescription: valid metadata\n---\nBODY')
  const catalog=await loadSkillCatalog(home)
  expect((await prepareSkillTask('/skill:formatter task',catalog)).activatedSkills).toEqual([])
  expect((await prepareSkillTask('/skill:actual-name task',catalog)).activatedSkills).toEqual(['actual-name'])
  expect(await prepareSkillTask('ordinary request',catalog)).toEqual({content:'ordinary request',activatedSkills:[]})
})
it('review sessions cannot import maker skills through explicit commands',async()=>{
  seed();const observe=vi.fn()
  await runAgentLoop({system:'independent review',task:'/skill:formatter review',projectId:'review-skill',sessionId:'review-skill',requestId:'r',runtimeScope:'lean-build',accountingRole:'review',env:{},tools:[],maxTokens:1000,maxTurns:1,permissionMode:'allow-all',signal:AbortSignal.timeout(15000),publish:()=>{},onRuntimeObservation:observe,
    query:async function*(_prompt,options){expect(JSON.stringify(options.messages)).not.toContain('PRIVATE_BODY');expect(options.tools?.some(t=>t.name==='read_skill')).toBe(false)
      yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'review complete'}]}};yield{type:'result',stop_reason:'end_turn'}
    }})
  expect(observe.mock.calls[0][0].skills.names).toEqual([])
})

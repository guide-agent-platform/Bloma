import {it,expect,beforeEach,afterEach} from 'vitest'
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {listPromptSlots,readPromptSlot,savePromptSlot,resetPromptSlot} from '../../main/agent/prompting/prompt-service'
let home:string,previous:string|undefined
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'blprompt-retired-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
it('only exposes connected prompt settings by default',()=>{
  expect(listPromptSlots().map(item=>item.id)).toEqual(['sketch-system','loop-system'])
  expect(readPromptSlot('sketch-system').content).toContain('完整单文件HTML')
})
it('retains an old user override as readable inactive history and refuses both save and reset',()=>{
  mkdirSync(join(home,'prompts'));const file=join(home,'prompts/guide-system.md'),text='用户原有规则\n不可覆盖'
  writeFileSync(file,text)
  expect(listPromptSlots().find(item=>item.id==='guide-system')).toMatchObject({enabled:false,has_override:true})
  expect(readPromptSlot('guide-system')).toMatchObject({enabled:false,content:text})
  expect(()=>savePromptSlot('guide-system','replacement')).toThrow('read-only')
  expect(()=>resetPromptSlot('guide-system')).toThrow('read-only')
  expect(readFileSync(file,'utf8')).toBe(text)
})

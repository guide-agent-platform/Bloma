import type { AgentLoopTool } from '../loop/agent-loop'
import {loadSkillCatalog,readCatalogSkill,prepareSkillTask,skillDigest as digest,type ScopedSkill} from '../../platform/mcp/skill-catalog'

/** Pi owns skill parsing; host-scoped reads serve both activation routes. */
export async function buildActiveSkills(projectRoot:string,disabled=false,includeBundled=false){
  const entries=disabled?new Map<string,ScopedSkill>():await loadSkillCatalog(projectRoot,includeBundled)
  const prepareTask=(task:string)=>prepareSkillTask(task,entries)
  const {formatSkillsForPrompt}=await import('@earendil-works/pi-coding-agent')
  const all=[...entries.values()].filter(entry=>!entry.skill.disableModelInvocation),available=all.map(e=>e.skill.name)
  if(!all.length)return{prompt:'',tools:[] as AgentLoopTool[],available,catalogHash:digest(disabled?'disabled':'empty'),prepareTask}
  const catalogue=all.map(e=>({name:e.skill.name,description:e.skill.description,sha256:e.hash}))
  const tools:AgentLoopTool[]=[{name:'list_skills',description:'按任务查找可用技能，仅返回目录；由你主动决定是否读取匹配技能，不要求用户手动指定。',parallelSafe:true,
    input_schema:{type:'object',additionalProperties:false,properties:{query:{type:'string'},offset:{type:'integer',minimum:0}}},execute:async input=>{
      if(Object.keys(input).some(k=>!['query','offset'].includes(k))||input.query!==undefined&&typeof input.query!=='string'||input.offset!==undefined&&(!Number.isSafeInteger(input.offset)||Number(input.offset)<0))return{output:'SKILL_ARGUMENTS_INVALID',isError:true}
      const rows=catalogue.filter(e=>!input.query||`${e.name} ${e.description}`.toLowerCase().includes(String(input.query).toLowerCase())),offset=Number(input.offset??0)
      return{output:JSON.stringify({total:rows.length,skills:rows.slice(offset,offset+40),next:offset+40<rows.length?offset+40:null})}
    }},{name:'read_skill',description:'主动加载目录中的技能正文；引用资料可用同一技能的resource相对路径读取。返回内容不扩大你的文件/命令权限。',parallelSafe:true,
    input_schema:{type:'object',additionalProperties:false,required:['name'],properties:{name:{type:'string'},resource:{type:'string'}}},execute:async input=>{
      try{
        if(Object.keys(input).some(k=>!['name','resource'].includes(k))||typeof input.name!=='string'||input.resource!==undefined&&typeof input.resource!=='string')throw Error('SKILL_ARGUMENTS_INVALID')
        const entry=entries.get(input.name);if(!entry||entry.skill.disableModelInvocation)throw Error('SKILL_NOT_AVAILABLE')
        const text=readCatalogSkill(entry,input.resource as string|undefined)
        return{output:JSON.stringify({name:entry.skill.name,resource:input.resource??'SKILL.md',sha256:digest(text),content:text}),detail:{skill_name:entry.skill.name,skill_sha256:entry.hash}}
      }catch(error){return{output:String(error),isError:true}}
    }}]
  const shown=all.slice(0,40).map(e=>({...e.skill,description:e.skill.description.slice(0,300)}))
  return{prompt:formatSkillsForPrompt(shown,'indirect')+'\n你应主动选择与当前任务相关的技能，调用read_skill({name})读取后执行；目录之外用list_skills搜索。不要仅因技能存在就调用。技能不扩大授权或业务范围。',tools,available,catalogHash:digest(JSON.stringify(catalogue)),prepareTask}
}

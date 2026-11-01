import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveSkillRoots } from '../../platform/mcp/skill-loader'
import { mainRootDir } from '../../platform/paths'
import type { AgentLoopTool } from '../loop/agent-loop'

const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const inside=(path:string,root:string)=>{const rel=relative(root,path);return rel===''||!rel.startsWith('..')&&!isAbsolute(rel)}
/** Pi owns parsing/metadata formatting. Bloma limits the reader to discovered
 * skill directories; loading a skill never grants a new command/write privilege. */
export async function buildActiveSkills(projectRoot:string,disabled=false,includeBundled=false){
  if(disabled)return{prompt:'',tools:[] as AgentLoopTool[],available:[] as string[],catalogHash:digest('disabled')}
  const {loadSkillsFromDir,formatSkillsForPrompt}=await import('@earendil-works/pi-coding-agent')
  const entries=new Map<string,{skill:ReturnType<typeof loadSkillsFromDir>['skills'][number];root:string;hash:string}>()
  const seen=new Set<string>()
  // Shipped production procedures are a last-priority catalog, not user-home
  // copies. Updates ship with the app; project/global customizations win.
  const roots=[...resolveSkillRoots(projectRoot),...(includeBundled?[join(mainRootDir(),'templates','skills')]:[])]
  for(const candidate of roots){
    let root:string;try{root=realpathSync(candidate)}catch{continue}
    for(const skill of loadSkillsFromDir({dir:root,source:'bloma'}).skills){
      if(seen.has(skill.name))continue
      seen.add(skill.name)
      // A higher-priority manual-only entry also masks a bundled/global entry.
      if(skill.disableModelInvocation)continue
      try{const path=realpathSync(skill.filePath);if(!inside(path,root)||statSync(path).size>131072)continue
        entries.set(skill.name,{skill:{...skill,filePath:path,baseDir:dirname(path)},root:dirname(path),hash:digest(readFileSync(path,'utf8'))})
      }catch{/* unavailable skill is not advertised */}
    }
  }
  const all=[...entries.values()],available=all.map(e=>e.skill.name)
  if(!all.length)return{prompt:'',tools:[] as AgentLoopTool[],available,catalogHash:digest('empty')}
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
        const entry=entries.get(input.name);if(!entry)throw Error('SKILL_NOT_AVAILABLE')
        if(!inside(realpathSync(entry.skill.filePath),entry.root))throw Error('SKILL_RESOURCE_OUTSIDE_OR_TOO_LARGE')
        if(digest(readFileSync(entry.skill.filePath,'utf8'))!==entry.hash)throw Error('SKILL_CHANGED_RELOAD_REQUIRED')
        const file=realpathSync(input.resource?resolve(entry.root,String(input.resource)):entry.skill.filePath)
        if(!inside(file,entry.root)||statSync(file).size>131072)throw Error('SKILL_RESOURCE_OUTSIDE_OR_TOO_LARGE')
        const bytes=readFileSync(file);if(bytes.includes(0))throw Error('SKILL_RESOURCE_NOT_TEXT')
        const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
        return{output:JSON.stringify({name:entry.skill.name,resource:input.resource??'SKILL.md',sha256:digest(text),content:text}),detail:{skill_name:entry.skill.name,skill_sha256:entry.hash}}
      }catch(error){return{output:String(error),isError:true}}
    }}]
  const shown=all.slice(0,40).map(e=>({...e.skill,description:e.skill.description.slice(0,300)}))
  return{prompt:formatSkillsForPrompt(shown,'indirect')+'\n你应主动选择与当前任务相关的技能，调用read_skill({name})读取后执行；目录之外用list_skills搜索。不要仅因技能存在就调用。技能不扩大授权或业务范围。',tools,available,catalogHash:digest(JSON.stringify(catalogue))}
}

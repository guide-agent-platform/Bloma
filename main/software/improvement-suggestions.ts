import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import type { SoftwareSuggestions, SoftwareSuggestionDecisionInput } from '../../shared/types'
import type { AgentLoopTool, ToolContext } from '../agent/loop/agent-loop'
import { parseLeanSuggestions, adoptLeanSuggestions } from '../guide/lean-suggestions'
import { stageLeanScope } from '../guide/lean-scope'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { noteLongtermSuggestion } from './longterm-state'

function path(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('SUGGESTIONS_PROJECT_INVALID')
  return join(getPromaHome(), 'software-suggestions', projectId, 'current.json')
}
export function readSoftwareSuggestions(projectId: string): SoftwareSuggestions | undefined {
  if (!existsSync(path(projectId))) return
  const value = JSON.parse(readFileSync(path(projectId), 'utf8')) as SoftwareSuggestions
  if (value.version !== 1 || value.project_id !== projectId || !value.session_id || !Array.isArray(value.items) || value.items.length > 3) throw Error('SUGGESTIONS_RECORD_INVALID')
  const parsed=parseLeanSuggestions(value.items)
  const expected=createHash('sha256').update(JSON.stringify([projectId,value.session_id,value.scope,value.operation,parsed])).digest('hex')
  if(expected!==value.id||parsed.length!==value.items.length||value.items.some((item,index)=>item.id!==parsed[index].id||!['offered','adopt_requested','deferred','rejected','staged'].includes(item.state)))throw Error('SUGGESTIONS_RECORD_INVALID')
  const project = findProject(projectId), scope = prdScopeFingerprint(readPrdBackplane(projectId))
  // Adopted records remain historical; changed scope/operation never consumes
  // a previous suggestion. The on-disk record is preserved for inspection.
  if (value.scope !== scope || value.operation !== (project.lean_operation_id ?? 'initial')) return
  return value
}
function save(value: SoftwareSuggestions) {
  writeTextFileAtomic(join(getPromaHome(), 'software-suggestions', value.project_id, `${value.id}.json`), JSON.stringify(value))
  writeTextFileAtomic(path(value.project_id), JSON.stringify(value))
}
export function offerSoftwareSuggestions(projectId: string, sessionId: string, input: unknown): SoftwareSuggestions {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at) throw Error('SUGGESTIONS_CONFIRMED_SCOPE_REQUIRED')
  const ideas = parseLeanSuggestions(input, brief.requirements.map(item => item.description))
  if (!ideas.length) throw Error('SUGGESTIONS_VALID_IDEAS_REQUIRED')
  const scope = prdScopeFingerprint(brief), operation = project.lean_operation_id ?? 'initial'
  const id = createHash('sha256').update(JSON.stringify([projectId,sessionId,scope,operation,ideas])).digest('hex')
  const previous = readSoftwareSuggestions(projectId)
  if (previous?.id === id) return previous
  // Do not erase a pending human decision when the model offers another idea.
  if (previous?.items.some(item => item.state === 'adopt_requested')) throw Error('SUGGESTIONS_PENDING_USER_CHOICE')
  const value: SoftwareSuggestions = { version:1,id,project_id:projectId,session_id:sessionId,scope,operation,
    items: ideas.map(idea=>({...idea,state:previous?.session_id===sessionId?previous.items.find(item=>item.id===idea.id)?.state??'offered':'offered'})) }
  save(value); return value
}
export function decideSoftwareSuggestion(input: SoftwareSuggestionDecisionInput, busy: boolean, emit: Parameters<typeof stageLeanScope>[5]) {
  if(['archived','abandoned'].includes(findProject(input.project_id).status))throw Error('SUGGESTIONS_PROJECT_ARCHIVED')
  const value = readSoftwareSuggestions(input.project_id)
  if (!value || value.id !== input.set_id || value.session_id !== input.session_id) throw Error('SUGGESTIONS_STALE_OR_OWNER_MISMATCH')
  if (!['adopt','defer','reject'].includes(input.action)) throw Error('SUGGESTIONS_ACTION_INVALID')
  const item = value.items.find(item => item.id === input.suggestion_id)
  if (!item || item.state === 'staged') throw Error('SUGGESTIONS_UNKNOWN_OR_CONSUMED')
  if (input.action !== 'adopt') { item.state=input.action==='defer'?'deferred':'rejected';noteLongtermSuggestion(input.project_id,input.session_id,item,item.state);save(value);return { suggestions:value,detail:'选择已保存，当前任务继续。' } }
  item.state='adopt_requested';save(value)
  if (busy) {noteLongtermSuggestion(input.project_id,input.session_id,item,'adopt_requested');return {suggestions:value,detail:'已记录本轮采用。当前制作继续；结束后点击“更新任务单并确认”，再确认新增范围。'}}
  const selected=value.items.filter(item=>item.state==='adopt_requested'),previous=readPrdBackplane(input.project_id)
  const next=adoptLeanSuggestions(previous,selected,selected.map(item=>item.id))
  stageLeanScope(input.project_id,input.session_id,input.request_id,previous,next,emit,{adoptedSuggestions:selected})
  for(const idea of selected){idea.state='staged';noteLongtermSuggestion(input.project_id,input.session_id,idea,'staged')}
  save(value)
  return {suggestions:value,detail:'任务单已更新，等待你确认后才制作新增功能。'}
}
export function buildImprovementSuggestionTool(projectId: string, changed?:()=>void, beforeExecute?:(ctx:ToolContext)=>void): AgentLoopTool {
  return {
    name:'offer_suggestions', description:'留下0–3条制作中/交付后供参考的改进建议。只有用户明确选择本轮采用并确认范围后才能实现；此工具不暂停任务、不改PRD、不增加验收义务。建议含title/description/benefit/expected。',
    input_schema: {
      type:'object', additionalProperties:false, required:['suggestions'],
      properties: { suggestions: { type:'array', maxItems:3, items: {
        type:'object', required:['title','description','benefit','expected'],
        properties:{title:{type:'string'},description:{type:'string'},benefit:{type:'string'},expected:{type:'string'}}
      } } }
    },
    execute: async(input,ctx) => {
      try {
        beforeExecute?.(ctx)
        if(ctx.projectId!==projectId) throw Error('SUGGESTIONS_PROJECT_MISMATCH')
        ctx.signal.throwIfAborted()
        if(Array.isArray(input.suggestions)&&!input.suggestions.length) return {output:'没有新增建议，继续当前任务。'}
        const value=offerSoftwareSuggestions(projectId,ctx.sessionId,input.suggestions)
        changed?.()
        return {output:JSON.stringify({suggestions:value,note:'仅供参考；未采纳项不进入实现或验收，继续当前任务。'})}
      } catch(error) { return {output:String(error),isError:true} }
    }
  }
}

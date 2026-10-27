import {existsSync,unlinkSync} from 'node:fs'
import {dirname} from 'node:path'
import type {PromptSlotDetail,PromptSlotId,PromptSlotInfo} from '../../../shared/types'
import {getPromptOverridePath,ensureDir} from '../../../storage/config-paths'
import {writeTextFileAtomic} from '../../../storage/json-store'
import {loadPromptOverride,promptOverrideNames} from './prompt-config'
import {LEAN_SKETCH_PROMPT} from './ux-sketch-prompt'
const active=[
  {id:'sketch-system' as const,label:'UX 外观草图提示词',description:'调整当前软件的静态界面方向；完整 HTML 与安全约束由宿主保留。',enabled:true,getDefault:()=>LEAN_SKETCH_PROMPT},
  {id:'loop-system' as const,label:'Agent Loop 追加规则',description:'追加制作规则，保留宿主的需求、权限与验收约束。',enabled:true,getDefault:()=>''},
]
const retired:Partial<Record<PromptSlotId,string>>={'prd-system':'旧 PRD 提炼','guide-system':'旧向导对话','enricher-system':'旧功能项加厚','normalizer-system':'旧修改归一化'}
function slot(id:string){
  const current=active.find(row=>row.id===id)
  if(current)return current
  const label=Object.hasOwn(retired,id)?retired[id as PromptSlotId]:undefined
  if(label)return{id:id as PromptSlotId,label:label+'（历史只读）',description:'对应流程已退役；历史覆盖保留，不参与当前生成。',enabled:false,getDefault:()=>''}
  throw Error('VALIDATION_ERROR: unknown prompt slot')
}
function writable(id:string){const value=slot(id);if(!value.enabled)throw Error('VALIDATION_ERROR: retired prompt slot is read-only');return value}
export function listPromptSlots():PromptSlotInfo[]{
  const visible=[...active,...Object.keys(retired).filter(id=>promptOverrideNames(id).some(name=>existsSync(getPromptOverridePath(name)))).map(slot)]
  return visible.map(({getDefault,...row})=>({...row,has_override:loadPromptOverride(row.id)!==null}))
}
export function readPromptSlot(id:PromptSlotId):PromptSlotDetail{const {getDefault,...row}=slot(id),override=loadPromptOverride(id);return{...row,has_override:override!==null,content:override??getDefault()}}
export function savePromptSlot(id:PromptSlotId,content:string):{saved:true;prompt_id:PromptSlotId}{
  writable(id)
  if(typeof content!=='string'||!content.trim())throw Error('VALIDATION_ERROR: prompt content must not be blank')
  const path=getPromptOverridePath(id);ensureDir(dirname(path));writeTextFileAtomic(path,content.trim());return{saved:true,prompt_id:id}
}
export function resetPromptSlot(id:PromptSlotId):{reset:true;prompt_id:PromptSlotId}{writable(id);for(const name of promptOverrideNames(id)){const path=getPromptOverridePath(name);if(existsSync(path))unlinkSync(path)}return{reset:true,prompt_id:id}}

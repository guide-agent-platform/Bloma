import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { readIndependentDesign, readIndependentPolicy } from './independent-design'
import { observeSoftwareGui } from './gui-observer'
import type { SoftwareRelease } from './release-store'
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance'

export function independentAdapterVersion(root:string){
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null
}
/** Adapter values are selectors only. All action values, assertions and order
 * come from the host-frozen B design, never from implementer-authored code. */
export function independentSuite(projectId:string,root:string):GuiAcceptanceSuite{
  const record=readIndependentDesign(projectId),project=findProject(projectId)
  const policy=readIndependentPolicy()
  if(record?.status!=='frozen'||!record.contract||record.scope!==prdScopeFingerprint(readPrdBackplane(projectId))
    ||record.operation!==(project.lean_operation_id??'initial')||record.design_hash!==project.ux_confirmation?.design_hash
    ||policy?.enabled&&(record.channel_id!==policy.channel_id||record.model!==policy.model))throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  if(!existsSync(file))throw Error('INDEPENDENT_ADAPTER_REQUIRED: 提供版本1的controls逻辑控件名到静态CSS选择器映射，不含输入或断言')
  const text=readFileSync(file,'utf8');if(Buffer.byteLength(text)>32*1024)throw Error('INDEPENDENT_ADAPTER_TOO_LARGE')
  const adapter=JSON.parse(text) as {version:number;design_digest:string;controls:Record<string,string>}
  if(adapter.version!==1||adapter.design_digest!==record.digest||Object.keys(adapter).some(key=>!['version','design_digest','controls'].includes(key))||!adapter.controls||Array.isArray(adapter.controls))throw Error('INDEPENDENT_ADAPTER_INVALID')
  const controls=new Set(record.contract.cases.flatMap(item=>item.steps.flatMap(step=>'control'in step?[step.control]:[])))
  if(Object.keys(adapter.controls).some(key=>!controls.has(key))||[...controls].some(key=>typeof adapter.controls[key]!=='string'||!adapter.controls[key]||adapter.controls[key].length>512
    ||/>>|(?:javascript|xpath|internal|text)\s*=|:has-text\(|\{|\}/i.test(adapter.controls[key])))throw Error('INDEPENDENT_ADAPTER_STATIC_CSS_REQUIRED')
  return {version:1,scope_hash:record.scope,design_hash:record.design_hash,covers:[...new Set(record.contract.cases.map(item=>item.feature))],steps:record.contract.cases.flatMap(item=>item.steps.map((step,index)=>{
    const id=`${item.id}-${index}`
    if(step.kind==='restart')return{id,kind:'restart' as const}
    const selector=adapter.controls[step.control]
    if(step.kind==='fill')return{id,kind:'fill' as const,selector,value:step.value}
    if(step.kind==='click')return{id,kind:'click' as const,selector}
    return{id,kind:'expect' as const,selector,equals:step.equals}
  }))}
}
export async function verifyIndependentDesign(projectId:string,candidate:SoftwareRelease,signal?:AbortSignal){
  const policy=readIndependentPolicy()
  if(!policy&&readIndependentDesign(projectId))throw Error('INDEPENDENT_POLICY_MISSING')
  if(!policy?.enabled)return{status:'disabled' as const}
  const suite=independentSuite(projectId,candidate.root)
  const directory=join(getPromaHome(),'software-independent-evidence',projectId,candidate.id)
  mkdirSync(directory,{recursive:true})
  const result=await observeSoftwareGui({projectId,root:candidate.root,launch:candidate.launch,suite,temporary:directory,screenshotDir:join(directory,'evidence'),signal,purpose:'acceptance'})
  const failed=result.steps.find(step=>!step.passed),step=suite.steps.find(step=>step.id===failed?.id)
  const diagnostic=failed?{id:failed.id,expected:step?.kind==='expect'?step.equals:'冻结的独立业务步骤',actual:typeof failed.actual==='string'?failed.actual.slice(0,1600):failed.actual}:undefined
  const version=independentAdapterVersion(candidate.root)
  writeTextFileAtomic(join(directory,'report.json'),JSON.stringify({result,design:readIndependentDesign(projectId)?.digest,adapter:version,at:new Date().toISOString()}))
  return{...result,diagnostic,report_path:join(directory,'report.json')}
}

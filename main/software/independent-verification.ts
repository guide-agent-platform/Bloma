import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint, trustedAcceptance } from '../project/requirement-contract'
import { readIndependentDesign, readIndependentPolicy, independentDesignVersion } from './independent-design'
import { observeSoftwareGui } from './gui-observer'
import type { SoftwareRelease } from './release-store'
import type { GuiAcceptanceSuite } from '../desktop/gui-acceptance'
import type { IndependentSemantics } from './independent-semantics'
import { currentIndependentSemantics, independentChallengeVersion } from './independent-quality'
import { qualityHash } from './quality-ledger'

export interface IndependentCaseResult { id: string; feature: string; status: 'passed' | 'failed' | 'unverified' | 'not_run'; kind: 'product_assertion' | 'semantic' | 'adapter' | 'environment' | 'none'; expected_source?: string; issues?: string[]; steps: Array<{ id: string; passed: boolean; actual?: unknown }>; error?: string }
export interface IndependentVerification { status: 'disabled' | 'passed' | 'failed' | 'unverified'; semantics?: IndependentSemantics; case_results?: IndependentCaseResult[]; design_version?: string; design_digest?: string
  error?: string; diagnostic?: { id: string; expected: string; actual: unknown }; report_path?: string }

export function independentAdapterVersion(root:string){
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):null
}
/** Adapter values are selectors only. All action values, assertions and order
 * come from the host-frozen B design, never from implementer-authored code. */
export function independentSuite(projectId:string,root:string,caseIds?:string[]):GuiAcceptanceSuite{
  const record=readIndependentDesign(projectId),project=findProject(projectId)
  const policy=readIndependentPolicy(projectId)
  if(record?.status!=='frozen'||!record.contract||record.scope!==prdScopeFingerprint(readPrdBackplane(projectId))
    ||record.operation!==(project.lean_operation_id??'initial')||record.design_hash!==project.ux_confirmation?.design_hash
    ||policy?.enabled&&(record.channel_id!==policy.channel_id||record.model!==policy.model))throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const semantics=currentIndependentSemantics(projectId,record.contract)
  const selected=caseIds?record.contract.cases.filter(c=>caseIds.includes(c.id)):record.contract.cases
  if(!selected.length||caseIds&&selected.length!==caseIds.length||selected.some(c=>semantics.cases.find(s=>s.id===c.id)?.status!=='grounded')||!caseIds&&!semantics.ready)throw Error('INDEPENDENT_SEMANTICS_UNRESOLVED: 不得执行无依据预期或把争议写成产品缺陷')
  const file=join(root,'INDEPENDENT_ADAPTER.json')
  if(!existsSync(file))throw Error('INDEPENDENT_ADAPTER_REQUIRED: 提供版本1的controls逻辑控件名到静态CSS选择器映射，不含输入或断言')
  const text=readFileSync(file,'utf8');if(Buffer.byteLength(text)>32*1024)throw Error('INDEPENDENT_ADAPTER_TOO_LARGE')
  const adapter=JSON.parse(text) as {version:number;design_digest:string;controls:Record<string,string>}
  if(adapter.version!==1||adapter.design_digest!==record.digest||Object.keys(adapter).some(key=>!['version','design_digest','controls'].includes(key))||!adapter.controls||Array.isArray(adapter.controls))throw Error('INDEPENDENT_ADAPTER_INVALID')
  const allowed=new Set(record.contract.cases.flatMap(item=>item.steps.flatMap(step=>'control'in step?[step.control]:[])))
  const controls=new Set(selected.flatMap(item=>item.steps.flatMap(step=>'control'in step?[step.control]:[])))
  if(Object.keys(adapter.controls).some(key=>!allowed.has(key))||[...controls].some(key=>typeof adapter.controls[key]!=='string'||!adapter.controls[key]||adapter.controls[key].length>512
    ||/>>|(?:javascript|xpath|internal|text)\s*=|:has-text\(|\{|\}/i.test(adapter.controls[key])))throw Error('INDEPENDENT_ADAPTER_STATIC_CSS_REQUIRED')
  return {version:1,scope_hash:record.scope,design_hash:record.design_hash,covers:[...new Set(selected.map(item=>item.feature))],steps:selected.flatMap(item=>item.steps.map((step,index)=>{
    const id=`${item.id}-${index}`
    if(step.kind==='restart')return{id,kind:'restart' as const}
    const selector=adapter.controls[step.control]
    if(step.kind==='fill')return{id,kind:'fill' as const,selector,value:step.value}
    if(step.kind==='click')return{id,kind:'click' as const,selector}
    return{id,kind:'expect' as const,selector,equals:step.equals}
  }))}
}
export async function verifyIndependentDesign(projectId:string,candidate:SoftwareRelease,signal?:AbortSignal):Promise<IndependentVerification>{
  const policy=readIndependentPolicy(projectId)
  if(!policy&&readIndependentDesign(projectId))throw Error('INDEPENDENT_POLICY_MISSING')
  if(!policy?.enabled)return{status:'disabled' as const}
  const record=readIndependentDesign(projectId),brief=readPrdBackplane(projectId)
  if(record?.status!=='frozen'||!record.contract)throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  // Check the target even when every proposal is disputed and no process runs.
  if(record.scope!==prdScopeFingerprint(brief)||record.operation!==(findProject(projectId).lean_operation_id??'initial')||record.design_hash!==findProject(projectId).ux_confirmation?.design_hash
    ||record.channel_id!==policy.channel_id||record.model!==policy.model)throw Error('INDEPENDENT_CURRENT_DESIGN_REQUIRED')
  const semantics=currentIndependentSemantics(projectId,record.contract)
  const designVersion=independentDesignVersion(projectId),challengeVersion=independentChallengeVersion(projectId)
  const directory=join(getPromaHome(),'software-independent-evidence',projectId,randomUUID())
  mkdirSync(directory,{recursive:true})
  const cases:IndependentCaseResult[]=[],version=independentAdapterVersion(candidate.root)
  const progress=()=>writeTextFileAtomic(join(directory,'in-progress.json'),JSON.stringify({state:'incomplete',candidate_id:candidate.id,design:record.digest,semantics,cases,at:new Date().toISOString()}))
  progress()
  let diagnostic:IndependentVerification['diagnostic']
  for(const item of record.contract.cases){
    signal?.throwIfAborted()
    const semantic=semantics.cases.find(c=>c.id===item.id)!,requirement=brief.requirements.find(r=>r.id===item.feature)!
    if(semantic.status!=='grounded'){cases.push({id:item.id,feature:item.feature,status:'not_run',kind:'semantic',issues:semantic.issues,steps:[],expected_source:requirement&&trustedAcceptance(brief,requirement)});progress();continue}
    try{
      const suite=independentSuite(projectId,candidate.root,[item.id]),base=join(directory,String(cases.length)),temporary=mkdtempSync(join(tmpdir(),'bloma-b-'))
      // Each case gets fresh data; restart segments within the case retain it.
      let observed:Awaited<ReturnType<typeof observeSoftwareGui>>
      try{observed=await observeSoftwareGui({projectId,root:candidate.root,launch:candidate.launch,suite,temporary,screenshotDir:join(base,'evidence'),signal,purpose:'acceptance'})}
      finally{const target=realpathSync(temporary);if(dirname(target)!==realpathSync(tmpdir())||!basename(target).startsWith('bloma-b-'))throw Error('INDEPENDENT_CLEANUP_PATH_INVALID');rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
      const failed=observed.steps.find(s=>!s.passed),step=suite.steps.find(s=>s.id===failed?.id)
      const assertion=observed.status==='failed'&&step?.kind==='expect'&&observed.error?.startsWith(`GUI_ASSERTION_FAILED:${step.id}`)
      const status=observed.status==='passed'?'passed':assertion?'failed':'unverified'
      cases.push({id:item.id,feature:item.feature,status,kind:status==='passed'?'none':assertion?'product_assertion':failed?'adapter':'environment',steps:observed.steps,error:observed.error,expected_source:trustedAcceptance(brief,requirement)})
      if(failed&&!diagnostic)diagnostic={id:failed.id,expected:step?.kind==='expect'?(step.equals??'冻结的独立业务预期'):'冻结的独立业务步骤',actual:failed.actual}
    }catch(error){signal?.throwIfAborted();cases.push({id:item.id,feature:item.feature,status:'unverified',kind:'adapter',steps:[],error:String(error),expected_source:trustedAcceptance(brief,requirement)})}
    progress()
  }
  const result:IndependentVerification={status:cases.some(c=>c.status==='failed')?'failed':semantics.ready&&cases.every(c=>c.status==='passed')?'passed':'unverified',semantics,case_results:cases,design_digest:record.digest,design_version:designVersion,diagnostic,report_path:join(directory,'report.json')}
  if(independentAdapterVersion(candidate.root)!==version||independentDesignVersion(projectId)!==designVersion||independentChallengeVersion(projectId)!==challengeVersion||prdScopeFingerprint(readPrdBackplane(projectId))!==record.scope)throw Error('INDEPENDENT_INPUT_CHANGED')
  if(result.status==='unverified')result.error=!semantics.ready?'INDEPENDENT_SEMANTICS_UNRESOLVED: 预期或覆盖声明有争议，不是已确认产品缺陷':'INDEPENDENT_EXECUTION_UNVERIFIED: 检查适配器或执行环境'
  writeTextFileAtomic(result.report_path!,JSON.stringify({state:'complete',result,candidate_id:candidate.id,candidate_source:candidate.source.digest,adapter:version,contract_hash:qualityHash(record.contract),at:new Date().toISOString()}))
  return result
}

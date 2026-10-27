import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { it, expect, beforeEach, afterEach } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { readPrdBackplane, markPrdUserConfirmed } from '../../../main/project/prd-store'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { syncDocuments } from '../../../main/project/document-sync'
import { createEvaluationProtocol, bindEvaluationRun, recordEvaluationEvent, summarizeEvaluation, evaluationReport, type EvaluationBinding, type EvaluationEvent, type EvaluationTask } from '../../../main/software/harness-evaluation'
import { saveSoftwareRunState, recordSoftwareRepair } from '../../../main/software/run-state'

let home:string,old:string|undefined,project:ReturnType<typeof createProject>
const task:EvaluationTask={id:'five',goal:'输出5',delivery:'command',requirements:[{description:'输出5',expected:'显示5'}],constraints:['离线'],out_of_scope:['云同步']}
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-evaluation-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:task.goal,delivery:task.delivery,ui:'none',requirements:task.requirements,constraints:task.constraints,out_of_scope:task.out_of_scope}),{projectId:project.project_id,sessionId:'s',source:task.goal,previous:readPrdBackplane(project.project_id),software:true})!
  if(parsed.action!=='brief')throw Error('fixture');syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
function bind(){return bindEvaluationRun(project.project_id,createEvaluationProtocol([task]),task.id,'single','single-1')}
function evidence(binding:EvaluationBinding,directory=home){
  mkdirSync(directory,{recursive:true})
  const ledger=join(directory,'ledger.jsonl'),cost=join(directory,'cost.json'),audit=join(directory,'audit.json')
  const records:Array<Record<string,unknown>>=[{project_id:binding.project_id,event:'query_started',role:'primary',model:'fixture-a',endpoint_host:'offline.invalid'},
    ...[1,1,2].map(index=>({project_id:binding.project_id,event:'transport_started',query_id:'q',transport_index:index}))]
  writeFileSync(ledger,records.map(item=>JSON.stringify(item)).join('\n'))
  writeFileSync(cost,JSON.stringify({source:'offline_fixture',run_id:binding.run_id,project_id:binding.project_id,protocol_digest:binding.protocol.digest,covered_requests:2,spent_rmb:0,external_changes:false}))
  writeFileSync(audit,JSON.stringify({source:'offline_fixture',run_id:binding.run_id,project_id:binding.project_id,protocol_digest:binding.protocol.digest,missed:0,false_positives:0}))
  return{accounting:{evidence:{ledger_path:ledger,ledger_sha256:hash(readFileSync(ledger)),cost_path:cost,cost_sha256:hash(readFileSync(cost))}},audit:{evidence:{path:audit,sha256:hash(readFileSync(audit))}}}
}
function trace(binding:EvaluationBinding,success=true,directory=home):EvaluationEvent[]{
  const proof=evidence(binding,directory)
  const data:Array<[number,string,Record<string,unknown>]>=[
    [1000,'operation_started',{}],[1100,'run_state',{status:'running'}],[1500,'trial_ready',{}],
    [2000,'verification_result',{status:'failed',category:'product_assertion'}],[2100,'repair_started',{category:'product_assertion'}],
    [2600,'run_state',{status:'verifying'}],[2800,'verification_result',{status:'unverified',category:'test_adapter'}],
    [2900,'repair_started',{category:'test_adapter'}],[3200,'run_state',{status:'verifying'}],
    [4000,success?'delivery_final':'run_state',{status:success?'delivered':'cancelled'}],
    [4100,'accounting_snapshot',proof.accounting],[4200,'defect_audit',proof.audit]
  ]
  return data.map(([at,kind,data],index)=>({version:1,seq:index+1,event_id:`event-${index}`,host_id:'owned-host',at,kind,data:{...data,scope_current:binding.scope,variant_current:binding.variant}}))
}
it('seals fixed goals/budgets and rejects changed protocols, unknown routes, repeated binding and paid studies without fresh authorization',()=>{
  const protocol=createEvaluationProtocol([task]);const changed=structuredClone(protocol);changed.tasks[0].requirements[0].expected='99'
  expect(()=>bindEvaluationRun(project.project_id,changed,'five','single','r')).toThrow('PROTOCOL_CHANGED')
  expect(()=>bindEvaluationRun(project.project_id,createEvaluationProtocol([{...task,goal:'different'}]),'five','single','r')).toThrow('TARGET_MISMATCH')
  expect(()=>bindEvaluationRun(project.project_id,protocol,'five','independent','r')).toThrow('VARIANT_ROUTE_MISMATCH')
  expect(()=>bindEvaluationRun(project.project_id,createEvaluationProtocol([task],'paid',1),'five','single','r')).toThrow('NEW_BUDGET_REQUIRED')
  bindEvaluationRun(project.project_id,protocol,'five','single','r')
  expect(()=>bindEvaluationRun(project.project_id,protocol,'five','single','r2')).toThrow('ALREADY_BOUND')
})
it('captures actual host run/repair hooks and deduplicates retried user messages without invoking any model',()=>{
  bind();saveSoftwareRunState({projectId:project.project_id,sessionId:'s',runId:'run',status:'running'})
  recordSoftwareRepair({projectId:project.project_id,sessionId:'s',runId:'run',error:'actual failure',category:'test_adapter'})
  recordEvaluationEvent(project.project_id,'user_intervention',{message_id:'one'});recordEvaluationEvent(project.project_id,'user_intervention',{message_id:'one'})
  const events=readFileSync(join(home,'harness-evaluation',project.project_id,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
  expect(events.some(event=>event.kind==='run_state'&&event.data.status==='running')).toBe(true)
  expect(events.some(event=>event.kind==='repair_started'&&event.data.category==='test_adapter')).toBe(true)
  expect(events.filter(event=>event.kind==='user_intervention')).toHaveLength(1)
})
it('reports exact trace intervals, raw failure history, evidence-derived request counts, audit results and explicit offline boundaries',()=>{
  const binding=bind(),events=trace(binding),summary=summarizeEvaluation(binding,events)
  expect(summary).toMatchObject({comparable:true,first_trial_ms:500,delivery_ms:3000,product_repair_ms:500,harness_repair_ms:300,physical_requests:2,cost_rmb:0,missed_defects:0,false_positives:0})
  expect(summary.failures).toHaveLength(2);expect(summary.note).toContain('离线工程样例')
})
it('keeps cancellation, accounting corruption, missing audits and incomplete trials visible instead of dropping failed runs',()=>{
  const binding=bind(),events=trace(binding,false),summary=summarizeEvaluation(binding,events)
  expect(summary.status).toBe('cancelled');expect(summary.delivery_ms).toBeNull();expect(summary.failures.some(item=>item.status==='cancelled')).toBe(true)
  writeFileSync(join(home,'ledger.jsonl'),'changed evidence')
  const bad=summarizeEvaluation(binding,events);expect(bad.comparable).toBe(false);expect(bad.physical_requests).toBeNull()
  const incomplete=summarizeEvaluation(binding,events.slice(0,5));expect(incomplete.issues).toContain('run incomplete');expect(incomplete.missed_defects).toBeNull()
})
it('rejects changed goals, mixed hosts and broken ordering; never treats a verified checkpoint alone as delivered',()=>{
  const binding=bind(),events=trace(binding)
  events[2].data.scope_current='different';events[4].host_id='another-host';events[5].seq=99
  expect(summarizeEvaluation(binding,events).comparable).toBe(false)
  const partial=trace(binding).filter(event=>event.kind!=='delivery_final');partial.splice(8,0,{version:1,seq:0,event_id:'check',host_id:'owned-host',at:3500,kind:'run_state',data:{status:'verified',scope_current:binding.scope}})
  partial.forEach((event,index)=>event.seq=index+1)
  expect(summarizeEvaluation(binding,partial).delivery_ms).toBeNull()
})
it('uses the final audit snapshot without adding overlapping reviews and rejects a changed execution route',()=>{
  const binding=bind(),events=trace(binding),file=join(home,'audit.json'),proof=JSON.parse(readFileSync(file,'utf8'))
  proof.missed=2;proof.false_positives=1;writeFileSync(file,JSON.stringify(proof))
  const audit=events.at(-1)!;audit.data.evidence={path:file,sha256:hash(readFileSync(file))}
  events.push({...audit,event_id:'repeat-audit',seq:events.length+1,at:4300})
  expect(summarizeEvaluation(binding,events)).toMatchObject({missed_defects:2,false_positives:1})
  events[2].data.variant_current='independent';expect(summarizeEvaluation(binding,events).comparable).toBe(false)
})
it('retains failed offline peers and rejects unmatched task/budget/design pairings; exports reproducible CLI report inputs',()=>{
  const single=bind(),other:EvaluationBinding={...single,project_id:'offline-peer',run_id:'independent-1',variant:'independent'}
  const directory=resolve('run-artifacts/harness-evaluation-offline-20261027'),left=join(directory,'single'),right=join(directory,'independent')
  for(const [binding,path,passed]of [[single,left,false],[other,right,true]] as const){mkdirSync(path,{recursive:true});writeFileSync(join(path,'binding.json'),JSON.stringify(binding));writeFileSync(join(path,'events.jsonl'),trace(binding,passed,path).map(event=>JSON.stringify(event)).join('\n'))}
  const report=evaluationReport([left,right]);expect(report.runs).toHaveLength(2);expect(report.runs[0].status).toBe('cancelled');expect(report.pairs[0].comparable).toBe(true)
  other.design_hash='changed';writeFileSync(join(right,'binding.json'),JSON.stringify(other));expect(evaluationReport([left,right]).pairs[0].comparable).toBe(false)
  other.design_hash=single.design_hash;writeFileSync(join(right,'binding.json'),JSON.stringify(other))
})

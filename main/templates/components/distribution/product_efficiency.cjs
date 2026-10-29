const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto')
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function validateProtocol(value){
 if(value?.version!==1||value.status!=='preregistered'||!Array.isArray(value.tasks)||!value.tasks.length||value.tasks.length>100||new Set(value.tasks.map(task=>task.id)).size!==value.tasks.length||!value.variants?.baseline||!value.variants?.templates||!value.environment||!value.design||!value.model||!value.channel||!value.account_scope||!Number.isFinite(value.budget_rmb)||value.budget_rmb<=0||value.scope!=='real_services')throw Error('EFFICIENCY_PROTOCOL_INVALID')
 for(const row of value.tasks)if(typeof row.id!=='string'||typeof row.input_sha256!=='string'||!/^[a-f0-9]{64}$/.test(row.input_sha256)||!Array.isArray(row.required_cases)||!row.required_cases.length)throw Error('EFFICIENCY_TASK_INVALID')
 return value
}
function createEfficiencyRecorder(directory,protocol){
 validateProtocol(protocol);fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'protocol.json'),value={id:digest(protocol),protocol}
 if(fs.existsSync(file)){if(fs.readFileSync(file,'utf8')!==JSON.stringify(value))throw Error('EFFICIENCY_PROTOCOL_FROZEN')}else fs.writeFileSync(file,JSON.stringify(value),{flag:'wx'})
 function record(run){
  if(!run||!['baseline','templates'].includes(run.variant)||!protocol.tasks.some(task=>task.id===run.task_id)||run.protocol_id!==value.id||typeof run.sample_id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(run.sample_id))throw Error('EFFICIENCY_RUN_INVALID')
  const target=path.join(directory,run.sample_id+'.json');fs.writeFileSync(target,JSON.stringify(run),{flag:'wx',mode:0o600});return{recorded:true}
 }
 return{id:value.id,record,analyze:()=>analyzeEfficiency(protocol,fs.readdirSync(directory).filter(name=>name!=='protocol.json'&&name.endsWith('.json')).map(name=>JSON.parse(fs.readFileSync(path.join(directory,name),'utf8'))),{evidenceRoot:directory})}
}
function analyzeEfficiency(protocol,runs,{evidenceRoot}={}){
 validateProtocol(protocol);const reasons=[],protocolId=digest(protocol),expected=protocol.tasks.length*2,all=[]
 if(!Array.isArray(runs)||runs.length!==expected)reasons.push('MISSING_OR_EXTRA_RUNS')
 if(!evidenceRoot)reasons.push('UNVERIFIED_EVIDENCE_FILES')
 const seen=new Set()
 for(const run of runs??[]){
  if(evidenceRoot){try{verifyEfficiencyEvidence(evidenceRoot,run)}catch{reasons.push('EVIDENCE_FILE_INVALID')}}
  const key=run.task_id+':'+run.variant,task=protocol.tasks.find(task=>task.id===run.task_id)
  if(seen.has(key))reasons.push('DUPLICATE_TASK_VARIANT');seen.add(key)
  if(!task||run.protocol_id!==protocolId||run.version!==protocol.variants[run.variant]||run.input_sha256!==task.input_sha256||run.environment!==protocol.environment||run.design!==protocol.design||run.model!==protocol.model||run.channel!==protocol.channel||run.account_scope!==protocol.account_scope)reasons.push('IDENTITY_MISMATCH')
  if(run.service_scope!=='real'||run.outcome!=='delivered'||run.independent_verification!==true||task?.required_cases.some(id=>run.cases?.[id]!=='passed'))reasons.push('INCOMPLETE_REAL_INDEPENDENT_ACCEPTANCE')
  if(!Number.isFinite(run.elapsed_ms)||run.elapsed_ms<=0||!Number.isFinite(run.cost_rmb)||run.cost_rmb<0||!Number.isSafeInteger(run.physical_requests)||run.physical_requests<1||!Number.isSafeInteger(run.user_interventions)||run.user_interventions<0||!Array.isArray(run.failures)||!Array.isArray(run.evidence)||!run.evidence.length||run.evidence.some(row=>!/^[a-f0-9]{64}$/.test(row.sha256)||typeof row.path!=='string'))reasons.push('MISSING_MEASUREMENT_OR_EVIDENCE')
  all.push({task_id:run.task_id,variant:run.variant,outcome:run.outcome,failures:run.failures??null,user_interventions:run.user_interventions??null})
 }
 if((runs??[]).reduce((total,run)=>total+(Number.isFinite(run.cost_rmb)?run.cost_rmb:0),0)>protocol.budget_rmb)reasons.push('RECORDED_COST_EXCEEDS_BUDGET')
 const eligible=reasons.length===0,pairs=eligible?protocol.tasks.map(task=>{const baseline=runs.find(row=>row.task_id===task.id&&row.variant==='baseline'),templates=runs.find(row=>row.task_id===task.id&&row.variant==='templates');return{task_id:task.id,baseline_ms:baseline.elapsed_ms,templates_ms:templates.elapsed_ms,time_difference_ms:baseline.elapsed_ms-templates.elapsed_ms,cost_difference_rmb:baseline.cost_rmb-templates.cost_rmb}}):[]
 return{protocol_id:protocolId,eligible,reasons:[...new Set(reasons)],runs:all,pairs,claim_scope:eligible?'paired_registered_tasks_only_not_general_reliability':'no_speed_or_quality_claim',evidence_status:evidenceRoot?'file_hashes_checked_provenance_requires_independent_review':'unverified'}
}
function verifyEfficiencyEvidence(directory,run){const root=fs.realpathSync(directory);for(const row of run.evidence??[]){const file=fs.realpathSync(path.resolve(root,row.path)),relative=path.relative(root,file);if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep)||fs.statSync(file).size>32*1024*1024||createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==row.sha256)throw Error('EFFICIENCY_EVIDENCE_INVALID')}return true}
module.exports={createEfficiencyRecorder,analyzeEfficiency,validateProtocol,verifyEfficiencyEvidence}

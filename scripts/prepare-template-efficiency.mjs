// Prepares evidence requirements only. Never calls a provider, resets a ledger,
// or treats local controlled answers as actual model experiments.
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'
const root=path.resolve(import.meta.dirname,'..'),directory=path.resolve(process.env.BLOMA_TEMPLATE_EVIDENCE_DIR||path.join(root,'run-artifacts/template-rollout-20261029'))
fs.mkdirSync(directory,{recursive:true})
const sha=value=>createHash('sha256').update(value).digest('hex'),scenarios=JSON.parse(fs.readFileSync(path.join(root,'docs/05_PROJECT_PLAN/template-scenarios-20261029.json'),'utf8'))
const sources=[]
function walk(dir){for(const name of fs.readdirSync(dir).sort()){const file=path.join(dir,name);if(fs.statSync(file).isDirectory())walk(file);else sources.push({path:path.relative(root,file).replaceAll(path.sep,'/'),sha256:sha(fs.readFileSync(file))})}}
walk(path.join(root,'main/templates/components'))
for(const name of ['ai_service.cjs','ai_routes.cjs','ai_secrets.cjs','http_connector.cjs','webhook_inbox.cjs','document_runtime.cjs','ocr_runtime.cjs','speech_bridge.cjs']){const file=path.join(root,'main/templates/tools',name);sources.push({path:path.relative(root,file).replaceAll(path.sep,'/'),sha256:sha(fs.readFileSync(file))})}
const protocol={version:1,status:'draft_waiting_real_conditions',scope:'real_services',frozen_scenarios_from:scenarios.frozen_from_commit,tasks:scenarios.scenarios.map(row=>({id:row.id,input_sha256:sha(row.requirement),required_cases:row.required_cases})),variants:{baseline:'531fda1',templates:'source:'+sha(JSON.stringify(sources))},environment:null,design:null,model:null,channel:null,account_scope:null,budget_rmb:null,measurement_fields:['elapsed_ms','cost_rmb','physical_requests','user_interventions','failures','cases','evidence'],preflight:['live selector/channel','balance/quota','current rates','ledger and outstanding liability','complete-input reserve and RMB hard guard','independent case expectations']}
fs.writeFileSync(path.join(directory,'efficiency-protocol-draft.json'),JSON.stringify(protocol,null,2))
const readiness={ready:false,status:'waiting_for_real_conditions',missing:['environment/design identity','actual model and live channel','account/write scope','complete RMB budget/preflight','paired real run evidence'],claims:[],local_engineering_evidence:['workbench-report.json','distribution-report.json'],note:'Local evidence is not model quality or acceleration data; draft must be completed and frozen before real runs.'}
fs.writeFileSync(path.join(directory,'efficiency-readiness.json'),JSON.stringify(readiness,null,2));console.log(JSON.stringify(readiness,null,2))

/** No model/network execution. Prepare fixed protocols, bind explicitly chosen
 * projects, attach accounting/audit evidence, or report every retained run. */
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root=resolve('.'),directory=join(root,'run-artifacts/harness-evaluation-cli')
mkdirSync(directory,{recursive:true})
const helper=join(directory,'worker.mjs')
await build({stdin:{resolveDir:root,sourcefile:'evaluation-cli.ts',contents:`
import{readFileSync,writeFileSync,mkdirSync}from'node:fs';import{dirname,resolve}from'node:path';
import{createEvaluationProtocol,bindEvaluationRun,stageEvaluationRun,recordEvaluationEvent,evaluationReport}from'./main/software/harness-evaluation';
import{configureIndependentPolicy,readIndependentPolicy,independentPolicyDigest}from'./main/software/independent-policy';
import{readIndependentDesign}from'./main/software/independent-design';
import{findProject}from'./main/project/project-service';
const [action,...args]=process.argv.slice(2),read=path=>JSON.parse(readFileSync(path,'utf8'));
let result;
if(action==='prepare'){
  const [tasks,out,mode='offline',budget='0']=args;if(!tasks||!out)throw Error('prepare TASKS_JSON OUTPUT_JSON [offline|paid] [BUDGET_RMB]');
  result=createEvaluationProtocol(read(tasks),mode,Number(budget));mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
}else if(action==='configure-single'){
  const [project]=args;result=configureIndependentPolicy(project,{version:1,enabled:false});
}else if(action==='configure-independent'){
  const [project,file]=args;if(!file)throw Error('configure-independent PROJECT_ID POLICY_JSON');
  const policy=read(file);if(policy.enabled!==true)throw Error('INDEPENDENT_ENABLED_POLICY_REQUIRED');
  result=configureIndependentPolicy(project,policy);
}else if(action==='independent-status'){
  const [project]=args;findProject(project);const policy=readIndependentPolicy(project);
  result={project_id:project,variant:policy?.enabled?'independent':'single',policy_digest:independentPolicyDigest(project),
    designer:policy?.enabled?{channel_id:policy.channel_id,model:policy.model}:null,
    design:readIndependentDesign(project)?.status??'not_prepared',admission:'not_checked',
    note:'Only local configuration inspected; channel, balance, authorization and complete-request reserve remain runtime gates. No models invoked.'};
}else if(action==='stage'){
  const [protocol,project,task,variant,run,authorization]=args;
  result=stageEvaluationRun(project,read(protocol),task,variant,run,authorization);
}else if(action==='bind'){
  const [protocol,project,task,variant,run,authorization]=args;
  result=bindEvaluationRun(project,read(protocol),task,variant,run,authorization);
}else if(action==='annotate'){
  const [project,kind,evidence]=args;if(!['accounting_snapshot','defect_audit','user_intervention'].includes(kind))throw Error('Only explicit study annotations allowed');
  result={recorded:recordEvaluationEvent(project,kind,read(evidence))};
}else if(action==='report'){
  const [out,...directories]=args;if(!out||!directories.length)throw Error('report OUTPUT_JSON RUN_DIRECTORY...');
  result=evaluationReport(directories);mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
}else throw Error('Actions: prepare, configure-single, configure-independent, independent-status, stage, bind, annotate, report. No models are invoked.');
console.log(JSON.stringify(result,null,2));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'silent'})
const result=spawnSync(process.execPath,[helper,...process.argv.slice(2)],{cwd:root,env:process.env,encoding:'utf8'})
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1)

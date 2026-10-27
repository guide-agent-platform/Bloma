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
import{createEvaluationProtocol,bindEvaluationRun,recordEvaluationEvent,evaluationReport}from'./main/software/harness-evaluation';
const [action,...args]=process.argv.slice(2),read=path=>JSON.parse(readFileSync(path,'utf8'));
let result;
if(action==='prepare'){
  const [tasks,out,mode='offline',budget='0']=args;if(!tasks||!out)throw Error('prepare TASKS_JSON OUTPUT_JSON [offline|paid] [BUDGET_RMB]');
  result=createEvaluationProtocol(read(tasks),mode,Number(budget));mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
}else if(action==='bind'){
  const [protocol,project,task,variant,run,authorization]=args;
  result=bindEvaluationRun(project,read(protocol),task,variant,run,authorization);
}else if(action==='annotate'){
  const [project,kind,evidence]=args;if(!['accounting_snapshot','defect_audit','user_intervention'].includes(kind))throw Error('Only explicit study annotations allowed');
  result={recorded:recordEvaluationEvent(project,kind,read(evidence))};
}else if(action==='report'){
  const [out,...directories]=args;if(!out||!directories.length)throw Error('report OUTPUT_JSON RUN_DIRECTORY...');
  result=evaluationReport(directories);mkdirSync(dirname(resolve(out)),{recursive:true});writeFileSync(out,JSON.stringify(result,null,2));
}else throw Error('Actions: prepare, bind, annotate, report. No models are invoked.');
console.log(JSON.stringify(result,null,2));
`},outfile:helper,bundle:true,platform:'node',format:'esm',external:['electron'],logLevel:'silent'})
const result=spawnSync(process.execPath,[helper,...process.argv.slice(2)],{cwd:root,env:process.env,encoding:'utf8'})
process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');process.exit(result.status??1)

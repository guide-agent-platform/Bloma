// Offline preparation. Preserve the interrupted pilot-r5 attempt and every older cohort.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const runtime='C:/Users/17359/.codex/worktrees/handoff-recovery-fix/guide-agent-platform-sprint0';
const controls='C:/Users/17359/bex-pv220',cohort=controls+'/pilot-r5a',prior=controls+'/pilot-r4';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const put=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});};
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim();
assert.equal(commit,execFileSync('git',['rev-parse','8224ac0'],{cwd:runtime,encoding:'utf8'}).trim());
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:runtime,encoding:'utf8'}).trim(),'');
assert(!fs.existsSync(cohort),'Keep all earlier preparation evidence');
const {build}=await import(pathToFileURL(runtime+'/node_modules/esbuild/lib/main.js').href);
for(const [entry,name] of [['prepare-experiment-environment.ts','experiment-environment.mjs'],['dispatch-parallel-preflight.ts','parallel-preflight.mjs']]){
 await build({entryPoints:[runtime+'/scripts/'+entry],outfile:runtime+'/dist-main/main/'+name,bundle:true,platform:'node',format:'esm',packages:'external',external:['electron'],logLevel:'silent',banner:{js:"import { createRequire as hostCreateRequire } from 'node:module'; const require = hostCreateRequire(import.meta.url);"}});
}
const old=read(prior+'/snapshot/manifest.json'), previous=read(prior+'/registry.json');
fs.mkdirSync(cohort);
const stage=cohort+'/stage';fs.cpSync(prior+'/snapshot/home',stage,{recursive:true,errorOnExist:true,force:false});
const projects=read(stage+'/projects.json');
projects.projects[0].root_path=path.join(stage,'agent-workspaces',projects.projects[0].workspace_slug,'generated-projects',old.project_id);
fs.writeFileSync(stage+'/projects.json',JSON.stringify(projects,null,2)+'\n');
const sessions=read(stage+'/bloma-agent-sessions.json');
for(const session of sessions.sessions)session.jsonl_path=path.join(stage,'agent-sessions',session.session_id+'.jsonl');
fs.writeFileSync(stage+'/bloma-agent-sessions.json',JSON.stringify(sessions,null,2)+'\n');
put(stage+'/dispatch-experiment-home.json',{version:1});
put(stage+'/dispatch-experiments/'+old.project_id+'.json',old.config);
const cli=args=>execFileSync(process.execPath,[runtime+'/scripts/dispatch-experiment.mjs',...args],{cwd:runtime,encoding:'utf8',windowsHide:true});
cli(['freeze','--home',stage,'--project',old.project_id,'--out',cohort+'/snapshot']);
const frozen=read(cohort+'/snapshot/manifest.json');
for(const [relative,hash]of Object.entries(old.files))if(!['projects.json','bloma-agent-sessions.json'].includes(relative))assert.equal(frozen.files[relative],hash,relative);
assert.equal(frozen.config.runtime_hash,sha(runtime+'/dist-main/main/index.js'));
put(cohort+'/models.json',previous.models);put(cohort+'/limits.json',previous.limits);
const prefix='production-v2-L1-quick-20261021-r5a';
const matrix=JSON.parse(cli(['matrix','--home',cohort+'/cohort','--snapshot',cohort+'/snapshot','--models',cohort+'/models.json','--limits',cohort+'/limits.json','--run-prefix',prefix,'--worker-limit','2','--evaluator','C:/Users/17359/bex-l1q19/evaluator','--task','L1','--repeat','r1']));
for(const row of matrix){
 const priorArm=previous.matrix.find(item=>item.group===row.group);
 const continuation=fs.readFileSync(path.join(priorArm.home,'continuation.txt'),'utf8');
 assert(continuation.startsWith('共同环境交接：'));
 fs.writeFileSync(path.join(row.home,'continuation.txt'),continuation,{flag:'wx'});
 const config=read(path.join(row.home,'dispatch-experiments',old.project_id+'.json'));
 assert.equal(config.runtime_hash,frozen.config.runtime_hash);assert.equal(config.production_protocol,'v2');assert(!config.started_at);
 assert.deepEqual(config.settings,previous.settings);assert.deepEqual(config.limits,previous.limits);
}
put(cohort+'/registry.json',{status:'prepared-not-started',at:new Date().toISOString(),project_id:old.project_id,source_snapshot:prior+'/snapshot',input_hash:frozen.input_hash,
 runtime_sha256:frozen.config.runtime_hash,code_base:commit,models:previous.models,settings:previous.settings,limits:previous.limits,matrix,runtime_root:runtime,actual_model_calls:0,
 business_input_unchanged:true,group_concurrency:1,glm_plan:'coding',worktree_isolation:true,monetary_mode:previous.monetary_mode,
 note:'Fresh cohort after handoff execution-readiness repair. All non-index frozen input files match r4. No paid execution or live qualification yet. Earlier interrupted pilot-r5 preparation is preserved separately; no measured run.'});
const qualifier=fs.readFileSync(controls+'/qualify-cohort-r4-retry-20261021.mjs','utf8')
 .replaceAll("const version='r4-retry-20261021'","const version='r5a'")
 .replaceAll('C:/Users/17359/.codex/worktrees/experiment-readiness-20261020/guide-agent-platform-sprint0',runtime);
fs.writeFileSync(controls+'/qualify-cohort-r5a.mjs',qualifier,{flag:'wx'});
console.log(JSON.stringify({cohort,commit,input_hash:frozen.input_hash,business_input_unchanged:true,model_calls:0}));

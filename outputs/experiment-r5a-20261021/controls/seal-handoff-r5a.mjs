// Seal the already verified repair and fresh local/provider qualifications.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const controls='C:/Users/17359/bex-pv220',cohort=controls+'/pilot-r5a';
const workspace='C:/Users/17359/OneDrive/Desktop/guide-agent-platform-sprint0';
const runtime='C:/Users/17359/.codex/worktrees/handoff-recovery-fix/guide-agent-platform-sprint0';
const evidence='C:/Users/17359/AppData/Local/Bloma/production-v2-L1-20261020';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const put=(p,value)=>fs.writeFileSync(p,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const proof=p=>({path:p,sha256:sha(p)});
const registry=read(cohort+'/registry.json'),release=read(cohort+'/readiness-release.json');
assert(release.passed&&release.rows.length===6&&release.rows.every(r=>r.passed&&r.model_calls===0));
assert.equal(release.runtime.commit,registry.code_base);
assert.equal(execFileSync('git',['rev-parse','HEAD'],{cwd:runtime,encoding:'utf8'}).trim(),registry.code_base);
assert.equal(execFileSync('git',['status','--porcelain'],{cwd:runtime,encoding:'utf8'}).trim(),'');
const validationPath=workspace+'/outputs/handoff-recovery-fix-20261021/validation.json',validation=read(validationPath);
assert.equal(validation.isolated_source_commit,registry.code_base);assert.equal(validation.main_runtime_sha256,release.runtime.main_sha256);
for(const log of validation.logs)assert.equal(sha(log.path),log.sha256);
assert.equal(validation.validation.unit.tests,2503);assert(validation.validation.real_loop_suite.passed&&validation.validation.integration_regression_acceptance.passed);
const unit=fs.readFileSync(runtime+'/run-artifacts/handoff-recovery-fix-20261021/unit-all.log','utf8');
assert(/Test Files\s+270 passed/.test(unit)&&/Tests\s+2503 passed/.test(unit));
const controlsLog=evidence+'/native-controls-r5a.log';
assert(/# pass 6\b/.test(fs.readFileSync(controlsLog,'utf8')));
const providerPaths=['standard','flash'].map(name=>evidence+'/availability-r5a-'+name+'/preflight.json');
const providers=providerPaths.map(read);assert(providers.every(p=>p.passed&&p.live&&p.probes.every(probe=>probe.tool_roundtrip)));
assert.equal(providers[0]['deepseek-flash_physical_peak'],2);assert.equal(providers[1]['glm-5.3-flash_physical_peak'],3);
const qualifiedAt=new Date(Math.min(...providers.map(p=>Date.parse(p.at))));const expiresAt=new Date(qualifiedAt.getTime()+1800000);
assert(Date.now()<expiresAt.getTime(),'Live qualification expired');
const launcher=controls+'/run-one-r5a.mjs';
fs.writeFileSync(launcher,fs.readFileSync(controls+'/run-one-r4.mjs','utf8').replaceAll('pilot-r4','pilot-r5a').replaceAll('supervised-r4-','supervised-r5a-'),{flag:'wx'});
const adapter=controls+'/review-new-G11-r5a.py';
fs.writeFileSync(adapter,fs.readFileSync(controls+'/review-new-G11-r4-selector-v2.py','utf8')
 .replaceAll('experiment-readiness-20261020','handoff-recovery-fix').replaceAll('pilot-r4','pilot-r5a').replaceAll('production-v2-L1-quick-20261020-r4-G11','production-v2-L1-quick-20261021-r5a-G11'),{flag:'wx'});
execFileSync('C:/Users/17359/AppData/Local/Programs/Python/Python313/python.exe',['-c','import ast,sys;ast.parse(open(sys.argv[1],encoding="utf-8").read())',adapter],{windowsHide:true,stdio:'pipe'});
const evaluatorFiles=['C:/Users/17359/bex-l1q19/evaluator/suite.json',adapter,runtime+'/scripts/robustness-ui-replay.py',runtime+'/scripts/capture-owned-window.py'].map(proof);
assert.equal(evaluatorFiles[0].sha256,'08dbe9b458009c4cc22c8f7f8e2136975bcb943c70509c186e0ebe80f8a49fff');
put(cohort+'/readiness-local-only.json',release);
Object.assign(release,{qualified_groups:['G11'],provider_gate:{state:'qualified-for-G11',qualified_at:qualifiedAt.toISOString(),expires_at:expiresAt.toISOString(),evidence:providerPaths.map(proof),physical_preflight_requests:providers.reduce((sum,p)=>sum+p.physical_requests,0),known_remaining_coding_quota:null,scope:'tool-roundtrip-transport-only'}});
fs.writeFileSync(cohort+'/readiness-release.json',JSON.stringify(release,null,2)+'\n');
const audit={at:new Date().toISOString(),runtime_commit:registry.code_base,input_hash:registry.input_hash,main_sha256:release.runtime.main_sha256,
 validation_complete:true,validation:{source:proof(validationPath),results:validation.validation,native_controls:proof(controlsLog)},independent_evaluator_files:evaluatorFiles,
 base_launcher_sha256:sha(controls+'/run-one.mjs'),launcher_sha256:sha(launcher),local_qualification_passed:true,provider_qualified_groups:['G11'],
 measured_model_calls:0,preflight_physical_requests:release.provider_gate.physical_preflight_requests,product_quality:null,
 cohort,runtime_root:runtime,branch:'codex/handoff-recovery-fix',readiness:cohort+'/readiness-release.json',readiness_sha256:sha(cohort+'/readiness-release.json'),
 start_check_command:'node '+launcher+' G11 --check-only',provider_qualification_expires_at:expiresAt.toISOString(),input_business_files_unchanged:true,
 adapter_scope:'Only cohort/runtime/run identity changed from the preserved r4 selector-v2 adapter; the six business predicates are unchanged.',preparation_only:true};
put(cohort+'/audit-ready.json',audit);
console.log(JSON.stringify({state:'ready-for-G11-only',runtime:registry.code_base,input_hash:registry.input_hash,expires_at:expiresAt.toISOString(),measured_model_calls:0,preflight_requests:audit.preflight_physical_requests}));

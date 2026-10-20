// Offline inspection only: reconstruct current prompts without sending a model request.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')
const runRoot = join(root, 'run-artifacts'); mkdirSync(runRoot, { recursive: true })
const temporary = mkdtempSync(join(runRoot, 'production-prompt-inspect-'))
const output = join(temporary, 'inspect.mjs')
await build({ stdin: { resolveDir: root, loader: 'ts', contents: `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getDesktopPhase } from './main/desktop/dispatcher-phases';
import { experimentPhase } from './main/desktop/dispatch-experiment-policy';
import { buildDispatcherSystemPrompt, buildDesktopChildBaseSystem } from './main/desktop/dispatcher-prompt';
import { readProductionDigest, productionContext, inlineProductionContext } from './main/desktop/production-context';
import { readDesktopShapeBriefs } from './main/desktop/requirement-digest';
import { readPrdBackplane } from './main/project/prd-store';
import { buildChildSystemPrompt } from './main/agent/delegation/child-run-context';
import { DEFAULT_DESKTOP_EXECUTION_LIMITS } from './main/desktop/execution-limits';
const args=process.argv.slice(2), option=(name)=>{const i=args.indexOf('--'+name); if(i<0||!args[i+1])throw Error('Missing '+name);return resolve(args[i+1]);};
const home=option('home'), out=option('out'); process.env.PROMA_HOME=home;
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\\uFEFF/,''));
const project=read(join(home,'projects.json')).projects[0];
const config=read(join(home,'dispatch-experiments',project.project_id+'.json'));
const node=experimentPhase(getDesktopPhase('desktop-implement'),config);
const digest=readProductionDigest(project.project_id); if(!digest)throw Error('No confirmed requirements');
const ctx={projectName:project.name,requirementsDigest:digest,quickMode:project.mode==='quick',executionLimits:config.execution_limits??DEFAULT_DESKTOP_EXECUTION_LIMITS,uxSketchPath:'00_UX/confirmed.html',uxDesignPath:'00_UX/confirmed.json',...readDesktopShapeBriefs(project.project_id)};
const dispatcher=buildDispatcherSystemPrompt(node,{...ctx,completedPhases:[],workspaceHint:'产物按相对路径写入（项目目录即工作根；如 00_ARCH/、00_SCAFFOLD/、00_VERIFY/）。'});
const executor=buildChildSystemPrompt(buildDesktopChildBaseSystem(node,{...ctx,role:'implement'}),'implement');
const prd=readPrdBackplane(project.project_id);
const scoped=JSON.stringify(productionContext(prd,'features',[prd.requirements[0].id]));
const inline=JSON.stringify(inlineProductionContext(prd,[prd.requirements[0].id]));
mkdirSync(out,{recursive:true});
for(const [name,value] of Object.entries({'dispatcher-system.md':dispatcher,'executor-system.md':executor,'structured-requirements.md':digest,'single-feature-reading-example.json':scoped}))writeFileSync(join(out,name),value+'\\n',{flag:'wx'});
const baselineIndex=args.indexOf('--baseline');
const baseline=baselineIndex>=0?read(resolve(args[baselineIndex+1])):null;
const summary={scope:'offline prompt and requirement-preservation inspection; not model performance or quality',project_id:project.project_id,features:prd.requirements.map(f=>f.id),structured_requirements_characters:digest.length,dispatcher_system_characters:dispatcher.length,executor_system_characters:executor.length,single_feature_example_characters:scoped.length,inline_single_feature_characters:inline.length,all_features_present:prd.requirements.every(f=>dispatcher.includes(f.id)&&executor.includes(f.id)),baseline:baseline?.role_systems??null,model_calls:0};
writeFileSync(join(out,'summary.json'),JSON.stringify(summary,null,2)+'\\n',{flag:'wx'});console.log(JSON.stringify(summary));
` }, outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent', external: ['electron'],
  banner: { js: "import { createRequire as hostCreateRequire } from 'node:module'; const require = hostCreateRequire(import.meta.url);" } })
const result = spawnSync(process.execPath, [output, ...process.argv.slice(2)], { cwd: root, stdio: 'inherit', windowsHide: true })
process.exitCode = result.status ?? 1

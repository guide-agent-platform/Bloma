/** Read-only source inventory. Does not import application modules or execute a
 * project. Import reachability is not function/control-flow reachability. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'
import ts from 'typescript'

const root=resolve('.'),args=process.argv.slice(2)
const arg=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1]}
const slash=value=>value.replaceAll('\\','/')
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
function inside(parent,path){const rel=relative(parent,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\')}
function outputPath(path){const full=resolve(root,path);if(!inside(root,full)||!/^((run-artifacts|outputs)\/)/.test(slash(relative(root,full))))throw Error('AUDIT_OUTPUT_WORKSPACE_ARTIFACT_REQUIRED');return full}

function parse(path,text){
  const file=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true,path.endsWith('x')?ts.ScriptKind.TSX:ts.ScriptKind.TS)
  const imports=[],calls=[],dynamic=[],strings=[]
  const at=node=>file.getLineAndCharacterOfPosition(node.getStart(file)).line+1
  const add=(node,specifier,kind)=>imports.push({specifier,kind,line:at(node)})
  const visit=node=>{
    if(ts.isImportDeclaration(node)&&ts.isStringLiteralLike(node.moduleSpecifier)){
      const clause=node.importClause,bindings=clause?.namedBindings
      const onlyType=clause?.isTypeOnly||clause&&!clause.name&&bindings&&ts.isNamedImports(bindings)&&bindings.elements.length>0&&bindings.elements.every(item=>item.isTypeOnly)
      add(node,node.moduleSpecifier.text,onlyType?'type':'static_runtime')
    }
    if(ts.isExportDeclaration(node)&&node.moduleSpecifier&&ts.isStringLiteralLike(node.moduleSpecifier)){
      const onlyType=node.isTypeOnly||node.exportClause&&ts.isNamedExports(node.exportClause)&&node.exportClause.elements.length>0&&node.exportClause.elements.every(item=>item.isTypeOnly)
      add(node,node.moduleSpecifier.text,onlyType?'type':'reexport_runtime')
    }
    if(ts.isCallExpression(node)){
      const expression=node.expression.getText(file),argument=node.arguments[0]
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword||expression==='require'){
        if(argument&&ts.isStringLiteralLike(argument))add(node,argument.text,node.expression.kind===ts.SyntaxKind.ImportKeyword?'dynamic_runtime':'require_runtime')
        else dynamic.push({line:at(node),expression:node.getText(file).slice(0,240)})
      }
      calls.push({line:at(node),name:expression})
    }
    if(ts.isStringLiteralLike(node)&&node.text.length<1024)strings.push({line:at(node),value:node.text})
    ts.forEachChild(node,visit)
  }
  visit(file);return{imports,calls,dynamic,strings}
}
function selfTest(){
  const result=parse('fixture.ts',`import type {A} from './types';\nimport {type B} from './only-type';\nimport {type C,run} from './mixed';\nexport type {D} from './other-types';\nexport * from './barrel';\nconst a=import('./lazy'); const b=import(variable);\nconst c=require('./node');const asset='speech_runtime.py';\nfunction nested(){ run(); }`)
  assert.deepEqual(result.imports.map(item=>item.kind),['type','type','static_runtime','type','reexport_runtime','dynamic_runtime','require_runtime'])
  assert.equal(result.dynamic.length,1);assert.equal(result.imports.some(item=>item.specifier==='speech_runtime.py'),false)
  assert.equal(result.calls.some(item=>item.name==='run'),true);assert.equal(result.strings.some(item=>item.value==='speech_runtime.py'),true)
  assert.equal(inside(root,resolve(root,'..')),false)
  console.log(JSON.stringify({self_test:'passed',checks:['type versus value imports','mixed imports','reexports','literal versus computed dynamic imports','require','asset references are not module edges','artifact output bounds']}))
}
if(args.includes('--self-test')){selfTest();process.exit(0)}
const tracked=execFileSync('git',['ls-files','-z'],{cwd:root}).toString('utf8').split('\0').filter(Boolean).map(slash)
const sourcePaths=tracked.filter(path=>/\.(?:[cm]?js|tsx?)$/.test(path)&&/^(main|preload|renderer|shared|storage|tests|scripts)\//.test(path))
const scope=JSON.parse(readFileSync(resolve(root,arg('--scope')??'docs/05_PROJECT_PLAN/workflow-retirement-scope-20261027.json'),'utf8'))
const inputHashes=new Map()
const records=new Map(sourcePaths.map(path=>{
  const bytes=readFileSync(join(root,path));inputHashes.set(path,sha(bytes));return[path,parse(path,bytes.toString('utf8'))]
}))
const options={moduleResolution:ts.ModuleResolutionKind.Bundler,module:ts.ModuleKind.ESNext,allowJs:true,resolveJsonModule:true,jsx:ts.JsxEmit.ReactJSX}
const graph=[]
for(const [from,record]of records)for(const item of record.imports){
  if(!item.specifier.startsWith('.'))continue
  const module=ts.resolveModuleName(item.specifier,join(root,from),options,ts.sys).resolvedModule?.resolvedFileName
  const asset=resolve(root,dirname(from),item.specifier.split('?')[0])
  const found=module??(inside(root,asset)&&existsSync(asset)&&lstatSync(asset).isFile()?asset:undefined)
  graph.push({from,to:found&&inside(root,found)?slash(relative(root,found)):null,resolution:module?'module':found?'asset':'missing',...item})
}
const incoming=path=>graph.filter(edge=>edge.to===path)
const walk=entries=>{const result=new Set(entries),queue=[...entries];while(queue.length){const current=queue.shift();for(const edge of graph)if(edge.from===current&&edge.to&&edge.kind!=='type'&&!result.has(edge.to)){result.add(edge.to);queue.push(edge.to)}}return result}
const entrypoints=['main/index.ts','preload/bridge.ts','renderer/main.tsx']
const reachable=walk(entrypoints)
const categories=new Map()
for(const group of scope.groups){
  const paths=sourcePaths.filter(path=>group.paths?.includes(path)||group.pattern&&new RegExp(group.pattern).test(path))
  for(const path of group.paths??[])if(!records.has(path))throw Error(`AUDIT_SCOPE_FILE_MISSING: ${path}`)
  for(const path of paths){if(categories.has(path))throw Error(`AUDIT_SCOPE_OVERLAP: ${path}`);categories.set(path,group.id)}
}
const modules=[...categories].sort(([a],[b])=>a.localeCompare(b)).map(([path,group])=>{
  const edges=incoming(path),record=records.get(path)
  const assets=(scope.asset_terms??[]).filter(name=>record.strings.some(item=>item.value.includes(name)))
  return{path,group,sha256:inputHashes.get(path),module_load_reachable:reachable.has(path),
    runtime_importers:edges.filter(edge=>edge.kind!=='type'&&!edge.from.startsWith('tests/')),
    type_importers:edges.filter(edge=>edge.kind==='type'&&!edge.from.startsWith('tests/')),
    test_importers:edges.filter(edge=>edge.from.startsWith('tests/')),
    string_references:[...records].flatMap(([from,record])=>record.strings
      .filter(item=>item.value.includes(path)||item.value===basename(path))
      .map(item=>({from,line:item.line,kind:from.startsWith('tests/')?'test_string':'source_string'}))),
    asset_terms:assets,computed_imports:record.dynamic,
    deletion_authorized:false}
})
const anchors=(scope.anchors??[]).map(anchor=>{
  const text=readFileSync(join(root,anchor.path),'utf8'),offset=text.indexOf(anchor.needle)
  if(offset<0)throw Error(`AUDIT_ANCHOR_CHANGED: ${anchor.id}`)
  return{...anchor,line:text.slice(0,offset).split('\n').length}
})
const symbols=(scope.symbols??[]).map(name=>({
  name,
  sites:[...records].flatMap(([path,record])=>record.calls
    .filter(call=>call.name===name||call.name.endsWith('.'+name))
    .map(call=>({path,line:call.line,kind:path.startsWith('tests/')?'test':'source'})))
}))
const references=(scope.asset_terms??[]).map(term=>({
  term,
  sites:[...records].flatMap(([path,record])=>record.strings
    .filter(item=>item.value.includes(term))
    .map(item=>({path,line:item.line,value:item.value.slice(0,240)})))
}))
const templateAssets=(scope.asset_files??[]).map(path=>({path,sha256:sha(readFileSync(join(root,path))),
  references:[...records].flatMap(([from,record])=>record.strings.filter(item=>item.value.includes(path)||item.value.includes(basename(path))).map(item=>({from,line:item.line})))}))
const report={version:1,source_revision:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),scope_version:scope.version,
  scanner_sha256:sha(readFileSync(join(root,'scripts/audit-workflow-retirement.mjs'))),scope_sha256:sha(readFileSync(resolve(root,arg('--scope')??'docs/05_PROJECT_PLAN/workflow-retirement-scope-20261027.json'))),
  source_input_digest:sha(JSON.stringify([...inputHashes])),
  method:'tracked files + TypeScript AST static/type/reexport/literal dynamic/require imports; no app execution; no symbol-level dead-code proof',
  limits:['module loading is not branch execution','symbol call index matches syntax names and does not resolve aliases or prove control flow','computed imports, embedded source and dynamic asset composition need manual inspection; string index excludes literals of 1024 or more characters','zero direct importers is not deletion approval','working source hashes are the authoritative scan inputs'],
  entrypoints,counts:{scanned_sources:sourcePaths.length,module_edges:graph.filter(edge=>edge.resolution==='module').length,asset_edges:graph.filter(edge=>edge.resolution==='asset').length,scoped_modules:modules.length,groups:Object.fromEntries(scope.groups.map(group=>[group.id,modules.filter(item=>item.group===group.id).length]))},
  groups:scope.groups,modules,anchors,symbols,asset_references:references,template_assets:templateAssets,
  unresolved_relative_imports:graph.filter(edge=>!edge.to),computed_imports:[...records].flatMap(([path,record])=>record.dynamic.map(item=>({path,...item}))),
  zero_runtime_importers:modules.filter(item=>!item.runtime_importers.length).map(item=>({path:item.path,group:item.group,type_importers:item.type_importers.length,test_importers:item.test_importers.length,module_load_reachable:item.module_load_reachable}))}
for(const[path,digest]of inputHashes)if(sha(readFileSync(join(root,path)))!==digest)throw Error(`AUDIT_SOURCE_CHANGED_DURING_SCAN: ${path}`)
for(const asset of templateAssets)if(sha(readFileSync(join(root,asset.path)))!==asset.sha256)throw Error(`AUDIT_ASSET_CHANGED_DURING_SCAN: ${asset.path}`)
if(arg('--verify')){
  const saved=JSON.parse(readFileSync(resolve(root,arg('--verify')),'utf8'))
  const comparable=value=>{const{source_revision,...rest}=value;return rest}
  assert.deepEqual(comparable(report),comparable(saved),'AUDIT_SNAPSHOT_STALE: source, scope or scanner changed; regenerate the inventory')
  console.log(JSON.stringify({verification:'passed',snapshot_revision:saved.source_revision,checked_revision:report.source_revision,counts:report.counts}))
}else{
  const output=outputPath(arg('--out')??'run-artifacts/workflow-retirement-source-20261027.json');mkdirSync(dirname(output),{recursive:true});writeFileSync(output,JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify({output,counts:report.counts,unresolved_relative_imports:report.unresolved_relative_imports.length,zero_runtime_importers:report.zero_runtime_importers,computed_imports:report.computed_imports.length}))
}

// Optional real-home metadata audit: raw reads only, aggregate fields only.
// Never import project-service, resolve stored PIDs, read model keys, or start work.
if(arg('--home')){
  const home=resolve(arg('--home')),liveOut=outputPath(arg('--live-out')??'run-artifacts/workflow-retirement-live-20261027.json')
  if(inside(home,liveOut))throw Error('AUDIT_OUTPUT_INSIDE_READ_ONLY_HOME')
  const index=join(home,'projects.json'),before=readFileSync(index),json=JSON.parse(before.toString('utf8'))
  if(!Array.isArray(json.projects))throw Error('AUDIT_PROJECT_INDEX_INVALID')
  const count=(rows,key)=>Object.fromEntries([...new Set(rows.map(key))].sort().map(value=>[value,rows.filter(row=>key(row)===value).length]))
  const rows=json.projects
  let configs=0,malformed=0,missingRoots=0,unsafeIds=0
  const confirmationCounts={prd:0,ux:0,mvp:0,malformed:0,by_state:{}}
  for(const project of rows){
    if(!/^[A-Za-z0-9_-]+$/.test(project.project_id??'')){unsafeIds++;continue}
    if(typeof project.root_path!=='string'||!existsSync(project.root_path))missingRoots++
    const config=join(home,'dispatch-experiments',project.project_id+'.json')
    if(existsSync(config)){configs++;try{const value=JSON.parse(readFileSync(config,'utf8'));if(value.project_id!==project.project_id)malformed++}catch{malformed++}}
    for(const kind of ['prd','ux','mvp']){const path=join(home,'pending-confirmations',`${project.project_id}-${kind}.json`);if(!existsSync(path))continue
      confirmationCounts[kind]++;try{const value=JSON.parse(readFileSync(path,'utf8')),key=`${kind}:${String(value.state??'unknown')}`;confirmationCounts.by_state[key]=(confirmationCounts.by_state[key]??0)+1}catch{confirmationCounts.malformed++}}
  }
  const after=readFileSync(index),live={version:1,at:new Date().toISOString(),scope:'aggregate project index and corresponding confirmation/config metadata; no project names, ids, roots, prompts or keys are exported',
    index_sha256_before:sha(before),index_sha256_after:sha(after),index_stable_during_read:sha(before)===sha(after),
    project_count:rows.length,workflow_versions:count(rows,row=>String(row.workflow_version??'unmarked')),modes:count(rows,row=>String(row.mode??'unknown')),
    stages:count(rows,row=>String(row.current_stage??'unknown')),desktop_phases:count(rows,row=>String(row.desktop_phase??'unset')),statuses:count(rows,row=>String(row.status??'unknown')),
    workflow_by_status:count(rows,row=>`${String(row.workflow_version??'unmarked')}:${String(row.status??'unknown')}`),
    experiment_config_files:configs,experiment_minimal_parse_or_identity_errors:malformed,unsafe_project_ids:unsafeIds,missing_declared_roots:missingRoots,
    confirmations:confirmationCounts,execution_host_environment:{BLOMA_DESKTOP_DISPATCH:process.env.BLOMA_DESKTOP_DISPATCH??null,BLOMA_DISPATCH_EXPERIMENT:process.env.BLOMA_DISPATCH_EXPERIMENT??null},
    limitations:['source host environment is not the running Bloma process environment','experiment file existence and minimal JSON parsing do not prove full validation or execution eligibility','project status fields are snapshots, not new acceptance evidence','no recursive home scan and no writes to the audited home']}
  mkdirSync(dirname(liveOut),{recursive:true});writeFileSync(liveOut,JSON.stringify(live,null,2)+'\n');console.log(JSON.stringify({live_output:liveOut,...live}))
}

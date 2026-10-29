import ts from 'typescript'
import {createHash} from 'node:crypto'
import {componentTestRegistry} from './component-contracts'
import {readFileSync,statSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path'

/** Static relative-import candidates only; never excludes formal acceptance. */
export function changeImpact(root:string,files:string[],paths:string[],signal:AbortSignal){
 if(!Array.isArray(paths)||!paths.length||paths.length>32||paths.some(path=>typeof path!=='string'||!path||path.length>512||isAbsolute(path)||/^[A-Za-z]:/.test(path)))throw Error('IMPACT_PATHS_REQUIRED')
 const base=realpathSync(root),changed=paths.map(path=>{
  const rel=relative(base,resolve(base,path)).replaceAll(sep,'/')
  if(!rel||isAbsolute(rel)||rel==='..'||rel.startsWith('../')||/^(?:\.git|node_modules|\.venv)(?:\/|$)/i.test(rel))throw Error('IMPACT_OUTSIDE_SOURCE')
  return rel
 })
 const code=files.filter(file=>/\.[cm]?[jt]sx?$/.test(file)),selected=code.slice(0,1500),known=new Set([...files,...changed]),reverse=new Map<string,Set<string>>()
 let bytes=0,scanned=0,dynamic=0,unresolved=0,skipped=0
 const unresolvedSpecifiers:Array<{file:string;specifier:string;kind:string}>=[],identity=createHash('sha256')
 const resolveImport=(file:string,specifier:string)=>{
  const target=relative(base,resolve(base,dirname(file),specifier)).replaceAll(sep,'/')
  const alternatives=[target,...['.ts','.tsx','.js','.jsx','.mjs','.cjs','.mts','.cts','.json'].map(ext=>target+ext),...['.ts','.tsx','.js','.mjs','.cjs'].map(ext=>target+'/index'+ext),target.replace(/\.js$/,'.ts'),target.replace(/\.mjs$/,'.mts'),target.replace(/\.cjs$/,'.cts')]
  return alternatives.find(path=>known.has(path))
 }
 for(const file of selected){
  signal.throwIfAborted();const size=statSync(resolve(base,file)).size
  if(size>2*1024*1024||bytes+size>16*1024*1024){skipped++;continue}
  bytes+=size;scanned++
  const text=readFileSync(resolve(base,file),'utf8');identity.update(file).update('\0').update(text).update('\0')
  const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true)
  const add=(value:string)=>{if(value.startsWith('node:'))return;if(!value.startsWith('.')){if(unresolvedSpecifiers.length<30)unresolvedSpecifiers.push({file,specifier:value.slice(0,200),kind:'package_or_alias'});unresolved++;return}const imported=resolveImport(file,value);if(!imported){unresolved++;if(unresolvedSpecifiers.length<30)unresolvedSpecifiers.push({file,specifier:value.slice(0,200),kind:'relative_missing'});return}const parents=reverse.get(imported)??new Set<string>();parents.add(file);reverse.set(imported,parents)}
  const visit=(node:ts.Node)=>{
   if((ts.isImportDeclaration(node)||ts.isExportDeclaration(node))&&node.moduleSpecifier&&ts.isStringLiteral(node.moduleSpecifier))add(node.moduleSpecifier.text)
   if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
    if(node.arguments.length===1&&ts.isStringLiteralLike(node.arguments[0]))add(node.arguments[0].text);else dynamic++
   }
   ts.forEachChild(node,visit)
  };visit(source)
 }
 const affected=new Set(changed),queue=[...changed]
 while(queue.length){signal.throwIfAborted();for(const parent of reverse.get(queue.shift()!)??[])if(!affected.has(parent)){affected.add(parent);queue.push(parent)}}
 const registered=componentTestRegistry().filter(entry=>entry.files.some(file=>changed.includes(relative(base,file).replaceAll(sep,'/'))))
 const modules=[...affected].sort(),tests=[...new Set([...modules.filter(file=>/(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\./.test(file)),...registered.flatMap(entry=>entry.tests).filter(file=>known.has(file)&&/\.(?:test|spec)\./.test(file))])].sort(),unsupported=changed.filter(file=>!code.includes(file))
 return{changed:[...new Set(changed)],affected:modules.slice(0,80),affected_count:modules.length,suggested_tests:tests.slice(0,30),scanned,skipped,unresolved_relative_imports:unresolved,dynamic_imports:dynamic,
  partial:scanned<code.length||unresolved>0||dynamic>0||unsupported.length>0,unsupported_or_missing:unsupported,unresolved_specifiers:unresolvedSpecifiers,
  registered_components:registered.map(entry=>entry.id),source_digest:identity.digest('hex'),suggested_commands:tests.length?[['npx','vitest','run',...tests.slice(0,30)]]:[],executed:false,cache:'none',
  scope:'static_relative_import_candidates',formal_acceptance:'unchanged_full_gate',
  note:'用于开发期选测；未执行测试，不证明无回归。路径别名、包导出、动态加载、跨语言/模板/数据和外部调用未完整解析；无命中或partial时核对原测试入口，正式交付门不跳过。'}
}

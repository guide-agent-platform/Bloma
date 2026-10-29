// Portable Windows product bundle. Read physical .asar bytes even under Electron.
const fs=process.versions.electron?require('original-fs'):require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto')
const hash=value=>createHash('sha256').update(value).digest('hex')
const safe=relative=>typeof relative==='string'&&relative.length<1024&&!path.isAbsolute(relative)&&!relative.includes('\\')&&!relative.split('/').some(part=>!part||part==='.'||part==='..'||part.includes(':'))
async function digest(file){const value=createHash('sha256');for await(const chunk of fs.createReadStream(file))value.update(chunk);return value.digest('hex')}
async function inventory(root){
 const files=[];let total=0
 async function visit(directory,prefix=''){
  for(const name of fs.readdirSync(directory).sort()){
   if(!prefix&&['.git','.ai-secrets','.webhook-inbox','data','run-artifacts'].includes(name)||!prefix&&(/^(?:\.env(?:\.|$)|bloma-channels\.json$|ai-service\.json$)/.test(name)||/\.(?:pem|key)$/.test(name)))throw Error('DISTRIBUTION_PRIVATE_SOURCE_REFUSED')
   const file=path.join(directory,name),relative=prefix+name,info=fs.lstatSync(file)
   if(info.isSymbolicLink())throw Error('DISTRIBUTION_LINK_REFUSED')
   if(info.isDirectory())await visit(file,relative+'/')
   else{if(!info.isFile()||!safe(relative)||files.length>=250000||(total+=info.size)>8*1024**3)throw Error('DISTRIBUTION_LIMIT');files.push({path:relative,size:info.size,sha256:await digest(file)})}
  }
 }
 await visit(root);return files
}
async function copyFiles(source,target,files){fs.mkdirSync(target,{recursive:true});for(const row of files){const destination=path.join(target,...row.path.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(path.join(source,...row.path.split('/')),destination);if(await digest(destination)!==row.sha256)throw Error('DISTRIBUTION_INPUT_CHANGED')}}
const within=(base,target)=>{const rel=path.relative(base,target);return !path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep)}
function checkManifest(value){
 if(value?.format!=='product-distribution-v1'||!/^\w[\w-]{0,79}$/.test(value.product_id)||value.platform!=='win32'||!safe(value.entry)||!Number.isInteger(value.data_schema)||value.data_schema<1||!Array.isArray(value.app)||!Array.isArray(value.runtime)||!Array.isArray(value.required_resources))throw Error('DISTRIBUTION_MANIFEST_INVALID')
 for(const section of ['app','runtime']){const seen=new Set();if(value[section].length>250000)throw Error('DISTRIBUTION_LIMIT');for(const row of value[section]){if(!safe(row.path)||seen.has(row.path)||!Number.isSafeInteger(row.size)||row.size<0||!/^[a-f0-9]{64}$/.test(row.sha256))throw Error('DISTRIBUTION_MANIFEST_INVALID');seen.add(row.path)}}
 if(!value.app.some(row=>row.path===value.entry)||!value.runtime.some(row=>row.path==='electron.exe'))throw Error('DISTRIBUTION_ENTRY_MISSING')
 for(const row of value.required_resources)if(!safe(row.path)||!value.app.some(file=>file.path===row.path&&file.sha256===row.sha256))throw Error('DISTRIBUTION_RESOURCE_MISSING')
 return value
}
function readManifest(root){const file=path.join(root,'distribution.json'),info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024*1024)throw Error('DISTRIBUTION_MANIFEST_INVALID');return checkManifest(JSON.parse(fs.readFileSync(file,'utf8')))}
async function verifyDistribution(root){
 root=fs.realpathSync(root);const manifest=readManifest(root)
 for(const section of ['app','runtime']){
  const directory=path.join(root,section);if(fs.lstatSync(directory).isSymbolicLink())throw Error('DISTRIBUTION_LINK_REFUSED')
  const actual=await inventory(directory);if(JSON.stringify(actual)!==JSON.stringify(manifest[section]))throw Error('DISTRIBUTION_FILES_CHANGED')
 }
 return{manifest,id:hash(JSON.stringify(manifest)),scope:'physical_files_verified_not_clean_machine'}
}
async function buildDistribution({projectDir,runtimeDir,outputDir,productId='bloma-product',entry='product_workbench_electron.cjs',dataSchema=1,requiredResources=[]}){
 const source=fs.realpathSync(projectDir),runtime=fs.realpathSync(runtimeDir),output=path.resolve(outputDir),parent=fs.realpathSync(path.dirname(output))
 if(fs.existsSync(output)||within(source,output)||within(runtime,output)||!safe(entry)||!/^\w[\w-]{0,79}$/.test(productId))throw Error('DISTRIBUTION_TARGET_INVALID')
 const appFiles=await inventory(source),runtimeFiles=await inventory(runtime),manifest=checkManifest({format:'product-distribution-v1',product_id:productId,platform:'win32',entry,data_schema:dataSchema,required_resources:requiredResources,app:appFiles,runtime:runtimeFiles})
 const stage=path.join(parent,'.distribution-'+randomUUID());fs.mkdirSync(stage)
 try{
  await copyFiles(source,path.join(stage,'app'),appFiles);await copyFiles(runtime,path.join(stage,'runtime'),runtimeFiles)
  fs.writeFileSync(path.join(stage,'distribution.json'),JSON.stringify(manifest))
  const verifyEntry=appFiles.find(row=>row.path==='product_distribution.cjs');if(!verifyEntry)throw Error('DISTRIBUTION_VERIFIER_REQUIRED')
  fs.writeFileSync(path.join(stage,'Launch.cmd'),'@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0runtime\\electron.exe" "%~dp0app\\product_distribution.cjs" --verify "%~dp0"\r\nif errorlevel 1 exit /b 1\r\nset "ELECTRON_RUN_AS_NODE="\r\nif not defined APP_DATA_DIR set "APP_DATA_DIR=%LOCALAPPDATA%\\BlomaProducts\\'+productId+'\\data"\r\n"%~dp0runtime\\electron.exe" "%~dp0app"\r\n')
  await verifyDistribution(stage);fs.renameSync(stage,output);return{root:output,id:hash(JSON.stringify(manifest)),scope:'portable_bundle_not_clean_machine_qualified'}
 }catch(error){if(within(parent,stage)&&path.basename(stage).startsWith('.distribution-'))fs.rmSync(stage,{recursive:true,force:true});throw error}
}
function checkData(dataDir,manifest){const file=path.join(dataDir,'records.json');if(fs.existsSync(file)){const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>32*1024*1024)throw Error('DISTRIBUTION_DATA_INVALID');if(JSON.parse(fs.readFileSync(file,'utf8')).schema_version!==manifest.data_schema)throw Error('DISTRIBUTION_DATA_MIGRATION_REQUIRED')}}
function atomicPointer(file,value){const temp=file+'.'+randomUUID()+'.tmp',fd=fs.openSync(temp,'wx',0o600);try{try{fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file)}finally{fs.rmSync(temp,{force:true})}}
async function installDistribution({bundleDir,installDir,dataDir}){
 bundleDir=fs.realpathSync(bundleDir)
 const bundle=await verifyDistribution(bundleDir),target=path.resolve(installDir),data=path.resolve(dataDir)
 if(within(target,data)||within(data,target)||within(path.resolve(bundleDir),target))throw Error('DISTRIBUTION_DATA_MUST_BE_EXTERNAL')
 fs.mkdirSync(target,{recursive:true});fs.mkdirSync(data,{recursive:true});checkData(data,bundle.manifest)
 const owner=path.join(target,'.install.lock'),ownerFd=fs.openSync(owner,'wx',0o600)
 try{
 const configFile=path.join(target,'installation.json'),pointer=path.join(target,'current.json')
 if(fs.existsSync(configFile)){const before=JSON.parse(fs.readFileSync(configFile,'utf8'));if(before.product_id!==bundle.manifest.product_id||before.dataDir!==data)throw Error('DISTRIBUTION_INSTALL_IDENTITY_MISMATCH')}
 const releases=path.join(target,'releases');fs.mkdirSync(releases,{recursive:true});if(fs.lstatSync(releases).isSymbolicLink())throw Error('DISTRIBUTION_LINK_REFUSED')
 const directory=path.join(releases,bundle.id)
 if(!fs.existsSync(directory)){
  const stage=path.join(releases,'.install-'+randomUUID());fs.mkdirSync(stage)
  try{
   await copyFiles(path.join(bundleDir,'app'),path.join(stage,'app'),bundle.manifest.app)
   await copyFiles(path.join(bundleDir,'runtime'),path.join(stage,'runtime'),bundle.manifest.runtime)
   for(const file of ['distribution.json','Launch.cmd'])fs.copyFileSync(path.join(bundleDir,file),path.join(stage,file))
   await verifyDistribution(stage);fs.renameSync(stage,directory)
  }finally{if(within(releases,stage)&&path.basename(stage).startsWith('.install-')&&fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true})}
 }
 await verifyDistribution(directory)
 const oldState=fs.existsSync(pointer)?JSON.parse(fs.readFileSync(pointer,'utf8')):null,previous=oldState?.current===bundle.id?oldState.previous:oldState?.current??null
 atomicPointer(configFile,{product_id:bundle.manifest.product_id,dataDir:data});atomicPointer(pointer,{current:bundle.id,previous})
 fs.writeFileSync(path.join(target,'Start.ps1'),"$ErrorActionPreference='Stop'\n$root=$PSScriptRoot\n$config=Get-Content -LiteralPath (Join-Path $root 'installation.json') -Raw|ConvertFrom-Json\n$state=Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw|ConvertFrom-Json\nif($state.current -notmatch '^[a-f0-9]{64}$'){throw 'Invalid release'}\n$env:APP_DATA_DIR=$config.dataDir\n& (Join-Path $root ('releases\\'+$state.current+'\\Launch.cmd'))\nexit $LASTEXITCODE\n")
 return{current:bundle.id,previous,dataDir:data,root:directory}
 }finally{fs.closeSync(ownerFd);fs.unlinkSync(owner)}
}
async function rollbackDistribution(installDir){
 const root=fs.realpathSync(installDir),pointer=path.join(root,'current.json'),state=JSON.parse(fs.readFileSync(pointer,'utf8')),config=JSON.parse(fs.readFileSync(path.join(root,'installation.json'),'utf8'))
 if(!/^[a-f0-9]{64}$/.test(state.previous))throw Error('DISTRIBUTION_NO_PREVIOUS')
 const bundle=await verifyDistribution(path.join(root,'releases',state.previous));if(bundle.id!==state.previous||bundle.manifest.product_id!==config.product_id)throw Error('DISTRIBUTION_INSTALL_IDENTITY_MISMATCH');checkData(config.dataDir,bundle.manifest)
 atomicPointer(pointer,{current:state.previous,previous:state.current});return{current:state.previous,dataDir:config.dataDir}
}
async function buildSpeechResources({projectDir,pythonExecutable,modelsDir}){
 const {execFileSync}=require('node:child_process'),root=fs.realpathSync(projectDir),resources=path.join(root,'resources'),target=path.join(resources,'speech')
 if(fs.existsSync(target))throw Error('DISTRIBUTION_RESOURCE_TARGET_EXISTS')
 const probe=`import sys,json,importlib.metadata as m\nfrom pathlib import Path\nresult={'base':sys.base_prefix,'version':sys.version.split()[0],'packages':[]}\nfor name in ['numpy','sherpa-onnx','sherpa-onnx-core']:\n d=m.distribution(name);base=Path(d.locate_file('')).resolve();files=[]\n for item in d.files or []:\n  f=Path(d.locate_file(item)).resolve()\n  if f.is_relative_to(base) and f.is_file() and '__pycache__' not in f.parts and f.suffix!='.pyc':files.append({'source':str(f),'path':str(f.relative_to(base)).replace('\\\\','/')})\n result['packages'].append({'name':name,'version':d.version,'files':files})\nprint(json.dumps(result))`
 const info=JSON.parse(execFileSync(pythonExecutable,['-I','-c',probe],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024}))
 const modelSpecs=[['model.int8.onnx','c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51'],['tokens.txt','f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc'],['silero_vad.onnx','a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28']]
 for(const[name,expected]of modelSpecs)if(await digest(path.join(modelsDir,name))!==expected)throw Error('DISTRIBUTION_SPEECH_RESOURCE_CHANGED')
 fs.mkdirSync(resources,{recursive:true});if(fs.lstatSync(resources).isSymbolicLink())throw Error('DISTRIBUTION_LINK_REFUSED')
 const stage=path.join(resources,'.speech-'+randomUUID());fs.mkdirSync(stage)
 try{
  async function copyBase(source,relative=''){
   for(const name of fs.readdirSync(source)){
    const rel=relative?relative+'/'+name:name,file=path.join(source,name),item=fs.lstatSync(file)
    if(item.isSymbolicLink())throw Error('DISTRIBUTION_LINK_REFUSED')
    if(name==='__pycache__'||name.endsWith('.pyc')||rel==='Lib/site-packages'||!relative&&item.isDirectory()&&!['DLLs','Lib'].includes(name))continue
    if(item.isDirectory())await copyBase(file,rel)
    else if(relative||/^(?:python(?:w)?\.exe|python[0-9]+\.dll|python3\.dll|vcruntime.*\.dll|LICENSE.*)$/i.test(name)){const destination=path.join(stage,'python',...rel.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(file,destination);if(await digest(file)!==await digest(destination))throw Error('DISTRIBUTION_INPUT_CHANGED')}
   }
  }
  await copyBase(info.base)
  for(const pkg of info.packages)for(const row of pkg.files){if(!safe(row.path))throw Error('DISTRIBUTION_PYTHON_PACKAGE_INVALID');const destination=path.join(stage,'python/Lib/site-packages',...row.path.split('/'));fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(row.source,destination);if(await digest(row.source)!==await digest(destination))throw Error('DISTRIBUTION_INPUT_CHANGED')}
  fs.writeFileSync(path.join(stage,'python','python'+info.version.split('.').slice(0,2).join('')+'._pth'),'python'+info.version.split('.').slice(0,2).join('')+'.zip\n.\nLib\nDLLs\nLib/site-packages\nimport site\n')
  fs.mkdirSync(path.join(stage,'models'));for(const[name]of modelSpecs)fs.copyFileSync(path.join(modelsDir,name),path.join(stage,'models',name))
  const smoke=JSON.parse(execFileSync(path.join(stage,'python/python.exe'),['-I','-c',"import sys,json,numpy,sherpa_onnx;print(json.dumps({'version':sys.version.split()[0],'prefix':sys.prefix}))"],{encoding:'utf8',windowsHide:true,timeout:30000}))
  if(!within(path.join(stage,'python'),fs.realpathSync(smoke.prefix)))throw Error('DISTRIBUTION_PYTHON_EXTERNAL_PREFIX')
  fs.renameSync(stage,target)
  return{root:target,python_version:info.version,packages:info.packages.map(pkg=>({name:pkg.name,version:pkg.version})),required_resources:[{path:'resources/speech/python/python.exe',sha256:await digest(path.join(target,'python/python.exe'))},...modelSpecs.map(([name,sha256])=>({path:'resources/speech/models/'+name,sha256}))]}
 }finally{if(within(resources,stage)&&path.basename(stage).startsWith('.speech-')&&fs.existsSync(stage))fs.rmSync(stage,{recursive:true,force:true})}
}
module.exports={buildDistribution,verifyDistribution,installDistribution,rollbackDistribution,buildSpeechResources,inventory}
if(require.main===module){(async()=>{if(process.argv[2]!=='--verify')throw Error('DISTRIBUTION_VERIFY_ARGUMENT_REQUIRED');const result=await verifyDistribution(process.argv[3]);console.log(JSON.stringify({ok:true,id:result.id,scope:result.scope}))})().catch(error=>{console.error(error.message);process.exitCode=1})}

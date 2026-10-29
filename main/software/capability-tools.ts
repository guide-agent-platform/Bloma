import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative } from 'node:path'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { findProject } from '../project/project-service'
import { mainRootDir } from '../platform/paths'
import { SPEECH_MODEL_MANIFEST, speechModelRoot } from '../platform/speech/model-manifest'
import { downloadAsset, matchesAsset, type DownloadDeps } from '../platform/speech/model-downloader'
import { runHostSpeechProbe } from '../desktop/speech-verification'
import { executeSoftwareCommand } from './command-runtime'
import { bindSpeechCapability, executionSpeechBinding, speechManifestVersion } from './capability-bindings'
import { projectRuntimeRequest, satisfies } from './runtime-manager'
import type { createSoftwareCollaborationPolicy } from './collaboration-policy'
import { redactSoftwareOutput } from './process-manager'
import { DOCUMENT_COMPONENT, inspectDocumentCapability, prepareDocumentCapability } from './document-capability'

export const SPEECH_COMPONENTS=['speech_runtime.py','speech_locator.py','speech_worker.py','speech_bridge.cjs'] as const
const sha=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const packages=['numpy','sherpa_onnx','sounddevice']
const importProbe=`import importlib,json,sys\nr={'python':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'packages':{}}\nfor name in ${JSON.stringify(packages)}:\n try:\n  m=importlib.import_module(name);r['packages'][name]={'available':True,'version':str(getattr(m,'__version__','unknown')),'path':str(getattr(m,'__file__','unknown'))}\n except Exception as e:r['packages'][name]={'available':False,'error':type(e).__name__+': '+str(e)[:500]}\nprint(json.dumps(r))`
interface PythonProbe {python:string;version:string;packages:Record<string,{available:boolean;version?:string;path?:string;error?:string}>}
type Dependencies={execute?:typeof executeSoftwareCommand;probe?:typeof runHostSpeechProbe;download?:DownloadDeps}
const preparing=new Set<string>()
function componentState(root:string){
  return SPEECH_COMPONENTS.map(name=>{
    const source=readFileSync(join(mainRootDir(),'templates/tools',name)),target=join(root,name)
    if(!existsSync(target))return{name,sha256:sha(source),state:'missing' as const}
    const info=lstatSync(target)
    return{name,sha256:sha(source),state:info.isFile()&&!info.isSymbolicLink()&&sha(readFileSync(target))===sha(source)?'platform_component' as const:'conflict' as const}
  })
}
async function pythonProbe(projectId:string,root:string,signal:AbortSignal,deps:Dependencies){
  const result=await(deps.execute??executeSoftwareCommand)({projectId,root,command:['python','-I','-B','-c',importProbe],signal,timeoutMs:30000})
  if(result.code!==0)throw Error(`CAPABILITY_PYTHON_UNAVAILABLE: ${result.stderr.slice(-1000)}`)
  const value=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)??'') as PythonProbe
  if(!value.python||!value.version||!value.packages)throw Error('CAPABILITY_IMPORT_REPORT_INVALID')
  return value
}
async function resources(root:string,signal:AbortSignal){
  const assets=[]
  for(const asset of Object.values(SPEECH_MODEL_MANIFEST))assets.push({name:asset.name,bytes:asset.bytes,sha256:asset.sha256,validated:await matchesAsset(join(root,asset.name),asset,signal)})
  return{root,ready:assets.every(asset=>asset.validated),assets}
}
export async function inspectSoftwareCapabilities(projectId:string,root:string,signal:AbortSignal,deps:Dependencies={}){
  signal.throwIfAborted()
  const binding=executionSpeechBinding(projectId,root),modelRoot=binding?.model_root??speechModelRoot()
  let python:PythonProbe|{error:string}
  try{python=await pythonProbe(projectId,root,signal,deps)}catch(error){signal.throwIfAborted();python={error:String(error)}}
  return{capability:'speech',provider:'python-sensevoice-v1',components:componentState(root),python,models:await resources(modelRoot,signal),
    business_verification:'unverified',microphone:'not_tested',
    preparation_tool:'prepare_software_capability',node_bridge:'speech_bridge.cjs exports transcribeWav(APP_DATA_DIR下的PCM16 WAV绝对路径)，使用宿主绑定的BLOMA_SPEECH_PYTHON；支持signal和有界timeoutMs，不录音。',
    delivery:'本机资源复用，不代表独立机器交付；原生Node ASR适配未启用。'}
}
export async function prepareSpeechCapability(projectId:string,root:string,signal:AbortSignal,options:{install_dependencies?:boolean;download_models?:boolean}={},deps:Dependencies={}){
  signal.throwIfAborted()
  if(findProject(projectId).workflow_version!=='software-v1')throw Error('CAPABILITY_SOFTWARE_PROJECT_REQUIRED')
  if(preparing.has(projectId))throw Error('CAPABILITY_PREPARATION_BUSY')
  preparing.add(projectId)
  try{
    const components=componentState(root),conflicts=components.filter(item=>item.state==='conflict')
    if(conflicts.length)throw Error(`CAPABILITY_EXISTING_FILES_PRESERVED: ${conflicts.map(item=>item.name).join(',')}`)
    const venv=join(root,'.venv')
    if(existsSync(venv)&&(!lstatSync(venv).isDirectory()||lstatSync(venv).isSymbolicLink()))throw Error('CAPABILITY_VENV_LINK_UNSUPPORTED')
    let python=await pythonProbe(projectId,root,signal,deps)
    const request=projectRuntimeRequest(root,'python')
    if(request&&!satisfies(python.version,request,'python'))throw Error(`CAPABILITY_PYTHON_CONSTRAINT_MISMATCH: ${request}；先prepare_software_environment`)
    const execute=deps.execute??executeSoftwareCommand
    const interpreter=join(venv,process.platform==='win32'?'Scripts/python.exe':'bin/python')
    if(!existsSync(interpreter)){
      const result=await execute({projectId,root,command:['python','-m','venv','.venv'],signal,timeoutMs:120000})
      if(result.code!==0)throw Error(`CAPABILITY_VENV_PREPARATION_FAILED: ${result.stderr.slice(-1000)}`)
      python=await pythonProbe(projectId,root,signal,deps)
    }
    if(packages.some(name=>!python.packages[name]?.available)){
      if(options.install_dependencies===false)throw Error('CAPABILITY_PACKAGES_MISSING: 依赖尚未准备，原有文件保留')
      const result=await execute({projectId,root,command:['python','-m','pip','install','--disable-pip-version-check','numpy==2.5.4','sherpa-onnx==1.13.8','sounddevice==0.5.6'],signal,timeoutMs:300000})
      if(result.code!==0)throw Error(`CAPABILITY_DEPENDENCIES_FAILED: ${redactSoftwareOutput(result.stderr).slice(-1600)}`)
      python=await pythonProbe(projectId,root,signal,deps)
    }
    if(packages.some(name=>!python.packages[name]?.available))throw Error('CAPABILITY_IMPORTS_NOT_READY')
    const modelRoot=executionSpeechBinding(projectId,root)?.model_root??speechModelRoot(),rel=relative(realpathSync(root),modelRoot)
    if(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('../')&&!rel.startsWith('..\\'))throw Error('CAPABILITY_MODELS_MUST_BE_OUTSIDE_PROJECT')
    if(options.download_models){
      const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(Error('CAPABILITY_RESOURCE_DEADLINE')),300000)
      try{for(const asset of Object.values(SPEECH_MODEL_MANIFEST))await downloadAsset(asset,modelRoot,AbortSignal.any([signal,deadline.signal]),()=>{},deps.download)}finally{clearTimeout(timer)}
    }
    const models=await resources(modelRoot,signal)
    if(!models.ready)throw Error('CAPABILITY_MODEL_RESOURCES_MISSING: 缓存未通过字节/哈希校验；可用download_models:true准备固定公开资源，不调用付费API')
    for(const item of components){
      signal.throwIfAborted()
      if(item.state==='missing')writeFileSync(join(root,item.name),readFileSync(join(mainRootDir(),'templates/tools',item.name)),{flag:'wx',mode:0o600})
    }
    if(componentState(root).some(item=>item.state!=='platform_component'))throw Error('CAPABILITY_COMPONENTS_CHANGED_DURING_PREPARATION')
    signal.throwIfAborted()
    bindSpeechCapability(projectId,{provider:'python-sensevoice-v1',model_root:realpathSync(modelRoot),manifest_sha256:speechManifestVersion(),
      components:Object.fromEntries(components.map(item=>[item.name,item.sha256])),dependencies:Object.fromEntries(packages.map(name=>[name,{version:python.packages[name].version??'unknown',path:python.packages[name].path??'unknown'}])),at:new Date().toISOString()})
    const fixed_audio=await(deps.probe??runHostSpeechProbe)({projectId,root,speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe',rate_argument:true},signal})
    signal.throwIfAborted()
    return{status:fixed_audio.status==='passed'?'prepared':fixed_audio.status,capability:'speech',components:componentState(root),python,models,fixed_audio,microphone:'not_tested',product_verification:'unverified',
      next:'用产品实际入口接入组件并做GUI/业务验收；固定音频不认证麦克风，不降低已确认预期。'}
  }finally{preparing.delete(projectId)}
}
export function buildCapabilityTools(projectId:string,policy:ReturnType<typeof createSoftwareCollaborationPolicy>,parent:boolean):AgentLoopTool[]{
  const inspect:AgentLoopTool={name:'inspect_software_capabilities',parallelSafe:true,description:'只读检查speech语音资源或documents产品文本解析组件/实际依赖；默认speech兼容旧调用。不下载、不安装、不录音、不签发业务PASS。',input_schema:{type:'object',additionalProperties:false,properties:{capability:{type:'string',enum:['speech','documents']}}},
    execute:async(input,ctx)=>{try{if(ctx.projectId!==projectId)throw Error('CAPABILITY_PROJECT_MISMATCH');if(Object.keys(input).some(key=>key!=='capability')||input.capability!==undefined&&!['speech','documents'].includes(String(input.capability)))throw Error('CAPABILITY_ARGUMENTS_INVALID');return{output:JSON.stringify(await(input.capability==='documents'?inspectDocumentCapability:inspectSoftwareCapabilities)(projectId,findProject(projectId).root_path,ctx.signal))}}catch(error){return{output:redactSoftwareOutput(String(error)),isError:true}}}}
  const prepare:AgentLoopTool={name:'prepare_software_capability',description:'受控准备speech语音或documents文档/字面检索/精确引用组件，保护已有文件。documents默认不安装；install_dependencies:true按npm工程准备固定依赖，保留其它包管理器锁文件。speech沿原依赖/资源准备方式；download_models仅speech支持。不调用付费端点，不签发产品PASS。',
    input_schema:{type:'object',additionalProperties:false,required:['capability'],properties:{capability:{type:'string',enum:['speech','documents']},install_dependencies:{type:'boolean'},download_models:{type:'boolean'}}},
    execute:async(input,ctx)=>{
      try{policy.assertCommand(ctx);if(ctx.projectId!==projectId||!['speech','documents'].includes(String(input.capability))||Object.keys(input).some(key=>!['capability','install_dependencies','download_models'].includes(key))||['install_dependencies','download_models'].some(key=>input[key]!==undefined&&typeof input[key]!=='boolean'))throw Error('CAPABILITY_ARGUMENTS_INVALID')
        if(input.capability==='documents'){
          if(input.download_models!==undefined)throw Error('DOCUMENT_DOWNLOAD_MODELS_UNSUPPORTED')
          for(const path of [DOCUMENT_COMPONENT,'package.json','package-lock.json'])policy.assertFileWrite(path,ctx)
          const result=await prepareDocumentCapability(projectId,findProject(projectId).root_path,ctx.signal,input.install_dependencies===true)
          return{output:redactSoftwareOutput(JSON.stringify(result)),isError:result.status!=='prepared'}
        }
        for(const path of [...SPEECH_COMPONENTS,'.venv/pyvenv.cfg'])policy.assertFileWrite(path,ctx)
        const result=await prepareSpeechCapability(projectId,findProject(projectId).root_path,ctx.signal,input as {install_dependencies?:boolean;download_models?:boolean})
        return{output:JSON.stringify(result),isError:result.status!=='prepared'}
      }catch(error){return{output:redactSoftwareOutput(String(error)),isError:true}}
    }}
  return parent?[inspect,prepare]:[inspect]
}

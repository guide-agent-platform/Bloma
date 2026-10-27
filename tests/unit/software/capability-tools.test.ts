import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
vi.mock('../../../main/platform/speech/model-manifest',async original=>{
  const real=await original<typeof import('../../../main/platform/speech/model-manifest')>()
  const asset=(name:string)=>({name,url:'https://never-fetched.invalid/'+name,bytes:3,sha256:'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'})
  return{...real,SPEECH_MODEL_MANIFEST:{model:asset('model.int8.onnx'),tokens:asset('tokens.txt'),vad:asset('silero_vad.onnx')}}
})
import { createProject } from '../../../main/project/project-service'
import { prepareSpeechCapability, inspectSoftwareCapabilities, SPEECH_COMPONENTS } from '../../../main/software/capability-tools'
import { capabilityEnvironment, speechCapabilityBinding, bindSpeechCapability } from '../../../main/software/capability-bindings'
import { prepareSoftwareRelease, validateSoftwareRelease } from '../../../main/software/release-store'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { speechModelRoot } from '../../../main/platform/speech/model-manifest'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { runHostSpeechProbe } from '../../../main/desktop/speech-verification'

let home:string,previous:string|undefined,project:ReturnType<typeof createProject>
const imported={python:'fixture-python',version:'3.13.7',packages:Object.fromEntries(['numpy','sherpa_onnx','sounddevice'].map(name=>[name,{available:true,version:'fixture',path:'fixture-site-packages/'+name}]))}
const execute=vi.fn(async()=>({code:0,stdout:JSON.stringify(imported),stderr:''}))
const probe=vi.fn(async(_input:unknown)=>({probe_version:1,status:'passed' as const,real_decode_calls:3,tests:['flat','column','stereo'].map(name=>({name,passed:true})),microphone:{status:'not_run'}}))
beforeEach(()=>{previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-capability-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'});vi.clearAllMocks()
  const python=join(project.root_path,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');mkdirSync(join(python,'..'),{recursive:true});writeFileSync(python,'fixture only, not a real decoder')
})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
function assets(root=speechModelRoot()){mkdirSync(root,{recursive:true});for(const name of ['model.int8.onnx','tokens.txt','silero_vad.onnx'])writeFileSync(join(root,name),'abc');return root}
const signal=()=>new AbortController().signal
it('prepares and reuses pinned resources/components without downloads, marks preparation separately and never requests a microphone',async()=>{
  assets();const fetch=vi.fn(async()=>{throw Error('no network')})
  const result=await prepareSpeechCapability(project.project_id,project.root_path,signal(),{install_dependencies:false},{execute,probe,download:{fetchImpl:fetch}})
  expect(result.status).toBe('prepared');expect(result.product_verification).toBe('unverified');expect(result.microphone).toBe('not_tested')
  expect(fetch).not.toHaveBeenCalled();expect(SPEECH_COMPONENTS.every(name=>existsSync(join(project.root_path,name)))).toBe(true)
  expect(probe.mock.calls[0][0]).not.toHaveProperty('microphone')
  const env=capabilityEnvironment(project.project_id,project.root_path);expect(env.BLOMA_SPEECH_MODEL_DIR).toBe(speechModelRoot());expect(env.BLOMA_SPEECH_PYTHON).toContain('.venv')
  const before=readFileSync(join(project.root_path,'speech_runtime.py'))
  await prepareSpeechCapability(project.project_id,project.root_path,signal(),{install_dependencies:false},{execute,probe,download:{fetchImpl:fetch}})
  expect(readFileSync(join(project.root_path,'speech_runtime.py'))).toEqual(before);expect(fetch).not.toHaveBeenCalled()
})
it('preserves conflicting user implementations and rejects unknown arguments before execution',async()=>{
  writeFileSync(join(project.root_path,'speech_runtime.py'),'user implementation')
  await expect(prepareSpeechCapability(project.project_id,project.root_path,signal(),{},{execute,probe})).rejects.toThrow('EXISTING_FILES_PRESERVED')
  expect(execute).not.toHaveBeenCalled();expect(readFileSync(join(project.root_path,'speech_runtime.py'),'utf8')).toBe('user implementation')
  const tools=buildSoftwareAgentTools(project.project_id,'parent',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
  const result=await tools.find(tool=>tool.name==='prepare_software_capability')!.execute({capability:'ocr'},{projectId:project.project_id,sessionId:'s',requestId:'r',signal:signal(),state:createToolState()})
  expect(result.isError).toBe(true)
  const child=buildSoftwareAgentTools(project.project_id,'implement',createSoftwareCollaborationPolicy(project.project_id,project.root_path,'s'))
  expect(child.some(tool=>tool.name==='inspect_software_capabilities')).toBe(true);expect(child.some(tool=>tool.name==='prepare_software_capability')).toBe(false)
})
it('reports missing assets without writes/downloads and fails closed on cancellation and Python constraint mismatch',async()=>{
  const fetch=vi.fn();await expect(prepareSpeechCapability(project.project_id,project.root_path,signal(),{install_dependencies:false},{execute,probe,download:{fetchImpl:fetch}})).rejects.toThrow('MODEL_RESOURCES_MISSING')
  expect(fetch).not.toHaveBeenCalled();expect(probe).not.toHaveBeenCalled();expect(speechCapabilityBinding(project.project_id)).toBeUndefined()
  const controller=new AbortController();controller.abort();await expect(prepareSpeechCapability(project.project_id,project.root_path,controller.signal,{},{execute,probe})).rejects.toThrow()
  writeFileSync(join(project.root_path,'.python-version'),'3.12');await expect(prepareSpeechCapability(project.project_id,project.root_path,signal(),{},{execute,probe})).rejects.toThrow('CONSTRAINT_MISMATCH')
})
it('requires an explicit project provider binding before software ASR verification and keeps execution offline',async()=>{
  for(const name of SPEECH_COMPONENTS)writeFileSync(join(project.root_path,name),'fixture missing provider binding')
  let calls=0
  const result=await runHostSpeechProbe({projectId:project.project_id,root:project.root_path,speech:{module:'speech_runtime',factory:'SpeechEngine',method:'transcribe'},spawn:async()=>{calls++;return{code:0,stdout:'{}',stderr:''}}})
  expect(result.status).toBe('environment_blocked');expect(result.error).toContain('PREPARATION_REQUIRED');expect(calls).toBe(0)
})
it('downloads only on an explicit request, validates hashes and reuses the cache on a second preparation',async()=>{
  const fetch=vi.fn(async()=>new Response('abc',{status:200}))
  await prepareSpeechCapability(project.project_id,project.root_path,signal(),{download_models:true,install_dependencies:false},{execute,probe,download:{fetchImpl:fetch}})
  expect(fetch).toHaveBeenCalled();fetch.mockClear()
  await prepareSpeechCapability(project.project_id,project.root_path,signal(),{download_models:true,install_dependencies:false},{execute,probe,download:{fetchImpl:fetch}})
  expect(fetch).not.toHaveBeenCalled();writeFileSync(join(speechModelRoot(),'tokens.txt'),'bad')
  const facts=await inspectSoftwareCapabilities(project.project_id,project.root_path,signal(),{execute});expect(facts.models.ready).toBe(false)
})
it('freezes release resource identity and environment independently of a later preparation, and refuses changed model bytes',async()=>{
  const firstRoot=assets();await prepareSpeechCapability(project.project_id,project.root_path,signal(),{install_dependencies:false},{execute,probe})
  writeFileSync(join(project.root_path,'app.cjs'),'console.log(5)');writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']}))
  const release=await prepareSoftwareRelease(project.project_id,project.root_path)
  const first=speechCapabilityBinding(project.project_id)!,other=assets(join(home,'other-resources'));bindSpeechCapability(project.project_id,{...first,model_root:other})
  expect(capabilityEnvironment(project.project_id,release.root).BLOMA_SPEECH_MODEL_DIR).toBe(firstRoot)
  expect(capabilityEnvironment(project.project_id,project.root_path).BLOMA_SPEECH_MODEL_DIR).toBe(other)
  await validateSoftwareRelease(project.project_id,release)
  writeFileSync(join(firstRoot,'tokens.txt'),'bad');await expect(validateSoftwareRelease(project.project_id,release)).rejects.toThrow('SPEECH_RESOURCE_BYTES_CHANGED')
  const before=JSON.stringify(speechCapabilityBinding(project.project_id));expect(()=>bindSpeechCapability(project.project_id,{...first,manifest_sha256:'f'.repeat(64)})).toThrow('BINDING_CHANGED')
  expect(JSON.stringify(speechCapabilityBinding(project.project_id))).toBe(before)
})
it('binds explicit capability metadata, keeps textual speech obligations despite an empty model tag, and rejects unknown capabilities',()=>{
  const parse=(capabilities:unknown)=>parseLeanBrief(JSON.stringify({action:'brief',goal:'文件转写',ui:'required',requirements:[{description:'音频文件转文字',expected:'显示实际识别的文字',capabilities}]}),{projectId:project.project_id,sessionId:'s',source:'文件转写',previous:readPrdBackplane(project.project_id),software:true})
  const result=parse([]);expect(result?.action).toBe('brief');if(result?.action==='brief')expect(result.brief.requirements[0].capabilities).toEqual(['speech'])
  expect(parse(['unsupported-engine'])).toBeUndefined()
})

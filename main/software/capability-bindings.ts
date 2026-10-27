import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { SPEECH_MODEL_MANIFEST } from '../platform/speech/model-manifest'

export interface SpeechCapabilityBinding {
  provider:'python-sensevoice-v1'; model_root:string; manifest_sha256:string
  components:Record<string,string>; dependencies:Record<string,{version:string;path:string}>; at:string
}
export const speechManifestVersion=()=>createHash('sha256').update(JSON.stringify(SPEECH_MODEL_MANIFEST)).digest('hex')
export const CAPABILITY_CAPSULE='.bloma-capabilities.json'
function path(projectId:string){
  if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('CAPABILITY_PROJECT_INVALID')
  return join(getPromaHome(),'software-environments',projectId,'capabilities.json')
}
function validateBinding(value:{version:number;speech?:SpeechCapabilityBinding}){
  if(value.version!==1)throw Error('CAPABILITY_BINDING_INVALID')
  const speech=value.speech
  if(!speech||!isAbsolute(speech.model_root)||speech.provider!=='python-sensevoice-v1'||speech.manifest_sha256!==speechManifestVersion()
    ||!speech.components||Array.isArray(speech.components)||!speech.dependencies||Array.isArray(speech.dependencies)
    ||['speech_runtime.py','speech_locator.py','speech_worker.py','speech_bridge.cjs'].some(name=>!/^[a-f0-9]{64}$/.test(speech.components[name]??''))
    ||['numpy','sherpa_onnx','sounddevice'].some(name=>typeof speech.dependencies[name]?.version!=='string'||typeof speech.dependencies[name]?.path!=='string'))throw Error('SPEECH_CAPABILITY_BINDING_CHANGED')
  return speech
}
function readBinding(file:string):SpeechCapabilityBinding|undefined{
  if(!existsSync(file))return
  return validateBinding(JSON.parse(readFileSync(file,'utf8')))
}
export function speechCapabilityBinding(projectId:string):SpeechCapabilityBinding|undefined{return readBinding(path(projectId))}
export function executionSpeechBinding(projectId:string,root?:string):SpeechCapabilityBinding|undefined{
  return root&&existsSync(join(root,CAPABILITY_CAPSULE))?readBinding(join(root,CAPABILITY_CAPSULE)):speechCapabilityBinding(projectId)
}
export function bindSpeechCapability(projectId:string,speech:SpeechCapabilityBinding){
  validateBinding({version:1,speech});writeTextFileAtomic(path(projectId),JSON.stringify({version:1,speech}))
}
export function capabilityEnvironment(projectId:string,root?:string):Record<string,string>{
  const speech=executionSpeechBinding(projectId,root);if(!speech)return{}
  return{BLOMA_SPEECH_MODEL_DIR:speech.model_root,BLOMA_SPEECH_OFFLINE:'1',
    ...(root?{BLOMA_SPEECH_PYTHON:join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python')}:{})}
}
export function capabilityBindingVersion(projectId:string){
  const file=path(projectId);return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):'none'
}

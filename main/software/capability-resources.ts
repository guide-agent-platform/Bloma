import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { SPEECH_MODEL_MANIFEST } from '../platform/speech/model-manifest'
import { matchesAsset } from '../platform/speech/model-downloader'
import { executionSpeechBinding, speechManifestVersion } from './capability-bindings'

export interface SpeechResourceSnapshot {provider:'python-sensevoice-v1';root:string;manifest_sha256:string}
export async function validateSpeechResources(value:SpeechResourceSnapshot,signal?:AbortSignal){
  if(value.provider!=='python-sensevoice-v1'||value.manifest_sha256!==speechManifestVersion()||await realpath(value.root)!==value.root)throw Error('SPEECH_RESOURCE_IDENTITY_CHANGED')
  for(const asset of Object.values(SPEECH_MODEL_MANIFEST)){
    signal?.throwIfAborted()
    if(!await matchesAsset(join(value.root,asset.name),asset,signal))throw Error(`SPEECH_RESOURCE_BYTES_CHANGED: ${asset.name}`)
  }
}
export async function snapshotSpeechResources(projectId:string,root:string,signal?:AbortSignal):Promise<SpeechResourceSnapshot|undefined>{
  const binding=executionSpeechBinding(projectId,root);if(!binding)return
  const value:SpeechResourceSnapshot={provider:binding.provider,root:binding.model_root,manifest_sha256:binding.manifest_sha256}
  await validateSpeechResources(value,signal);return value
}

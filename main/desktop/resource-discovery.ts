import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { readProjectAttempts } from '../platform/execution/project-attempts'
import { matchesAsset } from '../platform/speech/model-downloader'
import { SPEECH_MODEL_MANIFEST, type SpeechModelManifest } from '../platform/speech/model-manifest'
import { findProject } from '../project/project-service'
import { buildChildExecEnv, defaultResolvePython } from './child-exec-tool'
import { execFileDriverSpawn, type DriverSpawn } from './process-driver'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
const validated = new Map<string, { signature: string; valid: boolean }>()
/** No downloads. Rehash on identity/size/mtime/ctime or manifest changes. */
export async function inspectSpeechResources(root: string, manifest: SpeechModelManifest = SPEECH_MODEL_MANIFEST, refresh = false, signal?: AbortSignal) {
  const assets = []
  for (const asset of Object.values(manifest)) {
    signal?.throwIfAborted()
    const path = join(root, asset.name)
    let signature: string
    try { const s = statSync(path); signature = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${asset.sha256}` }
    catch { assets.push({ name: asset.name, status: 'missing', reused_check: false }); continue }
    const saved = validated.get(path)
    const reused = !refresh && saved?.signature === signature
    const valid = reused ? saved.valid : await matchesAsset(path, asset, signal)
    validated.set(path, { signature, valid })
    assets.push({ name: asset.name, status: valid ? 'validated' : 'invalid', reused_check: Boolean(reused) })
  }
  return { root, ready: assets.every(a => a.status === 'validated'), assets, downloaded: false }
}
export function buildResourceDiscoveryTool(projectId: string, deps: { spawn?: DriverSpawn; modelRoot?: string } = {}): AgentLoopTool {
  return {
    name: 'inspect_project_resources', parallelSafe: true,
    description: '只读检查项目解释器、依赖导入、已有平台组件和语音模型缓存；不安装、不下载、不录音。固定音频与物理设备分别标记。先查询此结果，再决定是否需要新选型或环境准备。',
    input_schema: { type: 'object', properties: { refresh: { type: 'boolean', description: '重新计算模型校验；默认复用未变化文件的已验结果' } } },
    execute: async (input, ctx) => {
      const root = findProject(projectId)?.root_path
      if (!root) return { output: '项目目录不可用，未执行资源检查。', isError: true }
      try {
        const venv = join(root, '.venv/Scripts/python.exe')
        const python = existsSync(venv) ? venv : await defaultResolvePython()
        const code = `import importlib,json,sys\nr={'python':sys.version.split()[0],'imports':{},'audio_source':'unverified'}\nfor name in ['numpy','sherpa_onnx','sounddevice','webview']:\n try:\n  m=importlib.import_module(name);r['imports'][name]={'status':'available','version':str(getattr(m,'__version__','unknown'))}\n  if name=='sounddevice':r['audio_source']=getattr(m,'bloma_input_evidence_source','physical_device_not_tested')\n except Exception as e:r['imports'][name]={'status':'unavailable','reason':type(e).__name__+': '+str(e)[:160]}\nprint(json.dumps(r,ensure_ascii=False))`
        const run = await (deps.spawn ?? execFileDriverSpawn)({ command: [python, '-c', code], cwd: root, env: buildChildExecEnv(process.env), timeoutMs: 30000, signal: ctx.signal })
        if (run.code !== 0) throw new Error(`解释器探针未完成：${run.stderr.slice(-200)}`)
        const environment = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1) ?? '')
        const modelRoot = deps.modelRoot ?? process.env.BLOMA_SPEECH_MODEL_DIR ?? join(getPromaHome(), 'speech-models/sensevoice-int8')
        const speech = await inspectSpeechResources(modelRoot, SPEECH_MODEL_MANIFEST, input.refresh === true, ctx.signal)
        const components = ['speech_runtime.py', 'speech_locator.py', 'record_store.py', 'file_plan_guard.py', 'llm_client.py'].map(name => ({ name, materialized: existsSync(join(root, name)) }))
        const attempts = readProjectAttempts(projectId)
        const cumulative = (prefix: string) => Object.entries(attempts.total).filter(([key]) => key.startsWith(prefix)).reduce((sum, [, value]) => sum + value, 0)
        return { output: JSON.stringify({ schema_version: 1, environment, components, speech, cumulative_attempts: { core: cumulative('core'), stage: cumulative('stage:'), script: cumulative('script:'), install: cumulative('install:') }, business_verification: 'unverified' }),
          feedback: { schema_version: 1, execution: 'completed', verification: 'unverified', scope: 'resource_inventory', source: environment.audio_source === 'fixed_wav_not_physical_microphone' ? 'fixed_input' : 'host', recovery: speech.ready ? 'none' : 'prepare_environment' } }
      } catch (error) {
        if (ctx.signal.aborted) throw error
        return { output: `资源检查未完成：${error instanceof Error ? error.message : String(error)}`, isError: true,
          feedback: { schema_version: 1, execution: 'failed', verification: 'unverified', category: 'environment', recovery: 'prepare_environment' } }
      }
    },
  }
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { mainRootDir } from '../platform/paths'
import { speechModelRoot } from '../platform/speech/model-manifest'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'
import { createHash } from 'node:crypto'

export interface SpeechVerificationSpec { module: string; factory: string; method: string; rate_argument?: boolean }
export interface SpeechVerificationResult {
  status: 'passed' | 'failed' | 'environment_blocked'
  probe_version: number
  real_decode_calls?: number
  tests?: Array<{ passed: boolean; name: string }>
  microphone?: { status: string; rms?: number }
  error?: string
}
function microphonePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('invalid evidence project id')
  return join(getPromaHome(), 'host-evidence', `${projectId}-microphone.json`)
}
export function hasCurrentMicrophoneEvidence(projectId: string, root: string, speech: SpeechVerificationSpec): boolean {
  if (hasAcceptedSpeechComponent(root, speech)) return true
  try {
    const saved = JSON.parse(readFileSync(microphonePath(projectId), 'utf8'))
    const fingerprint = verificationFingerprint(root)
    return Boolean(fingerprint && saved.fingerprint === fingerprint && saved.spec === JSON.stringify(speech) &&
      saved.result?.microphone?.status === 'passed' && saved.result?.real_decode_calls >= 4 &&
      Date.now() - Date.parse(saved.at) >= 0 && Date.now() - Date.parse(saved.at) < 24 * 60 * 60 * 1000)
  } catch { return false }
}

function hasAcceptedSpeechComponent(root: string, speech: SpeechVerificationSpec): boolean {
  if (speech.module !== 'speech_runtime' || speech.factory !== 'SpeechEngine' || speech.method !== 'transcribe') return false
  try {
    const accepted = JSON.parse(readFileSync(join(getPromaHome(), 'host-evidence/speech-component.json'), 'utf8'))
    const age = Date.now() - Date.parse(accepted.at)
    if (accepted.source !== 'user_acceptance' || accepted.scope !== 'component_capture_and_decode' || age < 0 || age >= 24 * 60 * 60 * 1000) return false
    return ['speech_runtime.py', 'speech_locator.py'].every(name => accepted.component_sha256?.[name] ===
      createHash('sha256').update(readFileSync(join(root, name))).digest('hex'))
  } catch { return false }
}

/** Human acceptance is a separate evidence source; original automatic results remain unchanged. */
export function recordManualSpeechComponentAcceptance(evidencePath: string, reason: string): void {
  const observed = JSON.parse(readFileSync(evidencePath, 'utf8'))
  if (observed.source !== 'user_started_component_gui' || observed.samples <= 0 || !observed.text || observed.errors?.length) throw new Error('No completed capture/decode observation to accept')
  const dir = join(getPromaHome(), 'host-evidence')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'speech-component.json'), JSON.stringify({ source: 'user_acceptance', scope: 'component_capture_and_decode',
    at: new Date().toISOString(), reason, component_sha256: observed.component_sha256, automatic_reference_status: observed.status,
    observed_rms: observed.rms, raw_audio_saved: false }, null, 2))
}

/** Only an explicitly authorized caller passes microphone=true. Normal delivery never records. */
export async function runHostSpeechProbe(options: { projectId: string; root: string; speech: SpeechVerificationSpec; microphone?: boolean; spawn?: DriverSpawn; signal?: AbortSignal }): Promise<SpeechVerificationResult> {
  const { root, speech } = options
  try {
    options.signal?.throwIfAborted()
    if (!speech || !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(speech.module) ||
        !/^[A-Za-z_]\w*$/.test(speech.factory) || !/^[A-Za-z_]\w*$/.test(speech.method) ||
        !existsSync(join(root, ...speech.module.split('.'))) && !existsSync(join(root, `${speech.module.replace(/\./g, '/')}.py`))) {
      throw new Error('语音模块/工厂/方法声明不可用')
    }
    const fingerprint = verificationFingerprint(root)
    if (!fingerprint) throw new Error('语音源码版本不可确认')
    const tools = join(mainRootDir(), 'templates/tools')
    const command = resolveDriverVenvCommand(['python', '-B', '-X', 'utf8', join(tools, 'speech_probe.py'),
      '--root', root, '--module', speech.module, '--factory', speech.factory, '--method', speech.method,
      '--fixture', join(tools, 'voice-golden.wav'), ...(speech.rate_argument ? ['--rate-argument'] : []),
      ...(options.microphone ? ['--microphone'] : [])], root)
    const env = buildDriverEnv({ env_whitelist: ['BLOMA_SPEECH_MODEL_DIR'] } as never, process.env)
    env.BLOMA_SPEECH_MODEL_DIR = process.env.BLOMA_SPEECH_MODEL_DIR || speechModelRoot()
    env.BLOMA_SPEECH_OFFLINE = '1'
    const execution = await (options.spawn ?? execFileDriverSpawn)({ command, cwd: root, env, timeoutMs: 90000, signal: options.signal })
    options.signal?.throwIfAborted()
    const last = execution.stdout.trim().split(/\r?\n/).at(-1) ?? ''
    const result = JSON.parse(last) as SpeechVerificationResult
    if (result.probe_version !== 1 || !['passed', 'failed', 'environment_blocked'].includes(result.status)) throw new Error('宿主音频探针未返回有效报告')
    if (result.status === 'passed' && (execution.code !== 0 || (result.real_decode_calls ?? 0) < 3 || result.tests?.length !== 3 || !result.tests.every(test => test.passed))) {
      throw new Error('缺少真实模型解码与固定反例通过证据')
    }
    if (verificationFingerprint(root) !== fingerprint) throw new Error('探针期间语音源码变化，本轮作废')
    if (options.microphone && result.status === 'passed' && result.microphone?.status === 'passed') {
      const path = microphonePath(options.projectId)
      mkdirSync(join(getPromaHome(), 'host-evidence'), { recursive: true })
      writeFileSync(path, JSON.stringify({ fingerprint, spec: JSON.stringify(speech), at: new Date().toISOString(), result }))
    }
    return result
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { status: 'environment_blocked', probe_version: 1, error: error instanceof Error ? error.message : String(error) }
  }
}

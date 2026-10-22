import { join } from 'node:path'
import { mainRootDir } from '../platform/paths'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

export interface LlmVerificationSpec { module: string; factory: string; method: string; covers: string[] }
export interface LlmVerificationResult {
  probe_version: number
  status: 'passed' | 'failed' | 'environment_blocked'
  tests?: Array<{ name: string; passed: boolean }>
  request_count?: number
  error?: string
}
export async function runHostLlmProbe(root: string, spec: LlmVerificationSpec, spawn: DriverSpawn = execFileDriverSpawn, signal?: AbortSignal): Promise<LlmVerificationResult> {
  try {
    signal?.throwIfAborted()
    if (![spec.module, spec.factory, spec.method].every(value => typeof value === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value))) throw new Error('模型入口声明不合法')
    const fingerprint = verificationFingerprint(root)
    if (!fingerprint) throw new Error('模型入口源码不可完整读取')
    const executable = resolveDriverVenvCommand(['python'], root)[0]!
    const result = await spawn({ command: [executable, '-X', 'utf8', '-B', join(mainRootDir(), 'templates/tools/llm_entry_probe.py'), root, JSON.stringify(spec)],
      cwd: root, timeoutMs: 30000, signal, env: { ...buildDriverEnv({ env_whitelist: ['APP_DATA_DIR'] } as never, process.env), LLM_PROVIDER: 'real', APP_DATA_DIR: join(root, '00_VERIFY/llm-data') } })
    signal?.throwIfAborted()
    const parsed = JSON.parse(result.stdout.trim()) as LlmVerificationResult
    if (parsed.probe_version !== 1 || !['passed', 'failed', 'environment_blocked'].includes(parsed.status)) throw new Error('模型探针结果不合法')
    const names = ['real_request', 'auth_error', 'model_error', 'rate_limited', 'invalid_response', 'unconfigured']
    if (parsed.status === 'passed' && (result.code !== 0 || parsed.request_count !== 5 || parsed.tests?.length !== 6 || names.some(name => !parsed.tests?.some(test => test.name === name && test.passed)))) throw new Error('模型探针证据不完整')
    if (verificationFingerprint(root) !== fingerprint) throw new Error('模型探针期间源码发生变化')
    return parsed
  } catch (error) {
    if (signal?.aborted) throw error
    return { probe_version: 1, status: 'environment_blocked', error: error instanceof Error ? error.message : String(error) }
  }
}

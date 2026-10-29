import { join, isAbsolute } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolveSoftwareCommand, softwareEnvironment } from '../software/command-runtime'
import { mainRootDir } from '../platform/paths'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint, declaredVerificationPolicy } from './verification-fingerprint'

export interface LlmVerificationSpec { runtime?: 'node'; module: string; factory: string; method: string; covers: string[]; input?:'vision'; protocol?:'openai-chat'|'anthropic-messages' }
export interface LlmVerificationResult {
  probe_version: number
  input_kind?:'vision'
  protocol?:'openai-chat'|'anthropic-messages'
  status: 'passed' | 'failed' | 'environment_blocked'
  tests?: Array<{ name: string; passed: boolean }>
  request_count?: number
  error?: string
}
export async function runHostLlmProbe(root: string, spec: LlmVerificationSpec, spawn: DriverSpawn = execFileDriverSpawn, signal?: AbortSignal, projectId?: string): Promise<LlmVerificationResult> {
  let temporary: string | undefined
  try {
    signal?.throwIfAborted()
    const identifier = (value: unknown) => typeof value === 'string' && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(value)
    if(spec.input!==undefined&&(spec.input!=='vision'||spec.runtime!=='node'))throw Error('视觉模型入口须使用Node及input:vision')
    if(spec.protocol!==undefined&&(spec.runtime!=='node'||!['openai-chat','anthropic-messages'].includes(spec.protocol)))throw Error('模型协议声明不合法')
    if (!identifier(spec.factory) || !identifier(spec.method) || (spec.runtime === 'node'
      ? typeof spec.module !== 'string' || isAbsolute(spec.module) || spec.module.split(/[\\/]/).includes('..') || !/\.(?:cjs|mjs|js)$/.test(spec.module)
      : spec.runtime !== undefined || !identifier(spec.module))) throw new Error('模型入口声明不合法')
    const policy = spec.runtime === 'node' ? 'software' : declaredVerificationPolicy(root)
    const fingerprint = verificationFingerprint(root, null, policy)
    if (!fingerprint) throw new Error('模型入口源码不可完整读取')
    const executable = resolveDriverVenvCommand(['python'], root)[0]!
    if (spec.runtime === 'node' || policy === 'software' && projectId) temporary = mkdtempSync(join(tmpdir(), 'bloma-llm-probe-'))
    const resolved = spec.runtime === 'node' ? resolveSoftwareCommand(root,
      ['node', join(mainRootDir(), 'templates/tools/llm_entry_probe.cjs'), root, JSON.stringify(spec)], softwareEnvironment(projectId ?? 'host-llm-probe', join(temporary!, 'data'))) : policy === 'software' && projectId ? {
      ...resolveSoftwareCommand(root, ['python', '-X', 'utf8', '-B', join(mainRootDir(), 'templates/tools/llm_entry_probe.py'), root, JSON.stringify(spec)], softwareEnvironment(projectId, join(temporary!, 'data'))),
    } : {
      command: [executable, '-X', 'utf8', '-B', join(mainRootDir(), 'templates/tools/llm_entry_probe.py'), root, JSON.stringify(spec)],
      env: { ...buildDriverEnv({ env_whitelist: ['APP_DATA_DIR'] } as never, process.env), LLM_PROVIDER: 'real', APP_DATA_DIR: join(root, '00_VERIFY/llm-data') } }
    const result = await spawn({ ...resolved, cwd: root, timeoutMs: 30000, signal })
    signal?.throwIfAborted()
    const parsed = JSON.parse(result.stdout.trim()) as LlmVerificationResult
    if (parsed.probe_version !== 1 || !['passed', 'failed', 'environment_blocked'].includes(parsed.status)) throw new Error('模型探针结果不合法')
    const names = ['real_request', 'auth_error', 'model_error', 'rate_limited', 'invalid_response', 'unconfigured']
    if(spec.input==='vision')names.push('image_changed')
    if (parsed.status === 'passed' && (result.code !== 0 || spec.input==='vision'&&parsed.input_kind!=='vision' || spec.protocol!==undefined&&parsed.protocol!==spec.protocol || parsed.request_count !== (spec.input==='vision'?6:5) || parsed.tests?.length !== names.length || names.some(name => !parsed.tests?.some(test => test.name === name && test.passed)))) throw new Error('模型探针证据不完整')
    if (verificationFingerprint(root, null, policy) !== fingerprint) throw new Error('模型探针期间源码发生变化')
    return parsed
  } catch (error) {
    if (signal?.aborted) throw error
    return { probe_version: 1, status: 'environment_blocked', error: error instanceof Error ? error.message : String(error) }
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
}

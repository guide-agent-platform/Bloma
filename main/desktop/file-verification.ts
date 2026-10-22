import { join } from 'node:path'
import { mainRootDir } from '../platform/paths'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

export interface FileVerificationResult {
  probe_version: number
  status: 'passed' | 'failed' | 'environment_blocked'
  mode?: string
  tests?: Array<{ name: string; passed: boolean }>
  error?: string
}

/** Product-authored PASS output cannot override these fixed filesystem counterexamples. */
export async function runHostPrefixRenameProbe(root: string, spawn: DriverSpawn = execFileDriverSpawn, options: { requireUndo?: boolean; signal?: AbortSignal } = {}): Promise<FileVerificationResult> {
  try {
    options.signal?.throwIfAborted()
    const fingerprint = verificationFingerprint(root)
    if (!fingerprint) throw new Error('文件能力验证输入不可完整读取')
    const executable = resolveDriverVenvCommand(['python'], root)[0]!
    const report = await spawn({ command: [executable, '-X', 'utf8', '-B', join(mainRootDir(), 'templates/tools/prefix_rename_probe.py'), root, ...(options.requireUndo ? ['--require-undo'] : [])],
      cwd: root, timeoutMs: 30000, signal: options.signal, env: buildDriverEnv({ env_whitelist: [] } as never, process.env) })
    options.signal?.throwIfAborted()
    const parsed = JSON.parse(report.stdout.trim()) as FileVerificationResult
    if (parsed.probe_version !== 1 || !['passed', 'failed', 'environment_blocked'].includes(parsed.status)) throw new Error('文件探针未返回有效结果')
    if (parsed.status === 'passed') {
      const positive = options.requireUndo ? 'rename_undo' : 'rename'
      const expected = parsed.mode === 'argument_plan' ? [positive, 'changed_prefix', 'different_folder', 'escaped_source', 'escaped_target', 'source_changed', 'new_destination'] :
        parsed.mode === 'stored_plan' ? [positive, 'invalid_prefix_after_valid', 'changed_folder', 'source_changed', 'new_destination'] : []
      if (report.code !== 0 || !expected.length || parsed.tests?.length !== expected.length || expected.some(name => !parsed.tests?.some(t => t.name === name && t.passed === true))) throw new Error('文件探针证据不完整')
    }
    if (verificationFingerprint(root) !== fingerprint) throw new Error('文件探针期间验证输入发生变化')
    return parsed
  } catch (error) {
    if (options.signal?.aborted) throw error
    return { probe_version: 1, status: 'environment_blocked', error: error instanceof Error ? error.message.slice(0, 300) : String(error) }
  }
}

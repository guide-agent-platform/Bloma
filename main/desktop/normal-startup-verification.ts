import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mainRootDir } from '../platform/paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readLaunchDeclaration } from './launch-smoke'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

export const NORMAL_STARTUP_REPORT = '00_VERIFY/normal-startup.json'
export interface NormalStartupResult {
  probe_version: 1
  status: 'passed' | 'failed' | 'unverified' | 'not_applicable'
  samples: Array<{ normal_mode: boolean; document_ready: boolean; bridge_ready: boolean; app_present: boolean; startup_error: string; visible_text?: string }>
  error?: string
  fingerprint?: string
  source_unchanged?: boolean
}

/** Platform-owned observation of the normal skeleton-v2 launch path. It proves
 * bridge/first-screen readiness, not the six business acceptance scenarios. */
export async function runNormalStartupVerification(root: string, signal?: AbortSignal, spawn: DriverSpawn = execFileDriverSpawn): Promise<NormalStartupResult> {
  signal?.throwIfAborted()
  const result: NormalStartupResult = { probe_version: 1, status: 'unverified', samples: [] }
  if (!existsSync(join(root, 'ui/bridge.js'))) return { ...result, status: 'not_applicable' }
  let dataRoot: string | undefined
  try {
    const launch = readLaunchDeclaration(root)
    if (!launch?.ok) throw new Error('NORMAL_STARTUP_LAUNCH_DECLARATION_MISSING')
    const [executable, script, ...args] = launch.launch.command
    if (!/^python(?:3)?(?:\.exe)?$/i.test(basename(executable)) || !script?.endsWith('.py')) throw new Error('NORMAL_STARTUP_UNSUPPORTED_ENTRY')
    if (args.some(arg => ['--drive-port', '--self-check', '--correction-session'].includes(arg))) throw new Error('NORMAL_STARTUP_REQUIRES_NORMAL_ENTRY')
    const actualRoot = realpathSync(root), entry = realpathSync(resolve(root, script)), rel = relative(actualRoot, entry)
    if (isAbsolute(rel) || rel.startsWith('..') || resolve(actualRoot, rel) !== entry) throw new Error('NORMAL_STARTUP_ENTRY_OUTSIDE_PROJECT')
    const fingerprint = verificationFingerprint(root)
    if (!fingerprint) throw new Error('NORMAL_STARTUP_INPUT_UNREADABLE')
    dataRoot = mkdtempSync(join(tmpdir(), 'bloma-normal-startup-'))
    const response = await spawn({ command: [resolveDriverVenvCommand([executable], root)[0], '-X', 'utf8', '-B', join(mainRootDir(), 'templates/tools/normal_startup_probe.py'), entry, JSON.stringify(args)],
      cwd: root, timeoutMs: 30000, signal,
      env: { ...buildDriverEnv({ env_whitelist: [] } as never, process.env), APP_DATA_DIR: join(dataRoot, 'data'), PYTHONDONTWRITEBYTECODE: '1' } })
    signal?.throwIfAborted()
    const line = response.stdout.split(/\r?\n/).filter(row => row.startsWith('BLOMA_NORMAL_STARTUP:')).at(-1)
    const parsed = JSON.parse(line?.slice('BLOMA_NORMAL_STARTUP:'.length) ?? 'null') as NormalStartupResult
    if (parsed?.probe_version !== 1 || !['passed', 'failed', 'unverified'].includes(parsed.status) || !Array.isArray(parsed.samples)) throw new Error('NORMAL_STARTUP_INVALID_OBSERVATION')
    Object.assign(result, parsed, { fingerprint, source_unchanged: verificationFingerprint(root) === fingerprint })
    const stable = parsed.samples.slice(-2)
    if (parsed.status === 'passed' && (response.code !== 0 || stable.length !== 2 || !stable.every(s => s.normal_mode === true && s.document_ready === true && s.bridge_ready === true && s.app_present === true && s.startup_error === ''))) throw new Error('NORMAL_STARTUP_INCOMPLETE_OBSERVATION')
    if (!result.source_unchanged) throw new Error('NORMAL_STARTUP_SOURCE_CHANGED')
  } catch (error) {
    if (signal?.aborted) throw error
    result.status = 'unverified'; result.error = error instanceof Error ? error.message : String(error)
  } finally {
    if (dataRoot) { try { rmSync(dataRoot, { recursive: true, force: true }) } catch { /* owned temporary data only */ } }
  }
  try { mkdirSync(join(root, '00_VERIFY'), { recursive: true }); writeTextFileAtomic(join(root, NORMAL_STARTUP_REPORT), JSON.stringify(result, null, 2)) }
  catch { result.status = 'unverified'; result.error = 'NORMAL_STARTUP_REPORT_NOT_SAVED' }
  return result
}

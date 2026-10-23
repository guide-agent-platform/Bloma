import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { readPrdBackplane } from '../project/prd-store'
import { findProject } from '../project/project-service'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { requirementCapabilities } from '../model/requirement-capabilities'
import { mainRootDir } from '../platform/paths'
import { buildDriverEnv, resolveDriverVenvCommand } from './process-driver'
import { captureVerificationVersion } from './verification-receipts'
import { verificationFingerprint } from './verification-fingerprint'
import { guiSuitePath } from './gui-acceptance'
import { cliSuitePath } from './lean-cli-check'
import { readLaunchDeclaration } from './launch-smoke'
import type { CoreVerificationResult } from './core-verification'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function coreVerificationCacheKey(projectId: string, root: string): string | undefined {
  try {
    const backplane = readPrdBackplane(projectId)
    // Hardware attestations and external model artifacts have their own lifetime.
    if (backplane.requirements.some(item => requirementCapabilities(item).has('speech'))) return
    const launch = backplane.lean_brief ? readLaunchDeclaration(root) : undefined
    const python = resolveDriverVenvCommand([launch?.ok ? launch.launch.command[0] : 'python'], root)[0]
    if (!existsSync(python)) return // unknown system PATH interpreter cannot certify reuse
    const source = verificationFingerprint(root, prdScopeFingerprint(backplane))
    if (!source) return
    const env = buildDriverEnv({ env_whitelist: ['BLOMA_SPEECH_MODEL_DIR', 'BLOMA_SPEECH_OFFLINE'] } as never, process.env)
    const version = captureVerificationVersion(root, python, env, projectId)
    const host = mainRootDir(), assets = ['gui_acceptance_probe.py', 'gui_storage_faults.py', 'prefix_rename_probe.py', 'llm_entry_probe.py']
      .map(name => digest(readFileSync(join(host, 'templates/tools', name))))
    const modules = ['core-verification.ts', 'capability-verifiers.ts', 'gui-acceptance.ts', 'process-driver.ts', 'core-verification-cache.ts', 'lean-cli-check.ts', 'lean-gui-tool.ts', '../project/ux-binding.ts']
    const implementation = existsSync(join(host, 'desktop', modules[0])) ? modules.map(name => digest(readFileSync(join(host, 'desktop', name)))) : [digest(readFileSync(join(host, 'index.js')))]
    const suite = guiSuitePath(projectId)
    let requiredProtocol: unknown = null
    try {
      const project = findProject(projectId)
      requiredProtocol = { gui_acceptance: project.gui_acceptance ?? null, ux_confirmation: project.ux_confirmation ?? null }
    } catch { /* no project in isolated key tests */ }
    return digest({ protocol: 1, fixture: 'fresh-empty-data-v1', source, version, assets, implementation, requiredProtocol,
      gui: existsSync(suite) ? digest(readFileSync(suite)) : null,
      ...(backplane.lean_brief ? { cli: existsSync(cliSuitePath(projectId)) ? digest(readFileSync(cliSuitePath(projectId))) : null } : {}) })
  } catch { return undefined }
}
export function coreCachePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('CORE_CACHE_PROJECT_INVALID')
  return join(getPromaHome(), 'core-verification-receipts', `${projectId}.json`)
}
interface Receipt { version: 1; state: 'running' | 'complete'; key: string; at: string; report_hash?: string; report?: CoreVerificationResult }
const inFlight = new Set<string>()
/** Trust only a whole host-owned receipt; the generated report is a presentation.
 * No cross-run in-flight joining: callers have independent cancellation owners. */
export async function withCoreVerificationCache(input: { projectId: string; key: () => string | undefined; signal?: AbortSignal; force?: boolean }, execute: () => Promise<CoreVerificationResult>): Promise<CoreVerificationResult> {
  input.signal?.throwIfAborted()
  const path = coreCachePath(input.projectId), key = input.key()
  if (inFlight.has(path)) return { status: 'environment_blocked', summary: '核心验证正在运行，请等待当前检查结束。', checked_at: new Date().toISOString(), missing: ['CORE_VERIFICATION_BUSY'], evidence: [] }
  if (!key) return execute()
  if (!input.force && existsSync(path)) {
    try {
      const saved = JSON.parse(readFileSync(path, 'utf8')) as Receipt
      const age = Date.now() - Date.parse(saved.at)
      if (saved.version === 1 && saved.state === 'complete' && saved.key === key && age >= 0 && age < 300000
        && saved.report?.status === 'passed' && saved.report_hash === digest(saved.report)) {
        input.signal?.throwIfAborted()
        return { ...structuredClone(saved.report), reused: true }
      }
    } catch { input.signal?.throwIfAborted() /* malformed evidence is never reused */ }
  }
  // This marker must reach disk before a new physical verification can begin.
  writeTextFileAtomic(path, JSON.stringify({ version: 1, state: 'running', key, at: new Date().toISOString() } satisfies Receipt))
  inFlight.add(path)
  try {
    const result = await execute()
    input.signal?.throwIfAborted()
    if (result.status === 'passed' && input.key() === key) {
      writeTextFileAtomic(path, JSON.stringify({ version: 1, state: 'complete', key, at: new Date().toISOString(), report: result, report_hash: digest(result) } satisfies Receipt))
    }
    return result
  } finally { inFlight.delete(path) }
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { mainRootDir } from '../platform/paths'
import { readLaunchDeclaration } from './launch-smoke'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

type Action = { id: string; kind: 'fill'; selector: string; value: string } | { id: string; kind: 'click'; selector: string }
  | { id: string; kind: 'expect'; selector: string; property?: 'text' | 'value' | 'count'; equals?: string; contains?: string; nonempty?: true; timeout_ms?: number }
  | { id: string; kind: 'restart' | 'lock_data' | 'unlock_data' | 'storage_full' | 'storage_restore' | 'corrupt_data' | 'remove_data' }
export interface GuiAcceptanceSuite { version: 1; scope_hash: string; covers: string[]; steps: Action[]
  control_bindings?: Array<{ selector: string; description: string }>
  acceptance_refs?: Record<string, string[]>
  fixtures?: Array<{ path: string; text: string }>
}
export interface GuiAcceptanceResult {
  version: 1; scope: 'host_native_gui_business'; status: 'passed' | 'failed' | 'unverified'
  suite_hash: string; covers: string[]; steps: Array<{ id: string; passed: boolean; actual?: unknown }>; error?: string
  scope_hash?: string; source_fingerprint?: string; source_unchanged?: boolean
}
export function guiSuitePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('GUI_PROJECT_INVALID')
  return join(getPromaHome(), 'gui-acceptance', `${projectId}.json`)
}
export function parseGuiSuite(value: unknown): GuiAcceptanceSuite {
  const suite = value as GuiAcceptanceSuite
  if (!suite || suite.version !== 1 || !/^[a-f0-9]{64}$/.test(suite.scope_hash) || !Array.isArray(suite.covers) || !suite.covers.length
    || suite.covers.some(id => typeof id !== 'string' || !/^F-\d+$/.test(id)) || new Set(suite.covers).size !== suite.covers.length
    || !Array.isArray(suite.steps) || !suite.steps.length) throw new Error('GUI_SUITE_INVALID')
  if (suite.steps.length > 96) throw new Error(`GUI_STEP_LIMIT_EXCEEDED: ${suite.steps.length}>96`)
  const ids = new Set<string>()
  let storageFault: 'lock' | 'full' | undefined
  if (suite.fixtures !== undefined && (!Array.isArray(suite.fixtures) || suite.fixtures.length > 16
    || suite.fixtures.some(file => !file || typeof file.path !== 'string' || !/^input\/[A-Za-z0-9_./-]+$/.test(file.path)
      || file.path.split('/').some(part => !part || ['.', '..'].includes(part) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part))
      || typeof file.text !== 'string' || Buffer.byteLength(file.text) > 4096)
    || new Set(suite.fixtures.map(file => file.path.toLowerCase())).size !== suite.fixtures.length)) throw new Error('GUI_FIXTURES_INVALID')
  if (suite.control_bindings !== undefined && (!Array.isArray(suite.control_bindings) || suite.control_bindings.length > 60
    || suite.control_bindings.some(item => !item || typeof item.selector !== 'string' || !item.selector || item.selector.length > 512 || typeof item.description !== 'string' || !item.description || item.description.length > 1000))) throw new Error('GUI_BINDINGS_INVALID')
  for (const step of suite.steps) {
    if (!step || typeof step.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(step.id) || ids.has(step.id)
      || !['fill', 'click', 'expect', 'restart', 'lock_data', 'unlock_data', 'storage_full', 'storage_restore', 'corrupt_data', 'remove_data'].includes(step.kind)) throw new Error('GUI_STEP_INVALID')
    ids.add(step.id)
    if (step.kind === 'lock_data' || step.kind === 'storage_full') { if (storageFault) throw new Error('GUI_DATA_LOCK_UNBALANCED'); storageFault = step.kind === 'lock_data' ? 'lock' : 'full' }
    if (step.kind === 'unlock_data') { if (storageFault !== 'lock') throw new Error('GUI_DATA_LOCK_UNBALANCED'); storageFault = undefined }
    if (step.kind === 'storage_restore') { if (storageFault !== 'full') throw new Error('GUI_DATA_LOCK_UNBALANCED'); storageFault = undefined }
    if (['restart', 'corrupt_data', 'remove_data'].includes(step.kind) && storageFault) throw new Error('GUI_DATA_LOCK_UNBALANCED')
    if (['fill', 'click', 'expect'].includes(step.kind) && (!('selector' in step) || typeof step.selector !== 'string' || !step.selector || step.selector.length > 512)) throw new Error('GUI_SELECTOR_INVALID')
    if (step.kind === 'fill' && (typeof step.value !== 'string' || step.value.length > 4096)) throw new Error('GUI_VALUE_INVALID')
    if (step.kind === 'expect' && ([step.equals !== undefined, step.contains !== undefined, step.nonempty !== undefined].filter(Boolean).length !== 1
      || step.equals !== undefined && (typeof step.equals !== 'string' || step.equals.length > 4096)
      || step.contains !== undefined && (typeof step.contains !== 'string' || !step.contains || step.contains.length > 4096)
      || step.nonempty !== undefined && step.nonempty !== true || step.property !== undefined && !['text', 'value', 'count'].includes(step.property)
      || step.timeout_ms !== undefined && (!Number.isSafeInteger(step.timeout_ms) || step.timeout_ms < 1 || step.timeout_ms > 10000))) throw new Error('GUI_EXPECT_INVALID')
  }
  if (storageFault) throw new Error('GUI_DATA_LOCK_UNBALANCED')
  const groups = splitSteps(suite)
  if (groups.length > 8) throw new Error(`GUI_RESTART_LIMIT_EXCEEDED: ${groups.length}>8`)
  if (groups.some(group => !group.length || !group.some(step => step.kind === 'expect'))) throw new Error('GUI_SEGMENT_NEEDS_ASSERTION')
  return suite
}
function splitSteps(suite: GuiAcceptanceSuite): Action[][] {
  const groups: Action[][] = [[]]
  for (const step of suite.steps) { if (step.kind === 'restart') groups.push([]); else groups.at(-1)!.push(step) }
  return groups
}
/** Called by trusted host tooling, never exposed as an implementer tool. */
export function installGuiAcceptanceSuite(projectId: string, value: unknown): void {
  writeTextFileAtomic(guiSuitePath(projectId), JSON.stringify(parseGuiSuite(value)))
}
export async function runGuiAcceptance(options: { projectId: string; root: string; scopeHash: string; signal?: AbortSignal; spawn?: DriverSpawn; python?: string; probePath?: string }): Promise<GuiAcceptanceResult | undefined> {
  const callerSignal = options.signal
  options = { ...options, signal: AbortSignal.any([...(callerSignal ? [callerSignal] : []), AbortSignal.timeout(300000)]) }
  options.signal?.throwIfAborted()
  const path = guiSuitePath(options.projectId)
  if (!existsSync(path)) return
  const result: GuiAcceptanceResult = { version: 1, scope: 'host_native_gui_business', status: 'unverified', suite_hash: '', covers: [], steps: [] }
  let temporary: string | undefined
  try {
    if (statSync(path).size > 128 * 1024) throw new Error('GUI_SUITE_TOO_LARGE')
    const bytes = readFileSync(path), suite = parseGuiSuite(JSON.parse(bytes.toString('utf8')))
    result.suite_hash = createHash('sha256').update(bytes).digest('hex'); result.covers = suite.covers
    if (suite.scope_hash !== options.scopeHash) throw new Error('GUI_SCOPE_STALE')
    const before = verificationFingerprint(options.root)
    if (!before) throw new Error('GUI_SOURCE_UNREADABLE')
    result.scope_hash = options.scopeHash; result.source_fingerprint = before
    const launch = readLaunchDeclaration(options.root)
    if (!launch?.ok || launch.launch.command.length !== 2 || !/^python(?:3)?(?:\.exe)?$/i.test(basename(launch.launch.command[0]))) throw new Error('GUI_NATIVE_ENTRY_UNSUPPORTED')
    const root = realpathSync(options.root), entry = realpathSync(resolve(root, launch.launch.command[1])), rel = relative(root, entry)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !entry.endsWith('.py')) throw new Error('GUI_ENTRY_OUTSIDE_PROJECT')
    temporary = mkdtempSync(join(tmpdir(), 'bloma-host-gui-'))
    for (const fixture of suite.fixtures ?? []) {
      const target = join(temporary, 'data', fixture.path)
      mkdirSync(join(target, '..'), { recursive: true }); writeFileSync(target, fixture.text)
    }
    const python = options.python ?? resolveDriverVenvCommand([launch.launch.command[0]], root)[0]
    for (const [index, group] of splitSteps(suite).entries()) {
      options.signal?.throwIfAborted()
      const file = join(temporary, `steps-${index}.json`); writeFileSync(file, JSON.stringify(group))
      const response = await (options.spawn ?? execFileDriverSpawn)({ command: [python, '-X', 'utf8', '-B', options.probePath ?? join(mainRootDir(), 'templates/tools/gui_acceptance_probe.py'), entry, file],
        cwd: root, signal: options.signal, timeoutMs: Math.min(180000, 20000 + group.length * 10000),
        env: { ...buildDriverEnv({ env_whitelist: [] } as never, process.env), APP_DATA_DIR: join(temporary, 'data'), PYTHONDONTWRITEBYTECODE: '1' } })
      options.signal?.throwIfAborted()
      const line = response.stdout.split(/\r?\n/).filter(row => row.startsWith('BLOMA_GUI_ACCEPTANCE:')).at(-1)
      const observed = JSON.parse(line?.slice('BLOMA_GUI_ACCEPTANCE:'.length) ?? 'null')
      if (!observed || observed.version !== 1 || !['passed', 'failed', 'unverified'].includes(observed.status) || !Array.isArray(observed.steps)) throw new Error('GUI_OBSERVATION_INVALID')
      if (observed.steps.some((step: { id?: string; passed?: boolean }, i: number) => step.id !== group[i]?.id || typeof step.passed !== 'boolean')) throw new Error('GUI_STEP_EVIDENCE_INVALID')
      result.steps.push(...observed.steps)
      if (observed.status !== 'passed') { result.status = observed.status; result.error = observed.error; break }
      if (response.code !== 0 || observed.steps.length !== group.length || observed.steps.some((step: { passed: boolean }) => !step.passed)) throw new Error('GUI_PASS_EVIDENCE_INCOMPLETE')
      result.status = 'passed'
    }
    result.source_unchanged = verificationFingerprint(root) === before
    if (!result.source_unchanged || !readFileSync(path).equals(bytes)) throw new Error('GUI_INPUT_CHANGED')
  } catch (error) {
    if (callerSignal?.aborted) throw error
    result.status = 'unverified'; result.error = error instanceof Error ? error.message : String(error)
  } finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }) } catch { /* owned data only */ } } }
  writeTextFileAtomic(join(options.root, '00_VERIFY/host-gui-acceptance.json'), JSON.stringify(result, null, 2))
  return result
}

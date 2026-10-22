import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { mainRootDir } from '../platform/paths'
import { readLaunchDeclaration } from './launch-smoke'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand, type DriverSpawn } from './process-driver'
import { verificationFingerprint } from './verification-fingerprint'

type Action = { id: string; kind: 'fill'; selector: string; value: string } | { id: string; kind: 'click'; selector: string }
  | { id: string; kind: 'expect'; selector: string; property?: 'text' | 'value'; equals: string; timeout_ms?: number }
  | { id: string; kind: 'restart' }
export interface GuiAcceptanceSuite { version: 1; scope_hash: string; covers: string[]; steps: Action[] }
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
    || !Array.isArray(suite.steps) || !suite.steps.length || suite.steps.length > 60) throw new Error('GUI_SUITE_INVALID')
  const ids = new Set<string>()
  for (const step of suite.steps) {
    if (!step || typeof step.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(step.id) || ids.has(step.id)
      || !['fill', 'click', 'expect', 'restart'].includes(step.kind)) throw new Error('GUI_STEP_INVALID')
    ids.add(step.id)
    if (step.kind !== 'restart' && (typeof step.selector !== 'string' || !step.selector || step.selector.length > 512)) throw new Error('GUI_SELECTOR_INVALID')
    if (step.kind === 'fill' && (typeof step.value !== 'string' || step.value.length > 4096)) throw new Error('GUI_VALUE_INVALID')
    if (step.kind === 'expect' && (typeof step.equals !== 'string' || step.equals.length > 4096 || step.property !== undefined && !['text', 'value'].includes(step.property)
      || step.timeout_ms !== undefined && (!Number.isSafeInteger(step.timeout_ms) || step.timeout_ms < 1 || step.timeout_ms > 10000))) throw new Error('GUI_EXPECT_INVALID')
  }
  const groups = splitSteps(suite)
  if (groups.length > 4 || groups.some(group => !group.length || !group.some(step => step.kind === 'expect'))) throw new Error('GUI_SEGMENT_NEEDS_ASSERTION')
  return suite
}
function splitSteps(suite: GuiAcceptanceSuite): Exclude<Action, { kind: 'restart' }>[][] {
  const groups: Exclude<Action, { kind: 'restart' }>[][] = [[]]
  for (const step of suite.steps) { if (step.kind === 'restart') groups.push([]); else groups.at(-1)!.push(step) }
  return groups
}
/** Called by trusted host tooling, never exposed as an implementer tool. */
export function installGuiAcceptanceSuite(projectId: string, value: unknown): void {
  writeTextFileAtomic(guiSuitePath(projectId), JSON.stringify(parseGuiSuite(value)))
}
export async function runGuiAcceptance(options: { projectId: string; root: string; scopeHash: string; signal?: AbortSignal; spawn?: DriverSpawn; python?: string; probePath?: string }): Promise<GuiAcceptanceResult | undefined> {
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
    if (options.signal?.aborted) throw error
    result.status = 'unverified'; result.error = error instanceof Error ? error.message : String(error)
  } finally { if (temporary) { try { rmSync(temporary, { recursive: true, force: true }) } catch { /* owned data only */ } } }
  writeTextFileAtomic(join(options.root, '00_VERIFY/host-gui-acceptance.json'), JSON.stringify(result, null, 2))
  return result
}

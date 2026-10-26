import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { guiSuitePath, parseGuiSuite } from '../desktop/gui-acceptance'
import { frozenGuiFixtureVersion } from '../desktop/gui-fixtures'
import { cliSuitePath } from '../desktop/lean-cli-check'
import { runCoreVerification, type CoreVerificationResult } from '../desktop/core-verification'
import { runLaunchSmoke, requireLaunchDeclaration, type LaunchSmokeResult } from '../desktop/launch-smoke'
import { runSecurityScan, type SecurityScanResult } from '../verification/security-scan'
import { requirementCapabilities } from '../model/requirement-capabilities'
import { mainRootDir } from '../platform/paths'
import { softwareEnvironment, resolveSoftwareCommand } from './command-runtime'
import { runtimeBindingVersion } from './runtime-bindings'
import { fileDigest, prepareSoftwareRelease, readSoftwareCandidate, runtimeInventory, verifyReleaseSource, type SoftwareRelease } from './release-store'
import { frozenNativeGuiVersion } from './native-gui-tests'

export interface SoftwareVerification { status: 'passed' | 'failed' | 'unverified' | 'environment_blocked'; summary: string; candidate?: SoftwareRelease;
  core?: CoreVerificationResult; security?: SecurityScanResult; launch?: LaunchSmokeResult | null; reused?: boolean; report_path?: string }
interface Receipt { version: 1; state: 'running' | 'complete'; key: string; at: number; result?: SoftwareVerification; result_hash?: string; reusable?: boolean }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const hostId = randomUUID(), poisoned = new Set<string>()
function receiptPath(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('SOFTWARE_VERIFY_PROJECT_INVALID')
  return join(getPromaHome(), 'software-verification', `${projectId}.json`)
}
async function inputs(projectId: string, requestId: string, signal?: AbortSignal) {
  const project = findProject(projectId), brief = readPrdBackplane(projectId)
  if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at) throw Error('SOFTWARE_VERIFY_CONFIRMED_ENTRY_REQUIRED: 必须先确认当前项目需求')
  const launch = requireLaunchDeclaration(project.root_path, 'SOFTWARE_VERIFY_CONFIRMED_ENTRY_REQUIRED')
  const ruleVersion = [guiSuitePath(projectId), cliSuitePath(projectId)].map(file => existsSync(file) ? digest(readFileSync(file)) : null)
  const gui=existsSync(guiSuitePath(projectId))?parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId),'utf8'))):undefined
  const fixtureVersion = gui ? [...frozenGuiFixtureVersion(projectId,gui),frozenNativeGuiVersion(projectId,gui.native_tests,project.root_path)] : []
  const environment = softwareEnvironment(projectId), resolved = resolveSoftwareCommand(project.root_path, launch.command, environment)
  const executable = resolved.command[0], runtime: unknown[] = []
  let reusable = isAbsolute(executable) && existsSync(executable) && !/python(?:3)?(?:\.exe)?$/i.test(basename(executable))
  if (isAbsolute(executable) && existsSync(executable)) runtime.push(await fileDigest(executable, signal))
  if (/electron(?:\.exe)?$/i.test(basename(executable))) runtime.push((await runtimeInventory(dirname(executable), signal, {}, false)).digest)
  for (const value of resolved.command.slice(1).filter(isAbsolute)) if (existsSync(value)) {
    if (/npm-cli\.js$|npx-cli\.js$/i.test(value)) {
      const npm = dirname(createRequire(import.meta.url).resolve('npm/package.json'))
      runtime.push((await runtimeInventory(npm, signal, {}, false)).digest)
    } else { reusable = false; break }
  }
  if (brief.requirements.some(item => requirementCapabilities(item).has('speech'))) reusable = false
  const host = mainRootDir(), implementation: unknown[] = []
  if (existsSync(join(host, 'desktop/core-verification.ts'))) {
    implementation.push((await runtimeInventory(host, signal, {}, false)).digest)
  } else {
    implementation.push(await fileDigest(fileURLToPath(import.meta.url), signal))
    implementation.push((await runtimeInventory(join(host, 'templates/tools'), signal, {}, false)).digest)
  }
  return { key: digest({ protocol: 1, hostId, source: (await runtimeInventory(project.root_path, signal)).digest, requestId, operation: project.lean_operation_id,
    scope: prdScopeFingerprint(brief), confirmed: brief.user_confirmed_at, ux: project.ux_confirmation, rules: ruleVersion, fixtures: fixtureVersion,
    runtime, command: resolved.command, environment: resolved.env, managed: runtimeBindingVersion(projectId), implementation, platform: process.platform, arch: process.arch, node: process.versions.node }), reusable }
}
export async function recentSoftwareVerification(projectId: string, requestId: string, signal?: AbortSignal): Promise<SoftwareVerification | undefined> {
  const file = receiptPath(projectId); if (poisoned.has(file) || !existsSync(file)) return
  try {
    const receipt = JSON.parse(readFileSync(file, 'utf8')) as Receipt
    if (receipt.version !== 1 || receipt.state !== 'complete' || !receipt.reusable || receipt.result?.status !== 'passed'
      || Date.now() - receipt.at < 0 || Date.now() - receipt.at > 300000 || digest(receipt.result) !== receipt.result_hash) return
    const current = await inputs(projectId, requestId, signal)
    if (!current.reusable || current.key !== receipt.key || !receipt.result.candidate) return
    await readSoftwareCandidate(projectId, receipt.result.candidate.id, signal)
    await verifyReleaseSource(receipt.result.candidate, signal)
    return { ...receipt.result, reused: true, core: receipt.result.core ? { ...receipt.result.core, reused: true } : undefined }
  } catch (error) { signal?.throwIfAborted(); return } // unreadable or incomplete evidence is never reused
}
const active = new Set<string>()
/** Syntax/bootstrap errors and wholly assertion-free placeholders are not a
 * business failure baseline. Bind this exception to the last intact receipt and
 * exact rule bytes; a real failed assertion never authorizes changing tests. */
export function canRepairUnexecutedNativePlan(projectId:string,suiteHash:string){
  try{
    const receipt=JSON.parse(readFileSync(receiptPath(projectId),'utf8')) as Receipt
    if(receipt.state!=='complete'||receipt.result?.status!=='unverified'||digest(receipt.result)!==receipt.result_hash)return false
    const gui=receipt.result.core?.host_gui
    if(gui?.method!=='node:test'||gui.suite_hash!==suiteHash)return false
    if(!gui.steps.length)return Boolean(gui.error?.startsWith('GUI_NATIVE_CASE_NOT_RUN')&&gui.native_evidence?.assertions===0
      ||gui.error?.startsWith('GUI_NATIVE_REPORT_MISSING')&&!/\bF-\d+\b/.test(gui.error))
    return gui.native_evidence?.assertions===0&&gui.error?.startsWith('GUI_NATIVE_ASSERTIONS_MISSING')===true
  }catch{return false}
}
export async function verifySoftwareCandidate(projectId: string, requestId: string, signal?: AbortSignal, force = false): Promise<SoftwareVerification> {
  const file = receiptPath(projectId)
  if (active.has(file)) throw Error('SOFTWARE_VERIFY_ALREADY_RUNNING')
  if (!force) { const previous = await recentSoftwareVerification(projectId, requestId, signal); if (previous) return previous }
  if (active.has(file)) throw Error('SOFTWARE_VERIFY_ALREADY_RUNNING')
  active.add(file); poisoned.add(file)
  let version: Awaited<ReturnType<typeof inputs>> | undefined
  const result: SoftwareVerification = { status: 'unverified', summary: '当前版本尚未通过检查。', report_path: file }
  try {
    writeTextFileAtomic(file, JSON.stringify({ version: 1, state: 'running', key: '', at: Date.now() } satisfies Receipt))
    version = await inputs(projectId, requestId, signal)
    writeTextFileAtomic(file, JSON.stringify({ version: 1, state: 'running', key: version.key, at: Date.now() } satisfies Receipt))
    const candidate = result.candidate = await prepareSoftwareRelease(projectId, findProject(projectId).root_path, signal)
    const security = result.security = runSecurityScan({ project_id: projectId, root_path: candidate.root, profile: 'local-software' })
    writeTextFileAtomic(join(candidate.root, '00_VERIFY/security-scan.json'), JSON.stringify(security))
    if (!security.passed) { result.status = 'failed'; result.summary = security.issues.filter(issue => ['high', 'critical'].includes(issue.severity)).map(issue => `${issue.file}:${issue.line} ${issue.user_visible_summary}`).join('\n'); return result }
    const core = result.core = await runCoreVerification({ projectId, sandboxRoot: candidate.root, signal })
    const localPending = core.local_status === 'passed' && core.distribution?.status === 'environment_blocked'
    if (core.status !== 'passed' && !localPending) { result.status = core.status; result.summary = [core.summary, ...core.missing].join('\n'); return result }
    const launch = result.launch = await runLaunchSmoke(candidate.root, { signal, allowCleanExit: candidate.launch.mode === 'command' })
    const brief = readPrdBackplane(projectId), windowReady = brief.lean_brief?.ui !== 'required'
      || candidate.launch.ui === 'browser' && launch.http_ready === true
      || launch.criteria && !launch.criteria.degraded && launch.criteria.window_found && launch.criteria.responsive && launch.criteria.stable && launch.criteria.closed_gracefully
    if (!launch.passed || !windowReady) { result.status = 'unverified'; result.summary = `正常启动未通过：${launch.detail}${launch.outputExcerpt?'\n'+launch.outputExcerpt.slice(-4000):''}`; return result }
    await verifyReleaseSource(candidate, signal)
    if ((await inputs(projectId, requestId, signal)).key !== version.key) throw Error('SOFTWARE_VERIFY_INPUT_CHANGED')
    result.status = localPending ? 'environment_blocked' : 'passed'; result.summary = localPending ? core.distribution!.detail : '当前候选的实际行为、安全静态检查与正常启动通过；结束制作即可由宿主收口。'
    return result
  } catch (error) {
    signal?.throwIfAborted(); result.status = 'unverified'; result.summary = error instanceof Error ? error.message : String(error); return result
  } finally {
    active.delete(file)
    if (signal?.aborted) { result.status = 'unverified'; result.summary = '验证已取消，当前通过凭据未生效。' }
    // Even cancellation/write failure invalidates an older PASS. No result may
    // outlive changed rule, fixture, environment, binary or source inputs.
    const reusable = Boolean(version?.reusable && result.status === 'passed' && !result.security?.issues.some(issue => issue.category === 'external_resource'))
    writeTextFileAtomic(file, JSON.stringify({ version: 1, state: 'complete', key: version?.key ?? '', at: Date.now(), result, result_hash: digest(result), reusable } satisfies Receipt))
    poisoned.delete(file)
  }
}

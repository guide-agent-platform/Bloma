import { existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { prepareSoftwareRelease, validateSoftwareRelease } from './release-store'
import { startSoftwareProcess, stopSoftwareProcess, softwareProcess } from './process-manager'
import { runSecurityScan } from '../verification/security-scan'
import type { SoftwareTrial, ProjectLaunchAppResult } from '../../shared/types'

const live = new Map<string, SoftwareTrial>(), busy = new Set<string>()
function directory(projectId: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('TRIAL_PROJECT_INVALID')
  return join(getPromaHome(), 'software-trials', projectId)
}
export function softwareTrial(projectId: string): SoftwareTrial | undefined {
  const file = join(directory(projectId), 'current.json')
  const current = live.get(projectId) ?? (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as SoftwareTrial : undefined)
  if (!current) return
  const state = softwareProcess(projectId, current.process_id, 'user-trial').state
  return { ...current, state: live.has(projectId) ? state : 'interrupted' }
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done) })
  const address = server.address()
  await new Promise<void>(done => server.close(() => done()))
  if (!address || typeof address === 'string') throw Error('TRIAL_PORT_UNAVAILABLE')
  return address.port
}
/** User-owned trial snapshots have synthetic data and no delivery authority.
 * A replacement is started and checked before the previous usable one stops. */
export async function launchSoftwareTrial(projectId: string, expectedVersion?: string, restart = false): Promise<ProjectLaunchAppResult> {
  if (busy.has(projectId)) return { started: false, detail: '试用版本正在准备。' }
  busy.add(projectId)
  let started: string | undefined
  try {
    const previous = softwareTrial(projectId)
    if (previous?.state === 'interrupted' && previous.pid) {
      let alive = true
      try { process.kill(previous.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error }
      if (alive) throw Error('TRIAL_PREVIOUS_HOST_INSTANCE: 请自行保存并关闭旧试用；不会接管旧PID')
    }
    if (previous?.state === 'running' && !restart) return { started: true, trial: previous, url: previous.url, detail: '继续使用已固定版本；自动验收不影响此实例。' }
    if (restart && expectedVersion !== previous?.release_id) throw Error('TRIAL_VERSION_CHANGED')
    const project = findProject(projectId), brief = readPrdBackplane(projectId), scope = prdScopeFingerprint(brief)
    if (!brief.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope) throw Error('TRIAL_CONFIRMED_SCOPE_REQUIRED')
    const release = await prepareSoftwareRelease(projectId, project.root_path)
    const target = release.launch.mode === 'command' ? 'command' : release.launch.ui === 'browser' ? 'browser' : 'desktop'
    if (brief.lean_brief?.delivery && brief.lean_brief.delivery !== target) throw Error('SOFTWARE_DELIVERY_TARGET_MISMATCH: 试用形态必须与已确认目标一致')
    if (!['browser', 'electron'].includes(release.launch.ui ?? '')) throw Error('TRIAL_RUNTIME_UNSUPPORTED: 当前独立试用支持Electron/浏览器')
    const scan = runSecurityScan({ project_id: projectId, root_path: release.root, profile: 'local-software' })
    if (!scan.passed) throw Error('TRIAL_SECURITY_FAILED: 修复安全扫描问题后再试用')
    const data = join(directory(projectId), release.id, 'data'); mkdirSync(data, { recursive: true })
    let url = release.launch.url, command = [...release.launch.command]
    if (release.launch.ui === 'browser' && url) {
      const original = new URL(url), port = await freePort(), oldPort = original.port || '80'
      original.port = String(port)
      // Only explicit launch arguments are relocated. Never rewrite business
      // source to work around a hardcoded port; report unsupported startup.
      command = command.map(arg => arg === oldPort ? String(port) : arg === url ? original.href : arg === `--port=${oldPort}` ? `--port=${port}` : arg)
      url = original.href
    }
    const instance = await startSoftwareProcess({ projectId, root: release.root, sessionId: 'user-trial', command,
      url, dataDir: data, independentUserApp: true, visibleDesktop: release.launch.ui === 'electron', purpose: 'trial', readyMs: 8000 })
    started = instance.id
    if (instance.state !== 'running' || url && !instance.ready) throw Error('TRIAL_NOT_READY: 浏览器需用PORT/APP_PORT环境变量或独立端口参数；旧试用保留')
    await new Promise(done => setTimeout(done, 500))
    if (softwareProcess(projectId, instance.id, 'user-trial').state !== 'running') throw Error('TRIAL_EXITED')
    await validateSoftwareRelease(projectId, release)
    const trial: SoftwareTrial = { release_id: release.id, source: release.source.digest, process_id: instance.id, pid: instance.pid, state: instance.state,
      data_dir: data, url, qualification: 'unverified_test_data', at: new Date().toISOString() }
    writeTextFileAtomic(join(directory(projectId), `${release.id}.json`), JSON.stringify(trial))
    writeTextFileAtomic(join(directory(projectId), 'current.json'), JSON.stringify(trial))
    live.set(projectId, trial)
    if (previous && previous.state === 'running') {
      try { await stopSoftwareProcess(projectId, previous.process_id, 'user-trial') }
      catch { console.warn('Old owned trial did not close completely; new usable trial retained') }
    }
    return { started: true, trial, url, pid: trial.pid, detail: '独立试用已启动：测试数据，尚未验收。反馈将绑定此版本。' }
  } catch (error) {
    if (started) await stopSoftwareProcess(projectId, started, 'user-trial')
    return { started: false, detail: String(error), trial: softwareTrial(projectId) }
  } finally { busy.delete(projectId) }
}
export function trialFeedbackText(projectId: string, version: string, content: string): string {
  if (!/^[a-f0-9]{64}$/.test(version)) throw Error('TRIAL_FEEDBACK_VERSION_INVALID')
  const record = JSON.parse(readFileSync(join(directory(projectId), `${version}.json`), 'utf8')) as SoftwareTrial
  if (record.release_id !== version || record.qualification !== 'unverified_test_data') throw Error('TRIAL_FEEDBACK_VERSION_INVALID')
  return `【用户所见试用版本 ${version}；测试数据，尚未验收】\n${content}`
}
export async function closeSoftwareTrial(projectId: string, version?: string): Promise<ProjectLaunchAppResult> {
  const trial = softwareTrial(projectId)
  if (!trial || trial.release_id !== version) throw Error('TRIAL_VERSION_CHANGED')
  if (trial.state === 'interrupted') throw Error('TRIAL_PREVIOUS_HOST_INSTANCE: 不接管旧PID，请自行关闭旧试用')
  await stopSoftwareProcess(projectId, trial.process_id, 'user-trial')
  return { started: false, detail: '独立试用已关闭，测试数据和版本记录保留。', trial: softwareTrial(projectId) }
}

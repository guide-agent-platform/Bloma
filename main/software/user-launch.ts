import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { executeSoftwareCommand } from './command-runtime'
import { startSoftwareProcess, softwareProcess, stopSoftwareProcess, redactSoftwareOutput } from './process-manager'
import { activeSoftwareRelease, prepareSoftwareRelease, loadSoftwareRelease } from './release-store'
import { prepareDataUpdate, softwareFallbackReleaseId } from './data-update'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import type { ProjectLaunchAppResult } from '../../shared/types'

// These are user-started product instances, independent of the Agent run.
// Never adopt persisted PIDs or stop a user's instance during Agent cleanup.
const instances = new Map<string, { root: string; command: string; processId: string; url?: string }>()
const busy = new Set<string>()
export async function launchSoftwareForUser(projectId: string, sourceRoot: string, _launch: LaunchDeclaration,
  openBrowser: (url: string) => Promise<void>, restart = false, restoreId?: string, previousRelease = false): Promise<ProjectLaunchAppResult> {
  if (busy.has(projectId)) return { started: false, detail: '程序正在启动或更新，请稍候。' }
  busy.add(projectId)
  let startedId: string | undefined
  try {
  // Compatibility for old completed projects: isolate their snapshot, but do
  // not manufacture a verified release from their historical delivery flag.
  let release = await activeSoftwareRelease(projectId) ?? await prepareSoftwareRelease(projectId, sourceRoot)
  if (previousRelease) {
    const id = softwareFallbackReleaseId(projectId, release.id)
    if (!id) throw Error('USER_APP_PREVIOUS_RELEASE_MISSING')
    release = await loadSoftwareRelease(projectId, id)
  }
  const root = release.root, launch = release.launch
  const key = createHash('sha256').update(release.source.digest).digest('hex')
  const previous = instances.get(projectId)
  const marker = join(getPromaHome(), 'software-user-instances', `${projectId}.json`)
  if (!previous && existsSync(marker)) {
    const { processId } = JSON.parse(readFileSync(marker, 'utf8')) as { processId: string }
    const old = softwareProcess(projectId, processId, 'user-launch')
    if (['interrupted', 'running', 'starting', 'stopping'].includes(old.state) && old.pid) {
      // Liveness only, never adopt or terminate this persisted PID. A reused PID
      // conservatively blocks data copying rather than granting ownership.
      let alive = true
      try { process.kill(old.pid, 0) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error }
      if (alive) throw Error('USER_APP_PREVIOUS_HOST_INSTANCE: 请先保存并自行关闭此前启动的程序，再重试；不会接管或强制终止旧PID')
    }
  }
  if (previous) {
    const live = softwareProcess(projectId, previous.processId).state === 'running'
    if (live) {
      if (previous.command === key && !restoreId) {
        if (previous.url) await openBrowser(previous.url)
        return { started: true, url: previous.url, detail: '程序已经在运行，可以继续使用。' }
      }
      if (!restart) return { started: false, needs_restart: true, detail: '旧版本仍在运行。请先保存内容，再关闭旧版本并启动更新。' }
      await stopSoftwareProcess(projectId, previous.processId, 'user-launch')
    }
  }
  const transaction = await prepareDataUpdate(projectId, root, key, restoreId, release.id), dataDir = transaction.dataDir
  if (launch.mode === 'command') {
    const result = await executeSoftwareCommand({ projectId, root, command: launch.command, dataDir })
    if (result.code === 0) transaction.commit()
    return { started: result.code === 0, detail: result.code === 0 ? redactSoftwareOutput(result.stdout).trim().slice(-2000) || '运行完成。'
      : `运行未完成：${redactSoftwareOutput(result.stderr).trim().slice(-1000) || `退出码 ${result.code}`}` }
  }
  if (launch.ui === 'browser') {
    const instance = await startSoftwareProcess({ projectId, root, sessionId: 'user-launch', command: launch.command, url: launch.url, dataDir, independentUserApp: true })
    startedId = instance.id
    writeTextFileAtomic(marker, JSON.stringify({ processId: instance.id }))
    if (!instance.ready || !instance.url) throw new Error(`USER_APP_NOT_READY: ${instance.stderr || instance.state}`)
    transaction.commit(); instances.set(projectId, { root, command: key, processId: instance.id, url: instance.url })
    await openBrowser(instance.url)
    return { started: true, pid: instance.pid, url: instance.url, detail: '已在浏览器打开，可以开始使用。' }
  }
  const instance = await startSoftwareProcess({ projectId, root, sessionId: 'user-launch', command: launch.command, dataDir, independentUserApp: true })
  startedId = instance.id
  writeTextFileAtomic(marker, JSON.stringify({ processId: instance.id }))
  await new Promise(resolve => setTimeout(resolve, 500))
  const latest = softwareProcess(projectId, instance.id, 'user-launch')
  if (latest.state !== 'running') throw Error(`USER_APP_EXITED: ${latest.stderr.slice(-1000) || latest.state}`)
  transaction.commit(); instances.set(projectId, { root, command: key, processId: instance.id })
  return { started: true, pid: instance.pid, detail: '已启动，可以在程序窗口中使用。' }
  } catch (error) {
    if (startedId) await stopSoftwareProcess(projectId, startedId, 'user-launch')
    return { started: false, detail: `启动或更新未完成，原数据保留：${redactSoftwareOutput(String(error)).slice(-1800)}` }
  } finally { busy.delete(projectId) }
}

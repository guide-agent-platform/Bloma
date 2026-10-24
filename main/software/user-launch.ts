import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { executeSoftwareCommand } from './command-runtime'
import { startSoftwareProcess, softwareProcess, stopSoftwareProcess, redactSoftwareOutput } from './process-manager'
import { verificationFingerprint } from '../desktop/verification-fingerprint'
import type { LaunchDeclaration } from '../desktop/launch-smoke'
import type { ProjectLaunchAppResult } from '../../shared/types'

// These are user-started product instances, independent of the Agent run.
// Never adopt persisted PIDs or stop a user's instance during Agent cleanup.
const instances = new Map<string, { root: string; command: string; processId: string; url?: string }>()
export async function launchSoftwareForUser(projectId: string, root: string, launch: LaunchDeclaration,
  openBrowser: (url: string) => Promise<void>, restart = false): Promise<ProjectLaunchAppResult> {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw Error('USER_APP_PROJECT_INVALID')
  const base = join(getPromaHome(), 'software-app-data', projectId), dataDir = join(base, 'data'), versionFile = join(base, 'last-version.txt')
  const source = verificationFingerprint(root)
  if (!source) throw Error('USER_APP_SOURCE_UNREADABLE')
  const key = createHash('sha256').update(JSON.stringify({ launch, source })).digest('hex')
  const previous = instances.get(projectId)
  if (previous && previous.root === root) {
    const live = softwareProcess(projectId, previous.processId).state === 'running'
    if (live) {
      if (previous.command === key) {
        if (previous.url) await openBrowser(previous.url)
        return { started: true, url: previous.url, detail: '程序已经在运行，可以继续使用。' }
      }
      if (!restart) return { started: false, needs_restart: true, detail: '旧版本仍在运行。请先保存内容，再关闭旧版本并启动更新。' }
      await stopSoftwareProcess(projectId, previous.processId, 'user-launch')
    }
  }
  mkdirSync(base, { recursive: true })
  // Back up durable data before the new code can migrate it, including after a host restart.
  const lastVersion = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : undefined
  if (lastVersion && lastVersion !== key && existsSync(dataDir)) cpSync(dataDir, join(base, 'backups', `before-${Date.now()}-${randomUUID()}`), { recursive: true, errorOnExist: true, force: false })
  const recordVersion = () => writeFileSync(versionFile, key)
  if (launch.mode === 'command') {
    const result = await executeSoftwareCommand({ projectId, root, command: launch.command, dataDir })
    if (result.code === 0) recordVersion()
    return { started: result.code === 0, detail: result.code === 0 ? redactSoftwareOutput(result.stdout).trim().slice(-2000) || '运行完成。'
      : `运行未完成：${redactSoftwareOutput(result.stderr).trim().slice(-1000) || `退出码 ${result.code}`}` }
  }
  if (launch.ui === 'browser') {
    const instance = await startSoftwareProcess({ projectId, root, sessionId: 'user-launch', command: launch.command, url: launch.url, dataDir, independentUserApp: true })
    if (!instance.ready || !instance.url) throw new Error(`USER_APP_NOT_READY: ${instance.stderr || instance.state}`)
    instances.set(projectId, { root, command: key, processId: instance.id, url: instance.url }); recordVersion()
    await openBrowser(instance.url)
    return { started: true, pid: instance.pid, url: instance.url, detail: '已在浏览器打开，可以开始使用。' }
  }
  const instance = await startSoftwareProcess({ projectId, root, sessionId: 'user-launch', command: launch.command, dataDir, independentUserApp: true })
  await new Promise(resolve => setTimeout(resolve, 500))
  const latest = softwareProcess(projectId, instance.id, 'user-launch')
  if (latest.state !== 'running') throw Error(`USER_APP_EXITED: ${latest.stderr.slice(-1000) || latest.state}`)
  instances.set(projectId, { root, command: key, processId: instance.id }); recordVersion()
  return { started: true, pid: instance.pid, detail: '已启动，可以在程序窗口中使用。' }
}

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import type { LaunchDeclaration, LaunchSmokeResult } from '../desktop/launch-smoke'
import { startSoftwareProcess, stopSoftwareSession } from './process-manager'

/** Normal server entry, with separate isolated data. Business UI behavior is
 * already observed by the GUI verifier; HTTP readiness is not called a GUI PASS. */
export async function runBrowserStartup(root: string, launch: LaunchDeclaration, signal?: AbortSignal): Promise<LaunchSmokeResult> {
  const home = mkdtempSync(join(tmpdir(), 'bloma-browser-startup-')), owner = randomUUID(), projectId = `startup-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`
  try {
    if (!launch.url || launch.ui !== 'browser') throw new Error('BROWSER_LAUNCH_DECLARATION_REQUIRED')
    const result = await startSoftwareProcess({ root, projectId, sessionId: owner, command: launch.command, url: launch.url, signal, dataDir: join(home, 'data') })
    signal?.throwIfAborted()
    return { passed: result.state === 'running' && result.ready === true, http_ready: result.ready === true,
      detail: '正常入口的本地服务已就绪；实际界面操作结果见核心验证记录。' }
  } catch (error) {
    if (signal?.aborted) throw error
    return { passed: false, detail: `本地服务正常启动未通过：${error instanceof Error ? error.message : String(error)}` }
  } finally { await stopSoftwareSession(projectId, owner); rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
}

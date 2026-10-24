import { execFile } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
/** Bounded cleanup of live handles captured by this host, never disk PIDs. */
export async function closeOwnedGui(close: Array<() => Promise<unknown>>, child?: ChildProcess) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([Promise.allSettled(close.map(callback => Promise.resolve().then(callback))), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error('GUI_CLOSE_TIMEOUT')), 7000)
    })])
  } catch { /* Force only this captured child when graceful quit is blocked. */ }
  finally {
    clearTimeout(timer)
    if (child?.pid && child.exitCode === null && !child.signalCode) {
      if (process.platform === 'win32') await new Promise<void>(done => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => done()))
      else child.kill('SIGTERM')
    }
  }
}

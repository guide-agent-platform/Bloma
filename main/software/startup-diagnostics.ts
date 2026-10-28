import type { BrowserContext, Page } from 'playwright'
import { redactSoftwareOutput, type SoftwareProcessSnapshot } from './process-manager'

export function softwareStartupError(stage: 'process' | 'debug_connection' | 'window', snapshot: SoftwareProcessSnapshot, cause: unknown): Error {
  const stderr = redactSoftwareOutput(snapshot.stderr).slice(-4000), stdout = redactSoftwareOutput(snapshot.stdout).slice(-2000)
  const code = /EADDRINUSE/.test(stderr + stdout) ? 'APP_PORT_IN_USE'
    : /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(stderr + stdout) ? 'APP_MODULE_MISSING'
    : snapshot.code !== undefined && snapshot.code !== null ? 'APP_EXITED_BEFORE_WINDOW' : 'APP_WINDOW_NOT_READY'
  return new Error(`${code}: ${JSON.stringify({ stage, process_id: snapshot.id, state: snapshot.state, exit_code: snapshot.code,
    stdout, stderr, cause: redactSoftwareOutput(String(cause)).slice(-1200),
    next: code === 'APP_PORT_IN_USE' ? '检查应用后端是否被重复启动；仅处理本会话拥有的服务，或让应用选择空闲端口。'
      : '按进程日志修复正常入口；调试连接就绪不代表应用窗口已创建。' })}`)
}

/** Race window creation against the owned process and cancellation. CDP can
 * stay up after application bootstrap fails; its HTTP 200 is not UI readiness. */
export async function waitForSoftwareWindow(context: BrowserContext, snapshot: () => SoftwareProcessSnapshot, signal: AbortSignal, timeoutMs = 15000): Promise<Page> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>, monitor: ReturnType<typeof setInterval>
    const cleanup = () => { clearTimeout(timer); clearInterval(monitor); context.off('page', opened); signal.removeEventListener('abort', aborted) }
    const opened = (page: Page) => { if (!page.isClosed() && !page.url().startsWith('devtools:')) { cleanup(); resolve(page) } }
    const failed = (error: unknown) => { cleanup(); reject(error) }
    const aborted = () => failed(signal.reason ?? Error('DEBUG_CANCELLED'))
    const inspect = () => {
      try {
        const current = snapshot()
        if (!['starting', 'running'].includes(current.state)) { failed(softwareStartupError('window', current, '应用进程已结束')); return }
        const page = context.pages().find(p => !p.isClosed() && !p.url().startsWith('devtools:'))
        if (page) opened(page)
      } catch (error) { failed(error) }
    }
    context.on('page', opened); signal.addEventListener('abort', aborted, { once: true })
    timer = setTimeout(() => { try { failed(softwareStartupError('window', snapshot(), `等待窗口超过${timeoutMs}ms`)) } catch (error) { failed(error) } }, timeoutMs)
    monitor = setInterval(inspect, 100)
    if (signal.aborted) aborted(); else inspect()
  })
}

import { session, shell, type BrowserWindow, type IpcMain } from 'electron'
import { IPC_CHANNELS } from '../../shared/types'
import { getPromaHome } from '../../storage/config-paths'
import { PricingCatalog, officialPricingUrl } from '../../token monitor/pricing'
import { collectUsage } from '../../token monitor/usage'
import { addFindings, Exchange, LocalAudit } from '../../token monitor/audit'
import { safeInvoke } from './shared'

export function registerTokenMonitorIpc(ipc: IpcMain, window: BrowserWindow): void {
  const home = getPromaHome()
  let catalog: PricingCatalog | undefined
  const request = (url: string, options?: RequestInit) => session.fromPartition('token-monitor-pricing').fetch(url, options)
  const audit = new LocalAudit(home, (url, options) => fetch(url, options))
  const exchange = new Exchange(home, request)
  let exchangeStarted = false
  const prices = () => catalog ??= new PricingCatalog(home, request)
  const access = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('PERMISSION_DENIED: Token 用量仅供 Bloma 主界面访问')
    }
  }
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_READ, event => safeInvoke('token-monitor-read', async () => {
    access(event)
    const data = await collectUsage(home)
    addFindings(home, data.rows)
    const source = prices()
    source.refreshOnce()
    if (!exchangeStarted) { exchangeStarted = true; void exchange.refresh() }
    return { ...data, fx: exchange.snapshot(), pricing: source.snapshot() }
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_REFRESH, event => safeInvoke('token-monitor-refresh', async () => {
    access(event)
    const [pricing] = await Promise.all([prices().refresh(), exchange.refresh()])
    return pricing
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_MODELS, event => safeInvoke('token-monitor-models', () => {
    access(event)
    return audit.models()
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_AUDIT, (event, input: import('../../shared/token-monitor').AuditFilter) => safeInvoke('token-monitor-audit', () => {
    access(event)
    return audit.start(input)
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_AUDIT_STATUS, event => safeInvoke('token-monitor-audit-status', () => {
    access(event)
    return audit.status()
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_AUDIT_STOP, event => safeInvoke('token-monitor-audit-stop', () => {
    access(event)
    return audit.stop()
  }))
  ipc.handle(IPC_CHANNELS.TOKEN_MONITOR_OPEN_SOURCE, (event, provider: unknown) => safeInvoke('token-monitor-source', async () => {
    access(event)
    const url = typeof provider === 'string' && officialPricingUrl(provider)
    if (!url) throw new Error('VALIDATION_ERROR: 未知的价格来源')
    await shell.openExternal(url)
  }))
}

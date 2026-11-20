import type { AuditFilter, AuditProgress, MonitorPrices, UsageSnapshot } from '../../shared/token-monitor'

export function mountTokenMonitor(root: ShadowRoot | HTMLElement, transport: {
  read(): Promise<UsageSnapshot>
  refreshPrices(): Promise<MonitorPrices>
  openSource(provider: string, url?: string): unknown
  auditModels(): Promise<string[]>
  auditStart(filter: AuditFilter): Promise<AuditProgress>
  auditStatus(): Promise<AuditProgress | null>
  auditStop(): Promise<AuditProgress | null>
}): () => void

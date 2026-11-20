export const USAGE_PHASES = {
  requirements: '需求', interface: '界面', production: '制作',
  verification: '验证', delivery: '交付', unknown: '未归类',
} as const

export type MonitorPhase = keyof typeof USAGE_PHASES
export type Counts = Record<'uncached' | 'read' | 'write' | 'output', number | null>
export interface ModelRate extends Counts {
  peak?: Counts
  as_of?: string
}
export interface PriceBook {
  as_of: string
  models: Record<string, ModelRate>
}
export interface PriceSource extends PriceBook {
  state: 'live' | 'cached'
  checked?: string
  error?: string
}
export type MonitorPrices = Record<string, PriceSource>

export interface UsageTurn {
  project: string
  session: string
  id: string
  at: number
  request: string
  reply: string
  unlinked?: boolean
}
export interface UsageRow {
  id: string
  project: string
  turn: [string, string, string]
  at: number
  phase: MonitorPhase
  phase_inferred: boolean
  inferred: boolean
  provider: string
  channel: string
  host: string
  model: string
  counts: Counts
  status: string
  missing: boolean
  failed: number
  retries: { index: number; status: string; http?: number }[]
  evidence: AuditEvidence
  finding?: AuditFinding
  auditError?: string
}
export interface UsageSnapshot {
  projects: Record<string, string>
  rows: UsageRow[]
  turns: UsageTurn[]
  issues: { malformed: number; unreadable: number }
  phases: typeof USAGE_PHASES
  pricing: MonitorPrices
  fx: ExchangeRate
}

export interface ToolAttempt {
  name: string
  target: string
  result: string
  diagnostic?: string
  state: 'ok' | 'failed' | 'unknown'
}

export interface AuditEvidence {
  text: string
  tools: ToolAttempt[]
  source: 'id' | 'time' | 'none'
  failure: string
}

export interface AuditFinding {
  category: string
  outcome: 'success' | 'failed' | 'partial' | 'unknown'
  purpose: string
  result: string
  model: string
  fingerprint: string
  failureSummary?: string
  summaryModel?: string
}
export interface ExchangeRate { rate: number; date: string }
export interface AuditBatch {
  project: string
  session: string
  title?: string
  index: number
  total: number
  requests: number
  inputBytes: number
  startedAt: number
  retry: boolean
}
export interface AuditProgress {
  state: 'running' | 'stopping' | 'stopped' | 'completed' | 'error'
  model: string
  processed: number
  remaining: number
  skippedNoEvidence?: number
  unknownErrors?: number
  skippedUnknownErrors?: number
  lastAuditError?: string
  activeBatch?: AuditBatch
  batchHistory?: Array<AuditBatch & { elapsedMs: number; unresolved: number; error?: string }>
  error?: string
}
export interface AuditFilter { project?: string; session?: string; start?: number; end?: number; model?: string; mode?: 'pending' | 'all' | 'retry' }

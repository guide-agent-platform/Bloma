import type { AuditFilter, UsageRow } from '../../shared/token-monitor'

export function needsAudit(row: UsageRow): boolean
export function needsSummary(row: UsageRow): boolean
export function auditDisposition(row: UsageRow, mode: NonNullable<AuditFilter['mode']>): 'running' | 'cached' | 'excluded' | 'unknown' | 'rule' | 'queued' | 'noEvidence'
export function hasFailure(row: UsageRow): boolean
export function hasUnreadableFailure(row: UsageRow): boolean
export function observedFailure(row: UsageRow): string
export function failureSummary(row: UsageRow): string
export function readableSummary(value: unknown): string

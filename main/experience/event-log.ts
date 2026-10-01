/**
 * Phase 10 W2（2026-09-16，承接 F 系列 Wave 2 拍板 D1）：经验账本 v2 事件行/治理行。
 * 同账本（getExperienceIndexPath 单文件 append-only）追加两类行，v1 卡行不动：
 *   事件行（事实层）：observations 只记事实（异常类型/层/轮次/断言 id），不产卡不归因；
 *   治理行（迁移/生命周期）：card_quarantined/reclassified/superseded/retired/migration_completed。
 * 采集入口 recordFailureCards（error-card.ts）改写为事件行；本模块是唯一读写面。
 * 依赖：types（账本路径/开关）+ node:fs。fire-and-forget 纪律：写入失败 warn 不抛。
 * 开关：写入随 BLOMA_EXPERIENCE（拍板 2.3：只管新事件采集）；读取不过开关（迁移/审计用）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { hashProjectRef } from './types'
import { getExperienceIndexPath } from '../../storage/config-paths'

export type ExperienceEventType =
  | 'gwt_failure'
  | 'build_gate_failure'
  | 'judge_return'
  | 'abnormal_outcome'
  | 'antidegrade_finding'
  /** W4.2：行为信号（重做/停止/快速返回修改）与反馈卡负面项（issue_hypothesis） */
  | 'behavior_signal'
  | 'issue_hypothesis'
  /** W4.2/4.3：对账或终验证据坐实的失败（高优先级诊断队列） */
  | 'confirmed_failure'
  /** Phase 10 增量：终验迁移演练失败（W1-5 接线） */
  | 'data_migration_failed'
  /** Phase 10 增量：升级导出迁移失败（W1-6，IPC 接线后启用） */
  | 'upgrade_failed'

export interface ExperienceEventLine {
  record_type: 'event'
  event_id: string
  run_id: string
  project_hash: string
  timestamp: string
  event_type: ExperienceEventType
  stage: string
  observations: string[]
  evidence_refs: string[]
  env_versions: Record<string, string>
  related_event_ids: string[]
}

export type LifecycleKind = 'card_quarantined' | 'card_reclassified' | 'card_superseded' | 'card_retired' | 'migration_completed'

export interface ExperienceLifecycleLine {
  record_type: 'lifecycle'
  kind: LifecycleKind
  target_fingerprint: string
  reason: string
  migration_id: string
  timestamp: string
}

export interface AppendEventInput {
  projectId: string
  runId: string
  eventType: ExperienceEventType
  stage: string
  observations: string[]
  evidenceRefs?: string[]
  envVersions?: Record<string, string>
}

/** 追加事件行（开关 off=零副作用；失败 warn 不抛——采集是增强不是依赖）。 */
export function appendExperienceEvent(input: AppendEventInput): string | null {
  try {
    const line: ExperienceEventLine = {
      record_type: 'event',
      event_id: randomId(),
      run_id: input.runId,
      project_hash: hashProjectRef(input.projectId),
      timestamp: new Date().toISOString(),
      event_type: input.eventType,
      stage: input.stage,
      observations: input.observations.filter(Boolean).slice(0, 20),
      evidence_refs: (input.evidenceRefs ?? []).filter(Boolean).slice(0, 10),
      env_versions: input.envVersions ?? {},
      related_event_ids: [],
    }
    appendLine(line)
    return line.event_id
  } catch (error) {
    console.warn('[experience] append event failed:', (error as Error)?.message)
    return null
  }
}

/** 追加治理行（迁移脚本/人工治理用；不过 experienceEnabled——迁移必须能写）。 */
export function appendLifecycleRow(kind: LifecycleKind, targetFingerprint: string, reason: string, migrationId: string): void {
  const line: ExperienceLifecycleLine = {
    record_type: 'lifecycle',
    kind,
    target_fingerprint: targetFingerprint,
    reason,
    migration_id: migrationId,
    timestamp: new Date().toISOString(),
  }
  appendLine(line)
}

/** 读全部事件行（不过开关：复盘/诊断/迁移用）。 */
export function readExperienceEvents(): ExperienceEventLine[] {
  const out: ExperienceEventLine[] = []
  for (const line of readLedgerLines()) {
    if (line && (line as { record_type?: string }).record_type === 'event') out.push(line as ExperienceEventLine)
  }
  return out
}

/** 读全部治理行。 */
export function readLifecycleRows(): ExperienceLifecycleLine[] {
  const out: ExperienceLifecycleLine[] = []
  for (const line of readLedgerLines()) {
    if (line && (line as { record_type?: string }).record_type === 'lifecycle') out.push(line as ExperienceLifecycleLine)
  }
  return out
}

/** 折叠视图：目标指纹集合——被 quarantine/reclassify/retire 的 v1 卡不进消费面。 */
export function foldedFingerprints(): Set<string> {
  const out = new Set<string>()
  for (const row of readLifecycleRows()) {
    if (row.kind === 'card_quarantined' || row.kind === 'card_reclassified' || row.kind === 'card_retired' || row.kind === 'card_superseded') {
      out.add(row.target_fingerprint)
    }
  }
  return out
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function appendLine(line: ExperienceEventLine | ExperienceLifecycleLine): void {
  const path = getExperienceIndexPath()
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify(line)}\n`, 'utf8')
}

function readLedgerLines(): unknown[] {
  try {
    const path = getExperienceIndexPath()
    if (!existsSync(path)) return []
    const out: unknown[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        out.push(JSON.parse(line))
      } catch {
        // 坏行跳过（与 experience-service 加载器同纪律）
      }
    }
    return out
  } catch {
    return []
  }
}

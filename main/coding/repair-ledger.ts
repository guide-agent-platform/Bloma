/**
 * 修复账本（2026-09-26 运行审计 P1-02：统一 RepairAttempt 账本）。
 *
 * 审计发现的三组语义分裂：
 * 1. 主 loop「写入次数预算」与外层「修复轮预算」不同计费单位（保持各自语义，账本统一记录）；
 * 2. blocked 续修（用户选「继续修」）与熔断回滚都会把 test_repair_count 清零——历史计数
 *    被擦除，无法回答「这个项目到底累计修过多少次」；
 * 3. 一次终验失败只调用一次修复链（预算 2-3 却只用 1 轮即熔断）——final-verify 侧循环解决。
 *
 * 账本模型：
 * - `repair_epoch`：预算授权纪元。用户显式授权（继续修/重新生成/新迭代）或系统熔断回滚时
 *   epoch+1，epoch 内 test_repair_count 归零重新计预算——「用户续修合法授予新预算」语义
 *   保留，但每次授权在账本留痕（可审计边界）。
 * - `repair_total_attempts`：跨 epoch 累计尝试数，任何路径不清零（回滚不擦除历史）。
 * - `repair_ledger`：append-only 事件流（epoch_opened / attempt / noop / exempt / exhausted /
 *   converged_reset），容量 50 条防膨胀。
 */
import { findProject, updateProject } from '../project/project-service'
import type { RepairLedgerEntry } from '../../shared/types'

/** 账本事件种类。 */
export type RepairLedgerEventKind =
  | 'epoch_opened' // 新预算授权（用户续修/重新生成/迭代/回滚）
  | 'attempt' // 一次修复轮实际启动（跨 epoch 累计 +1）
  | 'noop' // 零编辑轮（不计预算）
  | 'exempt' // 环境豁免/无可操作失败（不起轮不烧预算）
  | 'exhausted' // 预算耗尽
  | 'converged_reset' // 收敛清零（同 epoch 内）

/** 账本条目（持久化在 project.repair_ledger；类型定义在 shared/types.ts）。 */
export type { RepairLedgerEntry } from '../../shared/types'

/** 账本容量（append-only 但防无限膨胀；旧条目从头丢弃）。 */
const REPAIR_LEDGER_CAP = 50

function appendLedger(projectId: string, entry: Omit<RepairLedgerEntry, 'at'>): void {
  try {
    const project = findProject(projectId)
    if (!project) return
    const ledger = [...(project.repair_ledger ?? []), { ...entry, at: new Date().toISOString() }]
    updateProject(projectId, { repair_ledger: ledger.slice(-REPAIR_LEDGER_CAP) })
  } catch {
    // 账本是可观测性增强：写失败不阻断修复/终验主链（fail-open，与决策日志同纪律）
  }
}

/**
 * 开启新预算纪元：epoch+1、test_repair_count 归零（新授权重置预算）、账本留痕。
 * runtime/security/judge 计数不在本函数职责（调用方按原语义自行处理）。
 * 任何路径都不清 repair_total_attempts（审计：回滚不擦除历史）。
 */
export function openRepairEpoch(projectId: string, via: string): void {
  try {
    const project = findProject(projectId)
    if (!project) return
    const epoch = (project.repair_epoch ?? 0) + 1
    updateProject(projectId, { repair_epoch: epoch, test_repair_count: 0 })
    appendLedger(projectId, { kind: 'epoch_opened', epoch, via })
  } catch {
    // fail-open：项目缺失/写失败不阻断主链（与决策日志同纪律）
  }
}

/** 记一次修复轮启动（attempt：跨 epoch 累计 +1）。 */
export function recordRepairAttempt(projectId: string, via: 'final_verify' | 'blocked_resume', round: number, failedBefore: number): void {
  try {
    const project = findProject(projectId)
    if (!project) return
    const epoch = project.repair_epoch ?? 0
    updateProject(projectId, { repair_total_attempts: (project.repair_total_attempts ?? 0) + 1 })
    appendLedger(projectId, { kind: 'attempt', epoch, via, round, failed_before: failedBefore })
  } catch {
    // fail-open：同上
  }
}

/** 记零编辑轮 / 豁免 / 耗尽 / 收敛清零（不进累计数）。 */
export function recordRepairLedgerEvent(
  projectId: string,
  kind: 'noop' | 'exempt' | 'exhausted' | 'converged_reset',
  via: string,
  detail?: { round?: number; outcome?: string; failedBefore?: number; failedAfter?: number },
): void {
  try {
    const project = findProject(projectId)
    const epoch = project?.repair_epoch ?? 0
    appendLedger(projectId, {
      kind,
      epoch,
      via,
      ...(detail?.round !== undefined ? { round: detail.round } : {}),
      ...(detail?.outcome ? { outcome: detail.outcome } : {}),
      ...(detail?.failedBefore !== undefined ? { failed_before: detail.failedBefore } : {}),
      ...(detail?.failedAfter !== undefined ? { failed_after: detail.failedAfter } : {}),
    })
  } catch {
    // fail-open：同上
  }
}

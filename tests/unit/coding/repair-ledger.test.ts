import { restorePromaHome } from '../../support/proma-home-guard'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openRepairEpoch, recordRepairAttempt, recordRepairLedgerEvent } from '../../../main/coding/repair-ledger'
import { createProject, findProject, updateProject } from '../../../main/project/project-service'

/** 修复账本（2026-09-26 运行审计 P1-02）：epoch 语义/累计不擦除/容量上限。 */

describe('repair-ledger（审计 P1-02 统一账本）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function setupProject(): string {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-ledger-'))
    const project = createProject({ request_id: 'req-ledger', mode: 'quick' })
    return project.project_id
  }

  it('openRepairEpoch：epoch 递增、轮计数清零、累计尝试与账本保留（回滚不擦除历史）', () => {
    const projectId = setupProject()
    updateProject(projectId, { repair_epoch: 1, test_repair_count: 2, repair_total_attempts: 2 })

    openRepairEpoch(projectId, 'circuit_rollback')

    const after = findProject(projectId)
    expect(after.repair_epoch).toBe(2)
    expect(after.test_repair_count).toBe(0)
    expect(after.repair_total_attempts).toBe(2) // 历史不擦除
    expect(after.repair_ledger?.at(-1)).toMatchObject({ kind: 'epoch_opened', epoch: 2, via: 'circuit_rollback' })

    // 再次开启：epoch 3，账本追加（append-only）
    openRepairEpoch(projectId, 'user_resume_test_repair')
    const again = findProject(projectId)
    expect(again.repair_epoch).toBe(3)
    expect(again.repair_ledger?.filter((e) => e.kind === 'epoch_opened')).toHaveLength(2)
  })

  it('recordRepairAttempt：跨 epoch 累计 +1，账本记 attempt 条目', () => {
    const projectId = setupProject()
    updateProject(projectId, { repair_epoch: 1, test_repair_count: 1, repair_total_attempts: 1 })

    recordRepairAttempt(projectId, 'final_verify', 2, 3)

    const after = findProject(projectId)
    expect(after.repair_total_attempts).toBe(2)
    expect(after.repair_ledger?.at(-1)).toMatchObject({ kind: 'attempt', epoch: 1, via: 'final_verify', round: 2, failed_before: 3 })
  })

  it('账本容量 50：旧条目从头丢弃（防膨胀，不入膨胀索引）', () => {
    const projectId = setupProject()
    for (let i = 0; i < 55; i += 1) {
      recordRepairLedgerEvent(projectId, 'exhausted', 'filler', { round: i })
    }
    const ledger = findProject(projectId).repair_ledger ?? []
    expect(ledger).toHaveLength(50)
    expect(ledger[0]).toMatchObject({ round: 5 }) // 0-4 被丢弃
    expect(ledger.at(-1)).toMatchObject({ round: 54 })
  })

  it('项目缺失/写失败 fail-open：不抛错不阻断主链', () => {
    expect(() => openRepairEpoch('nonexistent-project', 'test')).not.toThrow()
    expect(() => recordRepairAttempt('nonexistent-project', 'final_verify', 1, 0)).not.toThrow()
    expect(() => recordRepairLedgerEvent('nonexistent-project', 'noop', 'test')).not.toThrow()
  })
})

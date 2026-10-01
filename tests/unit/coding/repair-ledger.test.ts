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

describe('test_completed 事件 kind/probe_degraded/unverified roundtrip（审计 P1-03）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('回滚清 test-report 后从 analytics 恢复：kind/probe_degraded/unverified 完整还原', async () => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-restore-'))
    const { readTestReport, writeTestReport } = await import('../../../main/verification/test-legacy')
    const { trackAnalytics } = await import('../../../main/delivery/track-analytics')
    const { getDocumentsDir, getAnalyticsPath } = await import('../../../storage/config-paths')
    const { createProject, findProject } = await import('../../../main/project/project-service')

    const project = createProject({ request_id: 'req-restore', mode: 'quick' })
    // 直接写一份带分类/降级标记的报告并落对应 analytics 事件（模拟终验链路产物）
    const result = {
      total_count: 3,
      passed_count: 1,
      failed_count: 2,
      failure_summary: [
        { scenario: 'F-002 点击清空键→当前输入与结果归零', reason: '前置步骤失败：无可见可输入域', kind: 'precondition' as const },
        { scenario: 'F-003 点击删除按钮→目标记录消失', reason: '映射编译失败', kind: 'mapping' as const },
        { scenario: 'API 契约端点：GET /api/history', reason: '端点存活检查失败' },
      ],
      probe_degraded: true,
      unverified: ['F-009 桌面安装包交付'],
    }
    writeTestReport({ request_id: 'req-restore', session_id: 's1', project_id: project.project_id, result })
    // 熔断回滚清掉 documents/test-report.json（W5 场景）——留 analytics 事件
    const docDir = getDocumentsDir(findProject(project.project_id).workspace_slug, project.project_id)
    rmSync(join(docDir, 'test-report.json'))
    rmSync(join(docDir, 'test-report.md'))
    // analytics 事件由 trackTestCompleted 生成；这里直接按其 payload 形态写入
    trackAnalytics({
      request_id: 'req-restore',
      event: {
        event_type: 'test_completed',
        project_id: project.project_id,
        session_id: 's1',
        payload: {
          round: 'initial',
          total_count: 3,
          passed_count: 1,
          failed_count: 2,
          failures: [
            { scenario: 'F-002 点击清空键→当前输入与结果归零', reason: '前置步骤失败', kind: 'precondition' },
            { scenario: 'F-003 点击删除按钮→目标记录消失', reason: '映射编译失败', kind: 'mapping' },
            { scenario: 'API 契约端点：GET /api/history', reason: '端点存活检查失败' },
          ],
          probe_degraded: true,
          unverified: ['F-009 桌面安装包交付'],
        },
        privacy_level: 'research_safe',
      },
    })

    const restored = readTestReport(project.project_id)
    expect(restored).not.toBeNull()
    expect(restored?.probe_degraded).toBe(true)
    expect(restored?.unverified).toEqual(['F-009 桌面安装包交付'])
    expect(restored?.failure_summary.find((f) => f.scenario.startsWith('F-002'))?.kind).toBe('precondition')
    expect(restored?.failure_summary.find((f) => f.scenario.startsWith('F-003'))?.kind).toBe('mapping')
    // 无 kind 的条目不伪造分类
    expect(restored?.failure_summary.find((f) => f.scenario.startsWith('API'))?.kind).toBeUndefined()
    void getAnalyticsPath
    void mkdirSync
    void writeFileSync
  })
})

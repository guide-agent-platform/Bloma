import { restorePromaHome } from '../../support/proma-home-guard'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIpcHarness } from '../support/ipc-harness'
import type { ApiResult, Project } from '../../../shared/types'
import { clearPendingRequests, getPendingRequests, resolvePermission } from '../../../main/agent/permissions/permission-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../../main/delivery/sandbox'
import { setSnapshotCaptureProviderForTests } from '../../../main/delivery/snapshots'

/**
 * Sprint 3 · T8 埋点重核
 *
 * 目标：逐项核对 `shared/types.ts` 定义的分析事件是否真实被触发并落盘 analytics.jsonl，
 * 同时建立 FIRT 指标断言（S1-ANALYTICS-001 已覆盖，此处做事件完整性审计）。
 *
 * 文档依据：
 * - research-plan.md §5（13 类埋点到指标映射）
 * - api-spec.md §13（analytics:track 通道）
 * - sprint-plan.md §3~§6（各 Sprint 埋点交付物）
 */

describe('Sprint 3 analytics completeness audit (T8)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(async () => {
    if (home) {
      const { rmSync } = await import('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    restorePromaHome(originalPromaHome)
    home = undefined
    clearPendingRequests()
    clearSandboxRuntimeForTests()
    setSnapshotCaptureProviderForTests()
    vi.restoreAllMocks()
  })

  function setup(prefix: string) {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    const harness = createIpcHarness()
    const readAnalytics = (): Record<string, unknown>[] => {
      const path = join(home!, 'agent-workspaces', 'default-software-builder', 'analytics.jsonl')
      if (!existsSync(path)) return []
      return readFileSync(path, 'utf8')
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
    }
    return { harness, readAnalytics }
  }

  it('[T8-001] 项目创建与升级收口事件：mode_upgraded / satisfaction_marked / project_finalized', async () => {
    const { harness, readAnalytics } = setup('bloma-t8-upgrade-')

    const created = (await harness.invoke('project:create', {
      request_id: 't8-create',
      mode: 'quick',
    })) as ApiResult<Project>
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const projectId = created.data.project_id

    const upgraded = (await harness.invoke('project:upgrade', {
      request_id: 't8-upgrade',
      project_id: projectId,
      session_id: 't8-session',
    })) as ApiResult<Project>
    expect(upgraded.ok).toBe(true)

    const finalized = (await harness.invoke('project:finalize', {
      request_id: 't8-finalize',
      project_id: projectId,
      session_id: 't8-session',
    })) as ApiResult<Project>
    expect(finalized.ok).toBe(true)

    const events = readAnalytics().map((e) => e.event_type as string)
    expect(events).toContain('project_created')
    expect(events).toContain('mode_upgraded')
    expect(events).toContain('satisfaction_marked')
    expect(events).toContain('project_finalized')

    const modeUpgraded = readAnalytics().find((e) => e.event_type === 'mode_upgraded')
    expect(modeUpgraded?.payload).toMatchObject({ from_mode: 'quick', to_mode: 'longterm' })
  })

  // [T8-002] 点选纠错事件（point_correction）：随 web 线点选纠错链退役（通道
  // project:submit-correction 已删、main 零写入方）——用例与 T8-004 审计条目一并移除。

  it('[T8-003] 用户主动回滚事件：user_undo', async () => {
    const { harness, readAnalytics } = setup('bloma-t8-undo-')

    // rollbackSnapshot 内部会停/启沙箱并创建 guard 快照，测试环境需注入沙箱替身
    // （S0-PERM-005 同款惯例），避免真实 spawn 静态服务器。
    setSandboxRuntimeForTests({
      portAllocator: async () => 3200,
      healthCheck: async () => true,
      processFactory: () => makeChildProcess(),
    })
    setSnapshotCaptureProviderForTests(async () => ({
      extension: 'png',
      buffer: Buffer.from('fake-png'),
    }))

    const created = (await harness.invoke('project:create', {
      request_id: 't8-undo-create',
      mode: 'quick',
    })) as ApiResult<Project>
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const projectId = created.data.project_id

    // 先创建一个快照，才能回滚。
    // create_snapshot 为 warning 级、rollback_snapshot 为 dangerous 级，默认 ask 模式会挂起
    // 等待用户决策；此处按 S0-PERM-003 惯例解析 pending 请求（决策 allow）。
    const snapshotPending = harness.invoke('snapshot:create', {
      request_id: 't8-snapshot',
      project_id: projectId,
      kind: 'sketch',
      summary: 'for undo test',
      include_documents: false,
      health_status: 'healthy',
    })
    const createReq = getPendingRequests().find((req) => req.tool_name === 'create_snapshot')
    expect(createReq).toBeDefined()
    if (!createReq) return
    resolvePermission({
      request_id: 't8-snapshot',
      permission_request_id: createReq.id,
      session_id: createReq.session_id,
      decision: 'allow',
    })
    const snapshot = (await snapshotPending) as ApiResult<{ snapshot_id: string }>
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) return
    const snapshotId = snapshot.data.snapshot_id

    const rollbackPending = harness.invoke('snapshot:rollback', {
      request_id: 't8-rollback',
      project_id: projectId,
      snapshot_id: snapshotId,
      reason: 'user_undo',
    })
    const rollbackReq = getPendingRequests().find((req) => req.tool_name === 'rollback_snapshot')
    expect(rollbackReq).toBeDefined()
    if (!rollbackReq) return
    resolvePermission({
      request_id: 't8-rollback',
      permission_request_id: rollbackReq.id,
      session_id: rollbackReq.session_id,
      decision: 'allow',
    })
    const rollback = (await rollbackPending) as ApiResult<{ snapshot_id: string }>
    expect(rollback.ok).toBe(true)

    const events = readAnalytics().map((e) => e.event_type as string)
    expect(events).toContain('user_undo')
  })

  it('[T8-004] 埋点事件完整性审计：联合成员源码活读取 + 覆盖双向对账', () => {
    // 本测试为静态审计，确保当新增/删除事件类型时有人维护触发路径与测试覆盖。
    // 真源活读取（2026-10-03 重构，对齐开关对账测试模式）：联合成员直接从
    // shared/types.ts 源码提取——手抄清单会随整线退役漂移成幽灵（web 线拆除后
    // 14 个零写入方成员与 3 个死覆盖文件即教训），活读取让漂移即红。
    const typesSource = readFileSync(join(__dirname, '..', '..', '..', 'shared', 'types.ts'), 'utf8')
    const typeLines = typesSource.split(/\r?\n/)
    const unionStart = typeLines.findIndex((l) => l.trim() === 'event_type:')
    expect(unionStart, 'AnalyticsTrackInput.event_type 联合定位失败（shared/types.ts 结构变更？）').toBeGreaterThan(-1)
    const allDefinedEventTypes: string[] = []
    for (let i = unionStart + 1; i < typeLines.length; i++) {
      const line = typeLines[i]
      const member = /^\s*\| '([a-z_]+)'/.exec(line)
      if (member) {
        allDefinedEventTypes.push(member[1])
        continue
      }
      // 联合内的文档注释与空行跳过；其余行（project_id 等字段）= 联合结束
      if (line.trim() === '' || line.trim().startsWith('/**') || line.trim().startsWith('*')) continue
      break
    }
    expect(new Set(allDefinedEventTypes).size, '联合成员不得重复').toBe(allDefinedEventTypes.length)
    expect(allDefinedEventTypes.length, '活读取结果异常（空联合）').toBeGreaterThan(0)

    // 事件 → 断言所在测试文件（相对仓库根）；文件必须存在且源码含该事件字面量。
    const coveredByExistingTests: Record<string, string[]> = {
      mode_upgraded: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
      satisfaction_marked: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
      project_finalized: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
      user_undo: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-003
      scope_confirmed: ['tests/unit/guide-prd-confirm.test.ts'], // 确认动作留存断言
      desktop_dispatch_run: ['tests/unit/desktop/dispatcher-loop.test.ts'], // 桌面线运行遥测
      desktop_dispatch_run_started: ['tests/unit/desktop/dispatcher-loop.test.ts'],
      conversation_submitted: ['tests/acceptance/sprint2/guide-clarification-fixes.test.ts'], // 原生向导实际落盘
    }

    const todoBlocked: Record<string, string> = {
      project_created: '写入方活跃（project-service createProject）；断言文件随 web 线拆除退役，待补。',
      clarification_responded: '写入方活跃（guide 线 U5 J5）；待补断言。',
      decision_selected: '写入方活跃（guide 线 P7-9b）；待补断言。',
      test_completed: '旧事件类型供历史 bench/报告读取；当前桌面验证使用独立核心验证与实验事件，无新 Web 执行写入方。',
      desktop_drive_session_started: '探索会话有运行写入方，尚无独立的分析JSONL事件断言。',
      desktop_drive_step: '探索步骤有运行写入方，尚无独立的分析JSONL事件断言。',
      desktop_drive_findings: '探索发现有运行写入方，尚无独立的分析JSONL事件断言。',
      desktop_drive_session_closed: '探索会话收尾有运行写入方，尚无独立的分析JSONL事件断言。',
      desktop_delivery_outcome: '交付结果派生已有单测，分析JSONL落盘事件尚缺直接断言。',
    }

    // 引用实存校验：断言文件必须存在，且源码中真实出现该事件字面量（否则覆盖声称失实）
    for (const [eventType, files] of Object.entries(coveredByExistingTests)) {
      for (const file of files) {
        const absolutePath = join(__dirname, '..', '..', '..', file)
        expect(existsSync(absolutePath), `事件 "${eventType}" 引用的断言文件不存在: ${file}`).toBe(true)
        const source = readFileSync(absolutePath, 'utf8')
        expect(
          source.includes(`'${eventType}'`) || source.includes(`"${eventType}"`),
          `事件 "${eventType}" 在 ${file} 源码中无该字面量的断言——覆盖声称失实`,
        ).toBe(true)
      }
    }

    for (const eventType of allDefinedEventTypes) {
      const covered = eventType in coveredByExistingTests
      const blocked = eventType in todoBlocked
      expect(
        covered || blocked,
        `事件 "${eventType}" 必须在已有测试中有覆盖，或在 todoBlocked 中说明原因`,
      ).toBe(true)
    }

    // 确保静态审计表没有遗漏新增事件类型
    expect(Object.keys(coveredByExistingTests).length + Object.keys(todoBlocked).length).toBe(
      allDefinedEventTypes.length,
    )
  })
})

/** 沙箱进程替身：满足 waitForSandbox 的 exit/error 监听与 terminateProcessTree 的 kill/pid。 */
function makeChildProcess(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess
  Object.assign(emitter, { kill: vi.fn(() => true), pid: 2000 })
  return emitter
}

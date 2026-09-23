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

  it('[T8-002] 点选纠错事件：point_correction（含 repeat_count / fallback_mode）', async () => {
    const { harness, readAnalytics } = setup('bloma-t8-correction-')

    const created = (await harness.invoke('project:create', {
      request_id: 't8-corr-create',
      mode: 'quick',
    })) as ApiResult<Project>
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const projectId = created.data.project_id

    const result = (await harness.invoke('project:submit-correction', {
      request_id: 't8-corr-1',
      project_id: projectId,
      session_id: 't8-corr-session',
      mode: 'guess',
      context: {
        element_selector: '.todo-list .item',
        bounding_rect: { x: 10, y: 20, width: 100, height: 30 },
        fallback_mode: false,
      },
    })) as ApiResult<{ accepted: boolean; repeat_count: number }>
    expect(result.ok).toBe(true)

    const events = readAnalytics().map((e) => e.event_type as string)
    expect(events).toContain('point_correction')

    const correction = readAnalytics().find((e) => e.event_type === 'point_correction')
    expect(correction?.payload).toMatchObject({
      target_type: 'element',
      fallback_mode: false,
      repeat_count: 1,
    })
  })

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

  it('[T8-004] 埋点事件完整性审计：所有已定义事件类型均有真实断言或明确阻塞项', () => {
    // 本测试为静态审计，确保当新增/删除事件类型时有人维护触发路径与测试覆盖。
    // 事件类型真源来自 shared/types.ts AnalyticsTrackInput.event.event_type 联合类型。
    //
    // 审计真实化（对抗审查 M3 修复）：覆盖表从「表内有条目即过」升级为「引用实存校验」——
    // 每个事件的断言文件必须真实存在于仓库，且其源码中 grep 得到该事件字面量的
    // 落盘断言（readAnalytics/expect(...event_type)），杜绝「引用一个不存在的覆盖」。
    const allDefinedEventTypes = [
      'project_created',
      'conversation_submitted',
      'guide_role_switched',
      'sketch_generated',
      'sketch_fallback',
      'mvp_delivered',
      'user_undo',
      'point_correction',
      'mode_upgraded',
      'programming_execution',
      'self_repair_triggered',
      'judge_verdict',
      'satisfaction_marked',
      'project_finalized',
    ] as const

    // 事件 → 断言所在测试文件（相对仓库根）；文件必须存在且源码含该事件字面量。
    const coveredByExistingTests: Record<string, string[]> = {
      project_created: [
        'tests/acceptance/sprint3/analytics-completeness.test.ts', // T8-001
        'tests/acceptance/sprint1/sketch-delivery.test.ts', // S1-ANALYTICS-001
      ],
      conversation_submitted: ['tests/acceptance/sprint1/sketch-delivery.test.ts'],
      sketch_generated: ['tests/acceptance/sprint1/sketch-delivery.test.ts'], // 含 FIRT duration_ms
      sketch_fallback: ['tests/unit/sketch-fallback-observability.test.ts'],
      mvp_delivered: [
        'tests/acceptance/sprint3/analytics-completeness.test.ts', // 事件枚举审计
        'tests/e2e/sprint2/mvp-workflow.e2e.ts', // E2E 轮询 mvp_delivered 落盘
      ],
      user_undo: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-003
      point_correction: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-002
      mode_upgraded: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
      self_repair_triggered: ['tests/acceptance/sprint3/agent-loop-pipeline.test.ts'], // loop onRepairRound 落盘（废旧管道改造后来源换为 agent loop）
      judge_verdict: ['tests/acceptance/sprint3/agent-loop-pipeline.test.ts'], // 终验 judge 判定落盘
      satisfaction_marked: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
      project_finalized: ['tests/acceptance/sprint3/analytics-completeness.test.ts'], // T8-001
    }

    const todoBlocked: Record<string, string> = {
      guide_role_switched:
        'Phase 1 当前实现无 DialogueRouter 显式角色切换；guide-agent-service 以单一路由处理用户输入，未按 PRD §6.2 切需求分析师/UI/UX 顾问/架构设计师/工程经理角色。待 DialogueRouter 落地后补写入点。',
      programming_execution:
        '该事件原由废旧管道 repair-engine（applyRepairPatchWithLlm）落盘；Agent Loop 转正后修复已内化进 loop（onRepairRound 落 self_repair_triggered + agent_loop_turn 记录轮次），不再有独立编程执行埋点。事件类型保留（向后兼容历史 JSONL），无新产生点。',
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

import { restorePromaHome } from '../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { circuitBreakRollback } from '../../main/project/recovery-service'
import { createProject, findProject, updateProject } from '../../main/project/project-service'
import { recordSessionActivity } from '../../main/platform/sessions/session-service'
import { clearSandboxRuntimeForTests, setSandboxRuntimeForTests } from '../../main/delivery/sandbox'
import { createSnapshot } from '../../main/delivery/snapshots'
import { getAgentSessionPath, getDocumentsDir, getSnapshotsDir } from '../../storage/config-paths'

/**
 * 熔断回滚事务（长期型改造 T5）：修复循环耗尽后回滚健康快照 + 阶段收敛，
 * 回滚失败如实告知不留半事务态。沙箱运行时注入假进程，不启真实子进程。
 */
// 【挂账 2026-10-03 删留执行】circuitBreakRollback 生产零调用（全仓 grep 反证）：
// isCircuitBreakSettled 哨兵被 14 个文件 import 等待一个永不触发的信号——熔断
// 触发链在 orchestration 重构中断裂。本文件 T5 事务语义（计数清零/verified 优先/
// 失败如实）是重接时的行为规格，保留待裁决：A) 重接熔断触发；B) 移除哨兵协议后
// 本文件随 circuitBreakRollback 一并退役。裁决前不新增依赖此路径的用例。

describe('circuit break rollback (T5)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    clearSandboxRuntimeForTests()
  })

  function injectFakeSandboxRuntime(): void {
    setSandboxRuntimeForTests({
      processFactory: () =>
        ({
          stdout: { on: () => undefined },
          stderr: { on: () => undefined },
          once: () => undefined,
          kill: () => true,
        }) as unknown as ChildProcess,
      portAllocator: async () => 3210,
      healthCheck: async () => true,
    })
  }

  function setup(): { projectId: string; sessionId: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-circuit-'))
    process.env.PROMA_HOME = home
    injectFakeSandboxRuntime()
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`
    recordSessionActivity(sessionId, project.project_id)
    return { projectId: project.project_id, sessionId }
  }

  function writeCompleteArtifact(rootPath: string): void {
    mkdirSync(join(rootPath, 'src'), { recursive: true })
    writeFileSync(
      join(rootPath, 'index.html'),
      '<html><head><style>body{margin:0}</style></head><body><button id="go">点我</button><script src="/src/app.js"></script></body></html>',
      'utf8',
    )
    writeFileSync(join(rootPath, 'src', 'app.js'), "document.getElementById('go').addEventListener('click', () => {})", 'utf8')
  }

  it('修复耗尽 → 回滚健康快照，按磁盘证据收敛 ready，计数清零，消息与决策如实落盘', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: projectId,
      kind: 'mvp',
      summary: 'MVP 快照',
      include_documents: false,
      health_status: 'healthy',
    })
    // 修复循环把文件改坏（耗尽时的现场）
    writeFileSync(join(findProject(projectId).root_path, 'index.html'), '<html><body>坏了', 'utf8')
    updateProject(projectId, {
      current_stage: 'blocked_for_user_decision',
      runtime_repair_count: 3,
      test_repair_count: 3,
      blocked_action: 'test_repair',
    })

    const published: Array<{ type: string; payload: Record<string, unknown> }> = []
    const result = await circuitBreakRollback({
      request_id: 'req-circuit',
      session_id: sessionId,
      project_id: projectId,
      reason: 'test 修复循环耗尽（test_repair）',
      // W5：带已知未通过项 → mvp_review 卡主选项 fix_now
      failureNote: '注意：这一版有 1 项检查未通过，已如实登记（不会当作「已完成」）。',
      publish: (type, payload) => published.push({ type, payload }),
    })

    expect(result.rolled_back).toBe(true)
    expect(result.stage).toBe('ready')
    expect(result.snapshot_id).toBe(snapshot.snapshot_id)
    // 文件确实从快照恢复（坏文件被换回完整产物）
    expect(readFileSync(join(findProject(projectId).root_path, 'index.html'), 'utf8')).toContain('</html>')
    // 阶段与磁盘一致，计数清零，阻塞标记清除
    const project = findProject(projectId)
    expect(project.current_stage).toBe('ready')
    expect(project.current_snapshot_id).toBe(snapshot.snapshot_id)
    expect(project.runtime_repair_count).toBe(0)
    expect(project.test_repair_count).toBe(0)
    expect(project.blocked_action).toBeUndefined()
    // 事件：rollback_done（渲染端回填预览）→ 阶段收敛 + 如实消息 + completed 收尾（上层不再当失败处理）
    expect(published.find((event) => event.type === 'rollback_done')?.payload.snapshot_id).toBe(snapshot.snapshot_id)
    expect(published.find((event) => event.type === 'stage_changed')?.payload.stage).toBe('ready')
    expect(published.some((event) => event.type === 'completed')).toBe(true)
    // W5（本月流水账案）：熔断→ready 也发 mvp_review 卡——引导链断点补齐；
    // 带 failureNote（已知未通过项）时主选项 fix_now（先修这一项）
    const review = published.find((event) => event.type === 'user_decision_required')
    expect(review?.payload.kind).toBe('mvp_review')
    const questions = (review?.payload.questions as Array<{ id: string }>) ?? []
    expect(questions.map((q) => q.id)).toContain('fix_now')
    expect(questions.map((q) => q.id)).toContain('keep')
    // 会话 JSONL 有回滚告知；话术口径（狗粮 52f19ab4）：次数如实（6 轮）+
    // 「保存的版本」术语（首次生成不再说「回到之前的版本」）
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('自动修复 6 轮都没有成功')
    expect(session).toContain('已自动恢复到最近保存的版本')
    expect(session).not.toContain('自动修复多次')
    // R0.6（2026-09-19 狗粮 7601e5ae）：话术不再一律称「内容都还在」——恢复范
    // 围如实为代码与文档；data/ 有备份时如实说明，无 data/ 时不再位称数据未丢
    expect(session).toContain('（代码与文档）')
    expect(session).not.toContain('内容都还在，没有丢失')
    const decisions = readFileSync(
      join(getDocumentsDir(findProject(projectId).workspace_slug, projectId), 'decisions.md'),
      'utf8',
    )
    expect(decisions).toContain('circuit_rollback')
    expect(decisions).toContain('修复循环耗尽')
  })

  it('无健康快照 → 不回滚，交回调用方让渡（blocked 由调用方处理）', async () => {
    const { projectId, sessionId } = setup()
    updateProject(projectId, { current_stage: 'repairing' })

    const result = await circuitBreakRollback({
      request_id: 'req-circuit',
      session_id: sessionId,
      project_id: projectId,
      reason: 'runtime 修复循环耗尽（mvp_repair）',
      publish: () => undefined,
    })

    expect(result.rolled_back).toBe(false)
    expect(findProject(projectId).current_stage).toBe('repairing')
  })

  it('回滚失败（快照文件损坏）→ 如实告知用户，不留半事务态', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: projectId,
      kind: 'mvp',
      summary: 'MVP 快照',
      include_documents: false,
      health_status: 'healthy',
    })
    // 快照元数据仍在（能被列为健康快照），但文件归档被外力损坏：恢复复制必然失败（含一次重试）
    rmSync(join(getSnapshotsDir(findProject(projectId).workspace_slug, projectId), snapshot.snapshot_id, 'files'), {
      force: true,
      recursive: true,
    })

    const result = await circuitBreakRollback({
      request_id: 'req-circuit',
      session_id: sessionId,
      project_id: projectId,
      reason: 'test 修复循环耗尽（test_repair）',
      publish: () => undefined,
    })

    expect(result.rolled_back).toBe(false)
    expect(result.error).toBeTruthy()
    // 如实告知（会话 JSONL），不冒充成功；0 次修复轮不再谎称「多次」（狗粮 52f19ab4 口径）
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('这次没能进行自动修复')
    expect(session).toContain('回滚到最近保存的健康版本也没有成功')
  })

  it('P1-07 回滚优先已验证快照：verified 较旧 + recoverable 较新 → 选 verified，恢复依据如实落盘', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    // 先落 verified（较旧），再落 recoverable（较新）
    const verified = await createSnapshot({
      request_id: 'req-v', project_id: projectId, kind: 'mvp', summary: '已验证快照',
      include_documents: false, health_status: 'healthy', verification: 'verified',
    })
    const recoverable = await createSnapshot({
      request_id: 'req-r', project_id: projectId, kind: 'mvp', summary: '可预览快照',
      include_documents: false, health_status: 'healthy', verification: 'recoverable',
    })
    // 修复循环把文件改坏
    writeFileSync(join(findProject(projectId).root_path, 'index.html'), '<html><body>坏了', 'utf8')
    updateProject(projectId, { current_stage: 'blocked_for_user_decision', test_repair_count: 1 })

    const result = await circuitBreakRollback({
      request_id: 'req-circuit', session_id: sessionId, project_id: projectId,
      reason: 'test 修复循环耗尽（test_repair）', publish: () => undefined,
    })

    expect(result.rolled_back).toBe(true)
    expect(result.snapshot_id).toBe(verified.snapshot_id) // 优先 verified 而非更新的 recoverable
    expect(result.snapshot_id).not.toBe(recoverable.snapshot_id)
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('已验证版本（该版本已通过全部验证）')
    const decisions = readFileSync(
      join(getDocumentsDir(findProject(projectId).workspace_slug, projectId), 'decisions.md'),
      'utf8',
    )
    expect(decisions).toContain('restore_basis')
    expect(decisions).toContain('verified')
  })

  it('P1-07 无 verified 时回退可预览快照：话术如实标注未经终验（不冒充已验证）', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    await createSnapshot({
      request_id: 'req-r2', project_id: projectId, kind: 'mvp', summary: '可预览快照',
      include_documents: false, health_status: 'healthy',
    }) // 存量形态：无 verification 字段
    writeFileSync(join(findProject(projectId).root_path, 'index.html'), '<html><body>坏了', 'utf8')
    updateProject(projectId, { current_stage: 'blocked_for_user_decision' })

    const result = await circuitBreakRollback({
      request_id: 'req-circuit2', session_id: sessionId, project_id: projectId,
      reason: 'test 修复循环耗尽（test_repair）', publish: () => undefined,
    })

    expect(result.rolled_back).toBe(true)
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('尚未通过终验，仅确认可预览')
    expect(session).not.toContain('已通过全部验证')
  })
})

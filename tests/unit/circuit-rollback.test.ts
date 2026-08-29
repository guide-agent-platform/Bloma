import { restorePromaHome } from '../support/proma-home-guard'
import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { circuitBreakRollback } from '../../main/recovery-service'
import { createProject, findProject, updateProject } from '../../main/project-service'
import { recordSessionActivity } from '../../main/session-service'
import { clearSandboxRuntimeForTests, createSnapshot, setSandboxRuntimeForTests } from '../../main/platform-services'
import { getAgentSessionPath, getDocumentsDir, getSnapshotsDir } from '../../storage/config-paths'

/**
 * 熔断回滚事务（长期型改造 T5）：修复循环耗尽后回滚健康快照 + 阶段收敛，
 * 回滚失败如实告知不留半事务态。沙箱运行时注入假进程，不启真实子进程。
 */
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
    // 会话 JSONL 有回滚告知；决策日志记录熔断回滚
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('回到之前的版本')
    expect(session).toContain('内容都还在，没有丢失')
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
    // 如实告知（会话 JSONL），不冒充成功
    const session = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    expect(session).toContain('回滚到上一个健康版本也没有成功')
  })
})

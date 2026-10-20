import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  convergeStageFromEvidence,
  evaluateDiskArtifact,
  reconcileInterruptedProjects,
} from '../../main/project/recovery-service'
import { createProject, findProject, updateProject } from '../../main/project/project-service'
import { recordSessionActivity, setProjectTouchHandler } from '../../main/platform/sessions/session-service'

// PR4 后续：平台件已去域依赖，测试接真源（与 main/index 接线同款；项目缺席静默）
setProjectTouchHandler((projectId, patch) => {
  try {
    updateProject(projectId, patch)
  } catch {
    /* 测试场景项目缺席静默 */
  }
})
import { createSnapshot } from '../../main/delivery/snapshots'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'

/**
 * 启动孤儿阶段对账（长期型改造 T1）：模拟崩溃残留中间态，
 * 重启对账后阶段与磁盘证据一致，且对话中有如实说明。
 */
describe('startup reconcile (T1)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  function setup(): { projectId: string; sessionId: string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-reconcile-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`
    recordSessionActivity(sessionId, project.project_id)
    return { projectId: project.project_id, sessionId }
  }

  it('preserves interrupted Python desktop source and phase even with an older healthy snapshot', async () => {
    const { projectId, sessionId } = setup()
    const root = findProject(projectId).root_path
    writeFileSync(join(root, 'app.py'), '# older desktop version')
    await createSnapshot({ request_id: 'desktop-snapshot', project_id: projectId, kind: 'mvp', summary: 'older version', include_documents: false, health_status: 'healthy' })
    writeFileSync(join(root, 'app.py'), '# current desktop work')
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'records.json'), '[{"amount":42}]')
    updateProject(projectId, { current_stage: 'generating_mvp', desktop_phase: 'desktop-implement' })
    const outcomes = await reconcileInterruptedProjects()
    expect(outcomes[0]).toMatchObject({ action: 'desktop_preserved', to_stage: 'blocked_for_user_decision' })
    expect(findProject(projectId)).toMatchObject({ desktop_phase: 'desktop-implement', desktop_blocked: { reason: 'startup-interrupted' } })
    expect(readFileSync(join(root, 'app.py'), 'utf8')).toBe('# current desktop work')
    expect(readFileSync(join(root, 'data', 'records.json'), 'utf8')).toBe('[{"amount":42}]')
    expect(readSessionText(sessionId)).toContain('没有自动回滚')
    expect(await reconcileInterruptedProjects()).toEqual([])
  })

  /** 写一份「完整 MVP 产物」：合法 HTML 文档 + 交互控件 + app.js 脚本逻辑。 */
  function writeCompleteArtifact(rootPath: string): void {
    mkdirSync(join(rootPath, 'src'), { recursive: true })
    writeFileSync(
      join(rootPath, 'index.html'),
      '<html><head><style>body{margin:0}</style></head><body><button id="go">点我</button><script src="/src/app.js"></script></body></html>',
      'utf8',
    )
    writeFileSync(join(rootPath, 'src', 'app.js'), "document.getElementById('go').addEventListener('click', () => {})", 'utf8')
  }

  /** 写一份「草图级产物」：合法 HTML 文档但无交互入口（无交互控件或无脚本逻辑）。 */
  function writeSketchArtifact(rootPath: string): void {
    mkdirSync(join(rootPath, 'src'), { recursive: true })
    writeFileSync(
      join(rootPath, 'index.html'),
      '<html><head><style>body{margin:0}</style></head><body><div>纯外观草图</div></body></html>',
      'utf8',
    )
    writeFileSync(join(rootPath, 'src', 'app.js'), '', 'utf8')
  }

  function readSessionText(sessionId: string): string {
    return readFileSync(getAgentSessionPath(sessionId), 'utf8')
  }

  it('testing 阶段中断但磁盘产物完整 → 收敛 blocked_for_user_decision 交用户决策（P0-3）', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    updateProject(projectId, { current_stage: 'testing' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ project_id: projectId, from_stage: 'testing', to_stage: 'blocked_for_user_decision', action: 'disk_verified' })
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
    expect(findProject(projectId).blocked_action).toBe('test_repair')
    const text = readSessionText(sessionId)
    expect(text).toContain('[reconcile]')
    expect(text).toContain('被中断')
    expect(text).toContain('继续完成测试')
  })

  it('judge_review 阶段中断但磁盘产物完整 → 同样收敛 blocked_for_user_decision（P0-3）', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    updateProject(projectId, { current_stage: 'judge_review' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ to_stage: 'blocked_for_user_decision' })
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
    expect(findProject(projectId).blocked_action).toBe('test_repair')
    expect(readSessionText(sessionId)).toContain('继续完成测试')
  })

  it('generating_mvp 阶段中断但磁盘产物完整 → 非质量门阶段，仍收敛 ready（P0-3 不改生成期）', async () => {
    const { projectId, sessionId } = setup()
    writeCompleteArtifact(findProject(projectId).root_path)
    updateProject(projectId, { current_stage: 'generating_mvp' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ to_stage: 'ready' })
    expect(findProject(projectId).current_stage).toBe('ready')
    expect(findProject(projectId).blocked_action).toBeUndefined()
    expect(readSessionText(sessionId)).toContain('已恢复为可用状态')
  })

  it('generating_mvp 中断、产物损坏但有健康快照 → 回滚快照后按证据收敛 sketch_ready', async () => {
    const { projectId, sessionId } = setup()
    // 先有草图产物 + 健康快照（模拟 sketch_ready 阶段拍下的快照）
    writeSketchArtifact(findProject(projectId).root_path)
    const snapshot = await createSnapshot({
      request_id: 'req-snap',
      project_id: projectId,
      kind: 'sketch',
      summary: '草图快照',
      include_documents: false,
      health_status: 'healthy',
    })
    // 崩溃残留：MVP 生成写了一半（截断的 HTML，非完整文档）
    writeFileSync(join(findProject(projectId).root_path, 'index.html'), '<html><body>写了一半', 'utf8')
    updateProject(projectId, { current_stage: 'generating_mvp' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes[0]).toMatchObject({ to_stage: 'sketch_ready', action: 'snapshot_restored' })
    expect(findProject(projectId).current_stage).toBe('sketch_ready')
    expect(findProject(projectId).current_snapshot_id).toBe(snapshot.snapshot_id)
    const text = readSessionText(sessionId)
    expect(text).toContain('回滚到最近一个健康快照')
    expect(text).toContain('草图确认阶段')
    // 决策日志同步记录了系统级状态跃迁
    const decisions = readFileSync(
      join(getDocumentsDir(findProject(projectId).workspace_slug, projectId), 'decisions.md'),
      'utf8',
    )
    expect(decisions).toContain('startup_convergence')
  })

  it('repairing 中断、无产物无快照 → 收敛 clarifying 并如实说明', async () => {
    const { projectId, sessionId } = setup()
    updateProject(projectId, { current_stage: 'repairing' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes[0]).toMatchObject({ to_stage: 'clarifying' })
    expect(findProject(projectId).current_stage).toBe('clarifying')
    expect(readSessionText(sessionId)).toContain('没有找到完整产物')
  })

  it('非中间态与归档项目不做对账', async () => {
    const { projectId } = setup()
    updateProject(projectId, { current_stage: 'ready' })
    const archived = createProject({ request_id: 'req-archived', mode: 'quick' })
    updateProject(archived.project_id, { current_stage: 'testing', status: 'archived' })

    const outcomes = await reconcileInterruptedProjects()

    expect(outcomes).toHaveLength(0)
    expect(findProject(archived.project_id).current_stage).toBe('testing')
  })

  it('evaluateDiskArtifact：完整/草图级/全无三分', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-evidence-'))
    const complete = join(home, 'complete')
    const sketch = join(home, 'sketch')
    writeCompleteArtifact(complete)
    writeSketchArtifact(sketch)
    expect(evaluateDiskArtifact(complete)).toBe('complete')
    expect(evaluateDiskArtifact(sketch)).toBe('sketch_only')
    expect(evaluateDiskArtifact(join(home, 'none'))).toBe('none')
    // HTML 完整但交互脚本丢失（如崩溃时写了一半）→ 只算草图级，不冒充 ready
    const lostJs = join(home, 'lost-js')
    writeCompleteArtifact(lostJs)
    rmSync(join(lostJs, 'src'), { recursive: true, force: true })
    expect(existsSync(join(lostJs, 'index.html'))).toBe(true)
    expect(evaluateDiskArtifact(lostJs)).toBe('sketch_only')
    expect(convergeStageFromEvidence('complete')).toBe('ready')
    expect(convergeStageFromEvidence('sketch_only')).toBe('sketch_ready')
    expect(convergeStageFromEvidence('none')).toBe('clarifying')
  })

  it('evaluateDiskArtifact：Agent Loop 外链样式产物不误判为 none（2026-08-25 线上案例）', () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-loop-evidence-'))
    const root = join(home, 'loop')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<html><head><link rel="stylesheet" href="src/styles.css"></head><body><button id="go">点我</button><script src="src/app.js"></script></body></html>',
      'utf8',
    )
    writeFileSync(join(root, 'src', 'app.js'), "document.getElementById('go').addEventListener('click', () => {})", 'utf8')
    // 外链样式 + 交互控件 + 脚本逻辑 → complete（此前被判 none → 熔断回滚后收敛 clarifying + 「没有可用产物」假话）
    expect(evaluateDiskArtifact(root)).toBe('complete')
    expect(convergeStageFromEvidence(evaluateDiskArtifact(root))).toBe('ready')
    // 交互脚本缺失 → 仍降级 sketch_only，不冒充 ready
    const lostJs = join(home, 'loop-lost-js')
    mkdirSync(join(lostJs, 'src'), { recursive: true })
    writeFileSync(
      join(lostJs, 'index.html'),
      '<html><head><link rel="stylesheet" href="src/styles.css"></head><body><button>点我</button></body></html>',
      'utf8',
    )
    writeFileSync(join(lostJs, 'src', 'app.js'), '', 'utf8')
    expect(evaluateDiskArtifact(lostJs)).toBe('sketch_only')
  })
})

import { restorePromaHome } from '../support/proma-home-guard'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import { runJudgeReview, setForegroundRunChecker, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'

describe('Judge review trigger and return counts (A2-11)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setProgrammingEventPublisher(() => undefined)
  })

  it('lets go after 2 returns for a quick project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-review-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) => events.push({ type: event.type, payload: event.payload as Record<string, unknown> }))

    const result = await runJudgeReview({ request_id: 'req-judge', session_id: 'session-1', project_id: project.project_id })

    expect(result.outcome).toBe('blocked')
    expect(result.verdict.verdict).toBe('return')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    expect(findProject(project.project_id).judge_return_count).toBe(3)
    // 快消：2 次退回内允许修复（repairing ×2），第 3 次判定退回后让渡
    expect(events.filter((event) => event.type === 'repairing')).toHaveLength(2)
    expect(events.filter((event) => event.type === 'judge_result')).toHaveLength(3)
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision).toBeTruthy()
    const questions = decision?.payload.questions as Array<{ id: string; label: string }> | undefined
    expect(questions?.map((q) => q.label)).toContain('接受现状')
    // A1：编程阻塞路径的 questions 必须带稳定 id（continue/accept/explain），与引导澄清路径形态一致
    expect(questions?.map((q) => q.id)).toEqual(['continue', 'accept', 'explain'])
    // A4：repairing 事件必须带 user_visible_summary，供前端横幅展示具体进度
    const repairing = events.find((event) => event.type === 'repairing')
    expect(repairing?.payload.user_visible_summary).toBeTruthy()
    expect(JSON.stringify(events)).not.toMatch(/node_modules|Error:|at /)
  })

  it('lets go after 3 returns for a longterm project', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-review-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'longterm' })
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const result = await runJudgeReview({ request_id: 'req-judge', session_id: 'session-1', project_id: project.project_id })

    expect(result.outcome).toBe('blocked')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    expect(findProject(project.project_id).judge_return_count).toBe(4)
    expect(events.filter((type) => type === 'repairing')).toHaveLength(3)
  })

  it('reaches ready and leaves return count untouched when everything passes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-review-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-1', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) => events.push({ type: event.type, payload: event.payload as Record<string, unknown> }))

    const result = await runJudgeReview({ request_id: 'req-judge', session_id: 'session-1', project_id: project.project_id })

    expect(result.outcome).toBe('ready')
    expect(result.verdict.verdict).toBe('pass')
    expect(findProject(project.project_id).current_stage).toBe('ready')
    expect(findProject(project.project_id).judge_return_count ?? 0).toBe(0)
    // MVP 就绪三按钮卡（2026-09-11 卡位改版）：ready 收敛即发 mvp_review 卡
    //（原「走向完整产物」引导卡与 delivery_presented 埋点后移到「保持现状」分支）
    const card = events.find((event) => event.type === 'user_decision_required')
    expect((card?.payload as { kind?: string }).kind).toBe('mvp_review')
    const questions = (card?.payload as { questions?: Array<{ id: string }> }).questions
    expect(questions?.map((q) => q.id)).toEqual(['keep', 'optimize', 'rebuild'])
  })

  it('MVP 完成到 ready 时主动下发最终交付消息（落盘 + delivery_message + completed，2026-09-11 交付话术改造）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-complete-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-complete', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) => events.push({ type: event.type, payload: event.payload as Record<string, unknown> }))

    await runJudgeReview({ request_id: 'req-judge', session_id: 'session-complete', project_id: project.project_id })

    // 主动完成通知（2026-09-11 交付话术改造）：无 query/向导渠道时走兑底话术，
    // 经 delivery_message 专用事件上屏（渲染端把过程消息收起）+ completed 收尾
    const delta = events.find((event) => event.type === 'delivery_message')
    expect(delta).toBeTruthy()
    expect(String(delta?.payload.text ?? '')).toContain('已经生成好了')
    expect((delta?.payload as { fallback?: boolean }).fallback).toBe(true)
    expect(events.some((event) => event.type === 'completed')).toBe(true)

    // 落盘：会话 JSONL 里有对应助手消息（回访恢复时对话完整）
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-complete.jsonl'), 'utf8')
    expect(jsonl).toContain('已经生成好了')
  })
})

describe('Judge review loop-aware fuse（M4-B：只终验不重修）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    setProgrammingEventPublisher(() => undefined)
    setForegroundRunChecker(() => false)
  })

  it('repairInternalized（loop 路径）：首次 return 即熔断让渡，不再外部文档重修（无 repairing）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-fuse-'))
    process.env.PROMA_HOME = home
    // 无 PRD 背板 → judge return（repairable=true 的 constraint_error），但 loop 路径内化修复已用尽
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const result = await runJudgeReview({
      request_id: 'req-judge',
      session_id: 'session-fuse',
      project_id: project.project_id,
      loop: { status: 'completed', turns: 10, finalText: '完成', toolCalls: [] },
      repairInternalized: true,
    })

    expect(result.outcome).toBe('blocked')
    expect(result.verdict.verdict).toBe('return')
    // 首败熔断：judge_return_count 只 +1，不再循环重修
    expect(findProject(project.project_id).judge_return_count).toBe(1)
    expect(events.filter((type) => type === 'repairing')).toHaveLength(0)
    expect(events.filter((type) => type === 'judge_result')).toHaveLength(1)
    expect(events).toContain('user_decision_required')
    expect(findProject(project.project_id).current_stage).toBe('blocked_for_user_decision')
    // 让渡终态补发（2026-08-29 卡死修复）：后台流无 runAgent 兜底，必须补 completed 复位渲染端
    expect(events).toContain('completed')
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-fuse.jsonl'), 'utf8')
    expect(jsonl).toContain('这里需要你来定夺')
  })

  it('loop 异常终止态（repairable=false）：即使无 repairInternalized 也首败让渡', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-fuse-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const result = await runJudgeReview({
      request_id: 'req-judge',
      session_id: 'session-fuse-2',
      project_id: project.project_id,
      loop: { status: 'turn_limit', turns: 24, finalText: '轮次耗尽', toolCalls: [] },
    })

    expect(result.outcome).toBe('blocked')
    expect(result.verdict.repairable).toBe(false)
    expect(events.filter((type) => type === 'repairing')).toHaveLength(0)
    expect(events).toContain('user_decision_required')
  })

  it('前台 runAgent 流存在时不补发 completed（避免中途熄掉运行指示，resume 继续可能跑几分钟）', async () => {
    setForegroundRunChecker(() => true)
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-fuse-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    const events: string[] = []
    setProgrammingEventPublisher((event) => events.push(event.type))

    const result = await runJudgeReview({
      request_id: 'req-judge',
      session_id: 'session-fuse-3',
      project_id: project.project_id,
      loop: { status: 'turn_limit', turns: 24, finalText: '轮次耗尽', toolCalls: [] },
    })

    expect(result.outcome).toBe('blocked')
    expect(events).toContain('user_decision_required')
    // 前台流由 runAgent 收尾：让渡路径不得中途补发 completed
    expect(events).not.toContain('completed')
  })

  it('loop completed + judge pass → ready（loop 路径正常放行，judge_return_count 不动）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-fuse-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-fuse', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const result = await runJudgeReview({
      request_id: 'req-judge',
      session_id: 'session-fuse',
      project_id: project.project_id,
      loop: { status: 'completed', turns: 8, finalText: '完成', toolCalls: [] },
      repairInternalized: true,
    })

    expect(result.outcome).toBe('ready')
    expect(result.verdict.verdict).toBe('pass')
    expect(findProject(project.project_id).current_stage).toBe('ready')
    expect(findProject(project.project_id).judge_return_count ?? 0).toBe(0)
  })
})

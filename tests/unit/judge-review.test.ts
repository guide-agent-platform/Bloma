import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDocuments } from '../../main/document-engine'
import { runJudgeReview, setProgrammingEventPublisher } from '../../main/programming-orchestrator'
import { createProject, findProject, recordSketchGenerated } from '../../main/project-service'

describe('Judge review trigger and return counts (A2-11)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
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

    const result = await runJudgeReview({ request_id: 'req-judge', session_id: 'session-1', project_id: project.project_id })

    expect(result.outcome).toBe('ready')
    expect(result.verdict.verdict).toBe('pass')
    expect(findProject(project.project_id).current_stage).toBe('ready')
    expect(findProject(project.project_id).judge_return_count ?? 0).toBe(0)
  })

  it('MVP 完成到 ready 时主动下发「完成」助手消息（落盘 + message_delta + completed）', async () => {
    const home = mkdtempSync(join(tmpdir(), 'proma-judge-complete-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-project', mode: 'quick' })
    recordSketchGenerated(project.project_id, [{ id: 'F-001', description: '记录收入与支出' }])
    syncDocuments({ request_id: 'req-sync', session_id: 'session-complete', project_id: project.project_id, checkpoint: 'mvp_before_generation' })
    writeFileSync(join(project.root_path, 'index.html'), '<p>记录收入与支出</p>', 'utf8')

    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    setProgrammingEventPublisher((event) => events.push({ type: event.type, payload: event.payload as Record<string, unknown> }))

    await runJudgeReview({ request_id: 'req-judge', session_id: 'session-complete', project_id: project.project_id })

    // 主动完成通知：message_delta 上屏 + completed 收尾，消除「用户不知道完成了」的感知断裂
    const delta = events.find((event) => event.type === 'message_delta')
    expect(delta).toBeTruthy()
    expect(String(delta?.payload.text ?? '')).toContain('已经生成好了')
    expect(events.some((event) => event.type === 'completed')).toBe(true)

    // 落盘：会话 JSONL 里有对应助手消息（回访恢复时对话完整）
    const jsonl = readFileSync(join(home, 'agent-sessions', 'session-complete.jsonl'), 'utf8')
    expect(jsonl).toContain('已经生成好了')
  })
})

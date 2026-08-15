import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { exportDecisionsMd, recordDecision } from '../../main/decision-log'
import { createProject, findProject } from '../../main/project-service'
import { getAgentSessionPath, getDocumentsDir } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import { recordSessionActivity } from '../../main/session-service'

/** 决策日志（长期型改造 T2）：落盘 → decisions.md 同步重导出 → 历史行如实聚合。 */
describe('decision-log (T2)', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
  })

  function setup(): { projectId: string; sessionId: string; decisionsPath: () => string } {
    const home = mkdtempSync(join(tmpdir(), 'proma-decision-'))
    process.env.PROMA_HOME = home
    const project = createProject({ request_id: 'req-create', mode: 'quick' })
    const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`
    recordSessionActivity(sessionId, project.project_id)
    const decisionsPath = () =>
      join(getDocumentsDir(findProject(project.project_id).workspace_slug, project.project_id), 'decisions.md')
    return { projectId: project.project_id, sessionId, decisionsPath }
  }

  it('recordDecision 落盘 [decision] system 行并同步导出 decisions.md', () => {
    const { projectId, sessionId, decisionsPath } = setup()

    recordDecision({
      project_id: projectId,
      session_id: sessionId,
      entry: {
        type: 'modification_gate',
        title: '触发修改确认门',
        why: '识别到修改诉求，须先过用户确认',
        detail: { raw: '加个历史记录', description: '加个历史记录' },
      },
    })

    // JSONL 里有结构化决策行（system role）
    const jsonl = readFileSync(getAgentSessionPath(sessionId), 'utf8')
    const line = jsonl
      .split('\n')
      .filter(Boolean)
      .map((raw) => JSON.parse(raw) as { role: string; content: Array<{ type: string; text?: string }> })
      .find((message) => message.role === 'system' && message.content[0]?.text?.startsWith('[decision]'))
    expect(line).toBeDefined()
    const payload = JSON.parse(line!.content[0]!.text!.slice('[decision] '.length)) as Record<string, unknown>
    expect(payload.title).toBe('触发修改确认门')
    expect(payload.why).toContain('用户确认')

    // decisions.md 同步重导出（非会话结束批量）
    expect(existsSync(decisionsPath())).toBe(true)
    const markdown = readFileSync(decisionsPath(), 'utf8')
    expect(markdown).toContain('触发修改确认门')
    expect(markdown).toContain('识别到修改诉求')
    expect(markdown).toContain('modification_gate')
  })

  it('历史项目的 [decision-card] 旧行如实聚合导出，不补造', () => {
    const { projectId, sessionId, decisionsPath } = setup()
    // 模拟 T2 之前的历史会话：只有旧格式决策卡片行
    appendJsonLine(getAgentSessionPath(sessionId), {
      role: 'system',
      content: [{ type: 'text', text: '[decision-card] 记账本｜待办清单｜你帮我决定' }],
      timestamp: Date.now() - 60_000,
    })

    exportDecisionsMd(projectId)

    const markdown = readFileSync(decisionsPath(), 'utf8')
    expect(markdown).toContain('决策卡片（历史记录）')
    expect(markdown).toContain('记账本｜待办清单｜你帮我决定')
  })

  it('多条决策按时间升序聚合，无决策时如实说明不补造', () => {
    const { projectId, sessionId, decisionsPath } = setup()
    appendJsonLine(getAgentSessionPath(sessionId), {
      role: 'system',
      content: [{ type: 'text', text: '[decision-card] 旧卡片' }],
      timestamp: 1_000,
    })
    recordDecision({
      project_id: projectId,
      session_id: sessionId,
      entry: { type: 'judge_return', title: '裁判退回（第 1 次）', why: 'PRD 功能项与 GWT 场景未对齐' },
    })

    exportDecisionsMd(projectId)
    const markdown = readFileSync(decisionsPath(), 'utf8')
    const legacyIndex = markdown.indexOf('决策卡片（历史记录）')
    const judgeIndex = markdown.indexOf('裁判退回')
    expect(legacyIndex).toBeGreaterThan(0)
    expect(judgeIndex).toBeGreaterThan(legacyIndex)

    // 无任何决策的项目：导出空态说明，而不是报错
    const empty = createProject({ request_id: 'req-empty', mode: 'quick' })
    recordSessionActivity('session-empty', empty.project_id)
    exportDecisionsMd(empty.project_id)
    const emptyMd = readFileSync(
      join(getDocumentsDir(findProject(empty.project_id).workspace_slug, empty.project_id), 'decisions.md'),
      'utf8',
    )
    expect(emptyMd).toContain('暂无已落盘的决策条目')
  })
})

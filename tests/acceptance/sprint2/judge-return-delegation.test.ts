import { restorePromaHome } from '../../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runJudgeReview, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, findProject } from '../../../main/project-service'
import type { AgentEvent } from '../../../shared/types'

/**
 * Sprint 2 · S2-JUDGE-005 / S2-JUDGE-006 裁判退回让渡
 *
 * 文档依据：
 * - self-healing-judge.feature @S2-JUDGE-005：快消型 2 次退回后让渡给用户，生活化说明偏差
 * - self-healing-judge.feature @S2-JUDGE-006：长期迭代型 3 次退回后让渡给用户
 * - PRD §10.4 退回处理：第 1/2 次自动修复重试，达到上限后用户选择继续修复/接受现状/补充说明
 * - component-design §7 judge_return_count_quick=2 / judge_return_count_longterm=3
 */
describe('Sprint 2 judge return delegation acceptance (S2-JUDGE-005 / S2-JUDGE-006)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) {
      const { rmSync } = require('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    restorePromaHome(originalPromaHome)
    home = undefined
    setProgrammingEventPublisher(() => undefined)
  })

  function setup(prefix: string): string {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
    return home
  }

  /**
   * 构造一个裁判永远 return 的项目：无需求记录（PRD 硬约束失败）、
   * 无 GWT feature、无页面入口 → runJudge 恒 return。
   */
  function createFailingProject(mode: 'quick' | 'longterm'): string {
    const project = createProject({ request_id: `s2-${mode}`, mode })
    return project.project_id
  }

  it('[S2-JUDGE-005] 快消型 2 次退回后让渡给用户', async () => {
    setup('bloma-s2-delegate-quick-')
    const projectId = createFailingProject('quick')
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    const result = await runJudgeReview({ request_id: 's2-judge', session_id: 's2-session', project_id: projectId })

    // ① 达到退回上限后让渡：进入 blocked_for_user_decision
    expect(result.outcome).toBe('blocked')
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')

    // ② 快消型上限 2：允许 2 次修复重试（repairing ×2），第 3 次判定后让渡
    expect(events.filter((event) => event.type === 'repairing').length).toBe(2)
    expect(findProject(projectId).judge_return_count).toBe(3)

    // ③ user_decision_required：用户可选择继续修复/接受现状/补充说明
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision).toBeTruthy()
    const questions = decision?.payload.questions as Array<{ label: string }> | undefined
    expect(questions?.map((q) => q.label)).toEqual(
      expect.arrayContaining(['继续尝试', '接受现状', '补充说明']),
    )

    // ④ 用户可见文案生活化：不含技术术语/堆栈
    expect(JSON.stringify(events)).not.toMatch(/node_modules|Error: |at |hard constraint|TypeError|HTTP \d{3}/)
  })

  it('[S2-JUDGE-006] 长期迭代型 3 次退回后让渡给用户', async () => {
    setup('bloma-s2-delegate-longterm-')
    const projectId = createFailingProject('longterm')
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    const result = await runJudgeReview({ request_id: 's2-judge', session_id: 's2-session', project_id: projectId })

    // ① 长期型上限 3：允许 3 次修复重试（repairing ×3），第 4 次判定后让渡
    expect(result.outcome).toBe('blocked')
    expect(findProject(projectId).current_stage).toBe('blocked_for_user_decision')
    expect(events.filter((event) => event.type === 'repairing').length).toBe(3)
    expect(findProject(projectId).judge_return_count).toBe(4)

    // ② 同样提供用户决策选项
    const decision = events.find((event) => event.type === 'user_decision_required')
    expect(decision).toBeTruthy()
    const questions = decision?.payload.questions as Array<{ label: string }> | undefined
    expect(questions?.map((q) => q.label)).toEqual(
      expect.arrayContaining(['继续尝试', '接受现状', '补充说明']),
    )
  })
})

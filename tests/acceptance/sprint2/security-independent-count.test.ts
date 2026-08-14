import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runJudge } from '../../../main/judge-engine'
import { runJudgeReview, setProgrammingEventPublisher } from '../../../main/programming-orchestrator'
import { createProject, findProject } from '../../../main/project-service'
import type { AgentEvent } from '../../../shared/types'

/**
 * Sprint 2 · S2-JUDGE-007 / S2-JUDGE-008 安全问题独立计数
 *
 * 文档依据：
 * - self-healing-judge.feature @S2-JUDGE-007：安全问题不计入普通退回次数，使用独立计数器
 * - self-healing-judge.feature @S2-JUDGE-008：安全修复失败时用户文案不包含 XSS/SQL 注入等术语，
 *   说明现实风险和可选下一步
 * - PRD §10.5：安全问题的退回不计入普通退回次数，独立计数（上限 3 次强制修复）
 *
 * 接口现状：当前实现中 Project 无 security_repair_count 字段、RepairCategory 无 security 类别、
 * run_security_scan 仅存在于权限白名单表、无安全文案渲染函数。
 * 依据独立测试设计策略，本测试保留文档要求的期望行为；接口未给出处以契约缺口断言如实暴露 FAIL_PRODUCT。
 */
describe('Sprint 2 security independent count acceptance (S2-JUDGE-007 / S2-JUDGE-008)', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string | undefined

  afterEach(() => {
    if (home) {
      const { rmSync } = require('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    process.env.PROMA_HOME = originalPromaHome
    home = undefined
    setProgrammingEventPublisher(() => undefined)
  })

  function setup(prefix: string): void {
    home = mkdtempSync(join(tmpdir(), prefix))
    process.env.PROMA_HOME = home
  }

  /**
   * [S2-JUDGE-007] 契约缺口测试：安全问题应使用独立于普通退回的计数器
   *
   * 文档要求：安全问题不计入普通退回次数（PRD §10.5），需要独立计数接口。
   * 当前实现未提供该接口 —— 本断言如实暴露产品缺口（FAIL_PRODUCT）。
   */
  it('[S2-JUDGE-007] 契约：系统应暴露独立于普通退回的安全计数接口', async () => {
    setup('bloma-s2-sec-contract-')
    const projectId = createProject({ request_id: 's2-project', mode: 'quick' }).project_id
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    // ① 构造一个普通退回项目，确认 judge_return_count 可观测（既有接口）
    await runJudgeReview({ request_id: 's2-judge', session_id: 's2-session', project_id: projectId })
    expect(findProject(projectId).judge_return_count).toBeGreaterThan(0)

    // ② 文档要求：安全修复独立计数（PRD §10.5 上限 3 次强制修复，不计入普通退回）
    //    —— 接口缺失：Project 类型无 security_repair_count，RepairCategory 无 security 类别。
    //    此断言验证"存在独立安全计数接口"这一契约，当前 FAIL_PRODUCT。
    const project = findProject(projectId)
    expect(project).toHaveProperty('security_repair_count')

    // ③ 用户可见文案不得泄漏普通退回计数的内部字段（技术标识）
    expect(JSON.stringify(events)).not.toMatch(/judge_return_count|security_repair_count/)
  })

  it('[S2-JUDGE-008] 裁判/修复链路用户可见文案不包含 XSS/SQL 注入等安全术语', async () => {
    setup('bloma-s2-sec-copy-')
    const project = createProject({ request_id: 's2-project', mode: 'quick' })
    const events: AgentEvent[] = []
    setProgrammingEventPublisher((event) => events.push(event))

    // ① 触发裁判判定，收集所有用户可见摘要
    const verdict = runJudge({ project_id: project.project_id, mode: 'quick' })
    events.push({
      event_id: 'x',
      session_id: 's2-session',
      project_id: project.project_id,
      type: 'judge_result',
      payload: { user_visible_summary: verdict.user_visible_summary },
      created_at: new Date().toISOString(),
    })

    // ② 用户可见文案不包含技术术语（PRD §10 / api-spec §13 user_visible_message）
    const serialized = JSON.stringify(events) + verdict.user_visible_summary
    expect(serialized).not.toMatch(/\bXSS\b|SQL\s*注入|OWASP|安全扫描|硬约束|软约束|hard constraint|soft constraint/i)
    expect(serialized).not.toMatch(/node_modules|Error: |at |TypeError/)
  })
})

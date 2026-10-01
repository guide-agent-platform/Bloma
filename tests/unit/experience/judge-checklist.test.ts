import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildJudgeErrorPatternsSection } from '../../../main/experience/judge-checklist'
import { promoteToVerified, resetExperienceIndexForTests, tryRegisterCard } from '../../../main/experience/experience-service'
import type { RuleCardBody } from '../../../main/experience/types'

/**
 * T-6 裁判清单注入（W2.3 冻结 v1 后只认 v2 rule 卡；拍板 D2——无 verified 规则卡恒空）：
 * - buildJudgeErrorPatternsSection：verified rule → 【常见错法】段
 * - 空账本 / 开关 off → 空串（调用方 filter(Boolean) 保证字节级等价——关键回归锁）
 * - 段含 tag/failure_mode/审查关注（动作+验证）；预算收缩条数
 */

function body(failure: string, actions: string[]): RuleCardBody {
  return {
    rule_kind: 'execution_rule',
    applies_when: { stage: 'coding' },
    failure_mode: failure,
    recommended_actions: actions,
    verification: { check: '终验通过' },
    causal_status: 'hypothesis',
    rev: 1,
  }
}

const originalHome = process.env.PROMA_HOME
beforeEach(() => {
  process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'proma-jcl-'))
  resetExperienceIndexForTests()
})
afterEach(() => {
  process.env.PROMA_HOME = originalHome
  resetExperienceIndexForTests()
})

describe('judge-checklist：审查指导注入段', () => {
  it('空账本 → 空串（回归锁：无 verified 卡不产段）', async () => {
    expect(await buildJudgeErrorPatternsSection('p1')).toBe('')
  })

  it('candidate（未 verified）不注入；verified 产【常见错法】段含审查关注', async () => {
    const cand = await tryRegisterCard({
      kind: 'rule',
      tag: 'coding/gwt/save_missing',
      body: body('GWT 场景「F-001 当提交时，应保存记录」未通过：无保存', ['检查提交事件绑定']),
      source: { type: 'gwt_failure', project_hash: 'p1', timestamp: Date.now() },
    })
    // 尚为 candidate（recurrence=1）→ 不可消费
    expect(await buildJudgeErrorPatternsSection('p1')).toBe('')
    await promoteToVerified(cand!.id, 'replay_green')
    const section = await buildJudgeErrorPatternsSection('p1')
    expect(section).toContain('【常见错法】')
    expect(section).toContain('coding/gwt/save_missing')
    expect(section).toContain('检查提交事件绑定')
  })

  it('预算极小时段仍产但收缩条数（不腰斩格式头）', async () => {
    for (let i = 0; i < 5; i++) {
      const c = await tryRegisterCard({
        kind: 'rule',
        tag: `coding/gwt/u${i}`,
        body: body(`错误症状 ${i} ${'详'.repeat(200)}`, [`关注点 ${i}`]),
        source: { type: 'gwt_failure', project_hash: 'p1', timestamp: Date.now() },
      })
      await promoteToVerified(c!.id, 'replay_green')
    }
    const section = await buildJudgeErrorPatternsSection('p1', { budget_chars: 300 })
    expect(section.startsWith('【常见错法】')).toBe(true)
    // 300 预算装不下 5 条 200 字症状 → 条数 < 5
    expect((section.match(/^- /gm) ?? []).length).toBeLessThan(5)
    expect((section.match(/^- /gm) ?? []).length).toBeGreaterThan(0)
  })
})

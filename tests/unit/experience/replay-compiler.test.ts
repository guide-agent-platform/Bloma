import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fp8,
  replayAssertionText,
  replayRequirements,
  splitAdvisoryResults,
  syncReplayFeatureFiles,
} from '../../../main/experience/replay-compiler'
import {
  readAllCards,
  resetExperienceIndexForTests,
  tryRegisterCard,
  promoteToVerified,
  reportReplayOutcomes,
} from '../../../main/experience/experience-service'
import type { AntiPatternBody, ExperienceCard } from '../../../main/experience/types'
import type { GwtTestResult } from '../../../main/verification/test-legacy'

/**
 * T-5 错误重放断言：verified/达阈 anti_pattern 编译为 R-{fp8} 建议性场景——
 * 走真实执行器但**结果从 gated 计数剔除**（指导测试而不碰交付门禁），
 * 回流状态机：candidate 过 → promote replay_green；verified 过 → matched；
 * verified 败 → false_positive（防误伤，不自动退役）；feature 文件双目录分写。
 */

function body(symptom: string, gwt?: AntiPatternBody['gwt']): AntiPatternBody {
  return {
    stage: 'coding',
    symptom,
    trigger_condition: 't',
    root_cause: { stage: 'coding', description: 'd', method: 'rule', confidence: 1 },
    gwt,
    test_checklist: [],
    review_checklist: [],
    severity: 2,
  }
}

async function seedCard(tag: string, symptom: string, gwt?: AntiPatternBody['gwt']) {
  return await tryRegisterCard({
    kind: 'anti_pattern',
    tag,
    body: body(symptom, gwt),
    source: { type: 'gwt_failure', project_hash: 'p1', timestamp: Date.now() },
  })
}

let home: string
const originalHome = process.env.PROMA_HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'proma-replay-'))
  process.env.PROMA_HOME = home
  process.env.BLOMA_EXPERIENCE = '1'
  resetExperienceIndexForTests()
})
afterEach(() => {
  process.env.PROMA_HOME = originalHome
  delete process.env.BLOMA_EXPERIENCE
  resetExperienceIndexForTests()
})

describe('replay-compiler：断言编译', () => {
  it('body.gwt 优先 → 「…时应…」句式', () => {
    const card = { kind: 'anti_pattern', body: body('x', { given: '已加载', when: '输入关键词', then: '列表过滤' }) } as ExperienceCard
    expect(replayAssertionText(card)).toBe('已加载，输入关键词时应列表过滤')
  })

  it('无 gwt 时从 GWT 症状原文提取原断言（重验同一断言最高保真）', () => {
    const card = { kind: 'anti_pattern', body: body('GWT 场景「F-005 当点击删除时，应出现确认弹窗」未通过：无确认') } as ExperienceCard
    expect(replayAssertionText(card)).toBe('当点击删除时，应出现确认弹窗')
  })

  it('不可编译（结局卡无断言原文）→ null', () => {
    expect(replayAssertionText({ kind: 'anti_pattern', body: body('异常结局（timeout）：Loop 结束') } as ExperienceCard)).toBeNull()
  })

  it('fp8 稳定前缀', () => {
    expect(fp8('abcdef1234567890')).toBe('abcdef12')
  })
})

describe('replay-compiler：advisory 计数剥离', () => {
  it('R- 失败/通过都从 gated 三计数中剔除，failure_summary/unverified 只剩业务场景', () => {
    const raw: GwtTestResult = {
      total_count: 5,
      passed_count: 3,
      failed_count: 2,
      failure_summary: [
        { scenario: 'F-001 当提交时应保存', reason: '业务失败' },
        { scenario: `R-${'aaaabb12'} 当点击删除时，应出现确认弹窗`, reason: '复发' },
      ],
      unverified: ['F-009 图表'],
    }
    const replayIds = new Set([`R-aaaabb12 当点击删除时，应出现确认弹窗`])
    const { gated, outcomes } = splitAdvisoryResults(raw, replayIds)
    expect(gated.total_count).toBe(4)
    expect(gated.failed_count).toBe(1)
    expect(gated.failure_summary).toHaveLength(1)
    expect(gated.failure_summary[0].scenario).toContain('F-001')
    expect(outcomes).toEqual([{ id: 'aaaabb12', passed: false }])
  })
})

describe('replay-compiler：回流状态机 + feature 双目录', () => {
  it('candidate 过→promote replay_green；verified 过→matched；verified 败→false_positive', async () => {
    const cand = await seedCard('coding/gwt/c', 'GWT 场景「F-002 当输入时，应实时校验」未通过：x')
    const ver = await seedCard('coding/gwt/v', 'GWT 场景「F-003 当悬停时，应显示提示」未通过：x')
    await promoteToVerified(ver!.id, 'replay_green')
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    await reportReplayOutcomes([
      { id: fp8(cand!.fingerprint), passed: true },
      { id: fp8(ver!.fingerprint), passed: true },
    ])
    await reportReplayOutcomes([{ id: fp8(ver!.fingerprint), passed: false }])
    warnSpy.mockRestore()
    const cards = readAllCards()
    const c = cards.find((x) => x.id === cand!.id)!
    const v = cards.find((x) => x.id === ver!.id)!
    expect(c.status).toBe('verified')
    expect(c.kind === 'anti_pattern' && c.verified_by).toBe('replay_green')
    expect(v.stats).toMatchObject({ times_matched: 1, false_positive_count: 1 })
  })

  it('feature 文件：verified 进 features/、其余可编译 candidate 进 features-candidates/（业务清单不受影响）', async () => {
    const { getDocumentsDir } = await import('../../../storage/config-paths')
    const { createProject } = await import('../../../main/project/project-service')
    const project = createProject({ request_id: 'req-replay', mode: 'quick' })
    const v = await seedCard('coding/gwt/f1', 'GWT 场景「F-001 当提交时，应保存记录」未通过：x')
    await promoteToVerified(v!.id, 'replay_green')
    const c1 = await seedCard('coding/gwt/f2', 'GWT 场景「F-002 当删除时，应二次确认」未通过：y') // r=1 candidate 也进候选目录（advisory 资格=非 retired 可编译）
    const docsDir = getDocumentsDir(project.workspace_slug, project.project_id)
    syncReplayFeatureFiles(project.project_id, docsDir)
    const feat = readdirSync(join(docsDir, 'features')).filter((f) => f.startsWith('replay-'))
    const candDir = join(docsDir, 'features-candidates')
    expect(feat).toHaveLength(1)
    expect(feat[0]).toContain('replay-')
    expect(existsSync(join(candDir, `replay-${fp8(c1!.fingerprint)}.feature`))).toBe(true)
    expect(readFileSync(join(docsDir, 'features', feat[0]), 'utf8')).toContain('Scenario:')
  })
})


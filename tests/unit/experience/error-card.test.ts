import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  buildCardFromAbnormalOutcome,
  buildCardFromBuildGateFailure,
  buildCardFromJudgeReturn,
  buildCardFromSemanticFindings,
  buildCardsFromGwtTestResult,
  recordFailureCards,
} from '../../../main/experience/error-card'
import type { ExperienceCard } from '../../../main/experience/types'
import type { GwtTestResult } from '../../../main/gwt-service'
import type { JudgeVerdict } from '../../../main/review/judge-engine'

/**
 * T-1 错误卡采集层：
 * - 4+2 组装器纯函数（无 I/O；candidate/status/schema_version/fingerprint 形状）
 * - 同输入 fingerprint 稳定、id 唯一；空 findings → null；build passed → null
 * - recordFailureCards 门面：批量注册 + learnings 镜像 + 任何脏输入绝不抛
 */

vi.mock('../../../main/experience/experience-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../main/experience/experience-service')>()
  return { ...actual, registerCandidateCard: vi.fn(async (card: ExperienceCard) => card) }
})
vi.mock('../../../main/learnings-log', () => ({
  appendProjectLearning: vi.fn(() => null),
}))

import { registerCandidateCard } from '../../../main/experience/experience-service'
import { appendProjectLearning } from '../../../main/learnings-log'

const ctx = { projectId: 'proj-1', sessionId: 'sess-1' }

function gwt(n = 1): GwtTestResult {
  return {
    total_count: 2,
    passed_count: 1,
    failed_count: n,
    failure_summary: Array.from({ length: n }, (_, i) => ({
      scenario: `F-00${i} 当在搜索框输入关键词时，历史列表应显示匹配项 ${i}`,
      reason: `断言未通过——触发状态 capture-input 未命中 ${i}`,
    })),
  }
}

const originalExp = process.env.BLOMA_EXPERIENCE
beforeEach(() => {
  // 门面已加 C-2 门控（off=零副作用）：spy 断言需要开关开；mock 保证不写真账本
  process.env.BLOMA_EXPERIENCE = '1'
  vi.mocked(registerCandidateCard).mockClear()
  vi.mocked(appendProjectLearning).mockClear()
})
afterEach(() => {
  if (originalExp === undefined) delete process.env.BLOMA_EXPERIENCE
  else process.env.BLOMA_EXPERIENCE = originalExp
})

describe('error-card：GWT 组装器', () => {
  it('每失败场景一张卡：candidate/anti_pattern/tag 命名空间/指纹稳定/id 唯一', () => {
    const a = buildCardsFromGwtTestResult(gwt(2), ctx)
    const b = buildCardsFromGwtTestResult(gwt(2), ctx)
    expect(a).toHaveLength(2)
    expect(a.every((c) => c.kind === 'anti_pattern' && c.status === 'candidate' && c.schema_version === 1)).toBe(true)
    expect(a.map((c) => c.id)).not.toEqual(b.map((c) => c.id))
    expect(a.map((c) => c.fingerprint)).toEqual(b.map((c) => c.fingerprint))
    expect(a[0].tag.startsWith('coding/gwt/')).toBe(true)
    expect(a[0].source.type).toBe('gwt_failure')
    expect(a[0].source.project_hash).toMatch(/^[0-9a-f]{12}$/)
  })

  it('超过 maxCards 截断（防账本爆炸）', () => {
    expect(buildCardsFromGwtTestResult(gwt(9), ctx)).toHaveLength(5)
    expect(buildCardsFromGwtTestResult(gwt(9), { ...ctx, maxCards: 3 })).toHaveLength(3)
  })
})

describe('error-card：build-gate / semantic / abnormal / judge 组装器', () => {
  it('build passed/skipped → null；failed → build_gate 卡 severity 3', () => {
    expect(buildCardFromBuildGateFailure({ status: 'passed', durationMs: 1 }, ctx)).toBeNull()
    expect(buildCardFromBuildGateFailure({ status: 'skipped', durationMs: 1 }, ctx)).toBeNull()
    const card = buildCardFromBuildGateFailure({ status: 'failed', detail: 'Could not resolve "./missin"', durationMs: 2 }, ctx)
    expect(card?.tag.startsWith('build_gate/bundle/')).toBe(true)
    expect(card?.kind === 'anti_pattern' && card.body.severity).toBe(3)
  })

  it('findings 空 → null；含 missing → severity 3；checklist 逐条', () => {
    expect(
      buildCardFromSemanticFindings({ findings: [], stage: 'coding', projectHash: 'p' }),
    ).toBeNull()
    const card = buildCardFromSemanticFindings({
      findings: [
        { requirement_id: 'F-001', status: 'missing', evidence: '无保存按钮' },
        { requirement_id: 'F-002', status: 'partial', evidence: '列表未渲染' },
        { requirement_id: 'F-003', status: 'deviated', evidence: '删除无确认' },
      ],
      stage: 'coding',
      projectHash: 'p',
    })
    expect(card?.kind === 'anti_pattern' && card.body.test_checklist).toHaveLength(3)
    expect(card?.kind === 'anti_pattern' && card.body.severity).toBe(3)
  })

  it('abnormal：timeout severity 1 stage unknown；unexpected_exit severity 3', () => {
    const t = buildCardFromAbnormalOutcome({ outcomeType: 'timeout', description: 'turn_limit', projectHash: 'p' })
    expect(t.kind === 'anti_pattern' && t.body.stage).toBe('unknown')
    expect(t.kind === 'anti_pattern' && t.body.severity).toBe(1)
    const u = buildCardFromAbnormalOutcome({ outcomeType: 'unexpected_exit', description: '预算耗尽', projectHash: 'p' })
    expect(u.kind === 'anti_pattern' && u.body.severity).toBe(3)
    expect(u.source.type).toBe('abnormal_outcome')
  })

  it('judge return 卡：failed 硬约束进 test_checklist，suggest 不进（门面过滤）', () => {
    const verdict: JudgeVerdict = {
      verdict: 'return',
      hard_constraints: [
        { name: 'gwt_all_pass', passed: false, detail: '1/8 未过' },
        { name: 'security_scan', passed: true, detail: '' },
      ],
      soft_constraints: [],
      user_visible_summary: '有 1 个 P0 场景未通过',
      repairable: false,
    }
    const card = buildCardFromJudgeReturn(verdict, ctx)
    expect(card.tag.startsWith('coding/judge/')).toBe(true)
    expect(card.kind === 'anti_pattern' && card.body.test_checklist.join()).toContain('gwt_all_pass')
  })
})

describe('error-card：recordFailureCards 门面', () => {
  it('C-2 契约：BLOMA_EXPERIENCE off = 零副作用（不注册、不镜像）', () => {
    delete process.env.BLOMA_EXPERIENCE
    recordFailureCards(ctx, { testResult: gwt(2) })
    expect(registerCandidateCard).not.toHaveBeenCalled()
    expect(appendProjectLearning).not.toHaveBeenCalled()
    process.env.BLOMA_EXPERIENCE = '1' // 还原给后续用例（beforeEach 也会重设）
  })

  it('批量注册 + learnings 镜像 error_pattern', async () => {
    recordFailureCards(ctx, { testResult: gwt(2), abnormal: { outcomeType: 'timeout', description: 'turn_limit' } })
    await new Promise((r) => setImmediate(r))
    expect(vi.mocked(registerCandidateCard)).toHaveBeenCalledTimes(3)
    const mirror = vi.mocked(appendProjectLearning).mock.calls.filter(([, entry]) => entry.kind === 'error_pattern')
    expect(mirror.length).toBeGreaterThanOrEqual(1)
    expect(String(mirror[0][1].text)).toContain('规避：')
  })

  it('脏输入绝不抛（增强不是依赖）', () => {
    expect(() => recordFailureCards(ctx, { testResult: {} as GwtTestResult, buildGate: undefined })).not.toThrow()
    expect(() => recordFailureCards({} as never, { testResult: gwt(1) })).not.toThrow()
  })
})

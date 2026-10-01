import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { recordFailureCards, KNOWN_NEGATIVE_SEEDS, buildKnownNegativeSeedCards } from '../../../main/experience/error-card'
import type { GwtTestResult } from '../../../main/verification/test-legacy'
import type { JudgeVerdict } from '../../../main/review/judge-engine'

/**
 * F 系列 W2.1（2026-09-16 Phase 10 承接）：采集层改为 v2 事件行——observations 只记
 * 事实不产卡不归因；root_cause 停写。负经验种子通道（人工登记）保留原覆盖。
 */
vi.mock('../../../main/experience/event-log', () => ({
  appendExperienceEvent: vi.fn(() => null),
}))

import { appendExperienceEvent } from '../../../main/experience/event-log'
import type { AppendEventInput } from '../../../main/experience/event-log'

const ctx = { projectId: 'proj-1', sessionId: 'sess-1' }

function gwt(n = 1): GwtTestResult {
  return {
    total_count: 2,
    passed_count: 1,
    failed_count: n,
    failure_summary: Array.from({ length: n }, (_, i) => ({
      scenario: `F-00${i} 场景 ${i}`,
      reason: `断言未命中 ${i}`,
    })),
  }
}

const originalExp = process.env.BLOMA_EXPERIENCE
beforeEach(() => {
  process.env.BLOMA_EXPERIENCE = '1'
  vi.mocked(appendExperienceEvent).mockClear()
})
afterEach(() => {
  if (originalExp === undefined) delete process.env.BLOMA_EXPERIENCE
  else process.env.BLOMA_EXPERIENCE = originalExp
})

function eventTypes(): string[] {
  return vi.mocked(appendExperienceEvent).mock.calls.map((c) => (c[0] as AppendEventInput).eventType)
}
function observationsOf(type: string): string[] {
  const call = vi.mocked(appendExperienceEvent).mock.calls.map((c) => c[0] as AppendEventInput).find((i) => i.eventType === type)
  return call?.observations ?? []
}

describe('error-card：事件行采集（W2.1）', () => {

  it('GWT 失败 → gwt_failure 事件：计数行+场景事实行；evidence 含 test-report', () => {
    recordFailureCards(ctx, { testResult: gwt(2) })
    expect(eventTypes()).toEqual(['gwt_failure'])
    const obs = observationsOf('gwt_failure')
    expect(obs[0]).toBe('failed 2/2')
    expect(obs[1]).toContain('F-000 场景 0：断言未命中 0')
    const call = vi.mocked(appendExperienceEvent).mock.calls[0][0] as AppendEventInput
    expect(call.evidenceRefs).toContain('documents/test-report.json')
    expect(call.runId).toBe('sess-1')
  })

  it('GWT 全过/缺省 → 无事件（健康路径零写入）', () => {
    recordFailureCards(ctx, { testResult: { total_count: 2, passed_count: 2, failed_count: 0, failure_summary: [] } })
    recordFailureCards(ctx, {})
    expect(eventTypes()).toEqual([])
  })


  it('脏输入绝不抛错（采集是增强不是依赖）', () => {
    expect(() =>
      recordFailureCards(ctx, {
        testResult: undefined,
        judgeVerdict: { verdict: 'return' } as unknown as JudgeVerdict,
        abnormal: { outcomeType: 'timeout', description: '' },
      }),
    ).not.toThrow()
  })
})

describe('负经验种子通道（人工登记，保留原语义）', () => {
  it('四条种子 + 卡形状（negative/ 标签、candidate、指纹非空）', () => {
    expect(KNOWN_NEGATIVE_SEEDS).toHaveLength(4)
    const cards = buildKnownNegativeSeedCards('hash-1')
    expect(cards).toHaveLength(4)
    for (const card of cards) {
      expect(card.tag.startsWith('negative/seed-')).toBe(true)
      expect(card.status).toBe('candidate')
      expect(card.fingerprint.length).toBeGreaterThan(0)
    }
  })
})


import { describe, expect, it } from 'vitest'
import {
  assertReviewFamilyDiversity,
  channelFamilyOf,
} from '../../main/platform/llm/channel-family'

/**
 * C2 渠道家族判定与审查独立性断言单测（协作机制改造清单，2026-09-24）。
 *
 * 锁定：
 * - 同厂商多接入归一（zhipu/zhipu-coding/zhipu-coding-team → zhipu；kimi 两形态 → moonshot）
 * - 中转聚合类保守独立（anthropic-compatible ≠ anthropic）
 * - 未知/缺失 provider 以渠道 ID 成独立族
 * - 断言：同族抛错（文案含双方渠道与改法指引）/ 异族通过 / 无作者对照不拦
 */

describe('channelFamilyOf', () => {
  it('同厂商多接入形态归一为同一厂商族', () => {
    expect(channelFamilyOf({ id: 'a', provider_type: 'zhipu' })).toBe('zhipu')
    expect(channelFamilyOf({ id: 'b', provider_type: 'zhipu-coding' })).toBe('zhipu')
    expect(channelFamilyOf({ id: 'c', provider_type: 'zhipu-coding-team' })).toBe('zhipu')
    expect(channelFamilyOf({ id: 'd', provider_type: 'kimi-api' })).toBe('moonshot')
    expect(channelFamilyOf({ id: 'e', provider_type: 'kimi-coding' })).toBe('moonshot')
    expect(channelFamilyOf({ id: 'f', provider_type: 'openai-responses' })).toBe('openai')
  })

  it('中转聚合类保守独立成族（anthropic-compatible ≠ anthropic）', () => {
    expect(channelFamilyOf({ id: 'a', provider_type: 'anthropic' })).toBe('anthropic')
    expect(channelFamilyOf({ id: 'b', provider_type: 'anthropic-compatible' })).toBe('anthropic-compatible')
    expect(channelFamilyOf({ id: 'c', provider_type: 'opencode-go-openai' })).toBe('opencode')
    expect(channelFamilyOf({ id: 'd', provider_type: 'ark-coding-plan' })).toBe('ark')
  })

  it('未知 provider 按字面值成族；缺失 provider 以渠道 ID 成独立族', () => {
    expect(channelFamilyOf({ id: 'a', provider_type: 'some-new-vendor' })).toBe('some-new-vendor')
    expect(channelFamilyOf({ id: 'uuid-channel-x', provider_type: undefined })).toBe('uuid-channel-x')
    expect(channelFamilyOf({ id: 'uuid-channel-x', provider_type: '' })).toBe('uuid-channel-x')
    expect(channelFamilyOf(undefined)).toBe('(none)')
  })
})

describe('assertReviewFamilyDiversity', () => {
  const deepseekChannel = { id: 'ds-main', provider_type: 'deepseek' as const }
  const glmCodingChannel = { id: 'glm-coding', provider_type: 'zhipu-coding' as const }
  const glmDirectChannel = { id: 'glm-direct', provider_type: 'zhipu' as const }

  it('同族（含同厂商不同接入形态）抛错，文案含双方渠道与改法指引', () => {
    expect(() =>
      assertReviewFamilyDiversity({ authorChannel: glmDirectChannel, reviewerChannel: glmCodingChannel }),
    ).toThrow(/同一家族/)
    expect(() =>
      assertReviewFamilyDiversity({ authorChannel: glmDirectChannel, reviewerChannel: glmCodingChannel }),
    ).toThrow(/glm-direct\[zhipu\]/)
    expect(() =>
      assertReviewFamilyDiversity({ authorChannel: glmDirectChannel, reviewerChannel: glmCodingChannel }),
    ).toThrow(/glm-coding\[zhipu-coding\]/)
  })

  it('异族通过；context 说明写入文案', () => {
    expect(() =>
      assertReviewFamilyDiversity({
        authorChannel: deepseekChannel,
        reviewerChannel: glmCodingChannel,
        context: '语义审查',
      }),
    ).not.toThrow()
    try {
      assertReviewFamilyDiversity({
        authorChannel: deepseekChannel,
        reviewerChannel: { id: 'ds-2', provider_type: 'deepseek' },
        context: '攻防审查',
      })
      expect.unreachable('同族应抛错')
    } catch (error) {
      expect((error as Error).message).toContain('攻防审查')
    }
  })

  it('作者缺省（无对照的单审查场景）不拦', () => {
    expect(() =>
      assertReviewFamilyDiversity({ reviewerChannel: glmDirectChannel }),
    ).not.toThrow()
  })

  it('未知 provider 渠道视为独立家族，与字面家族互异', () => {
    expect(() =>
      assertReviewFamilyDiversity({
        authorChannel: { id: 'uuid-x', provider_type: undefined },
        reviewerChannel: deepseekChannel,
      }),
    ).not.toThrow()
  })
})

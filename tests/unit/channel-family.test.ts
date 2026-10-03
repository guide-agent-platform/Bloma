import { describe, expect, it } from 'vitest'
import { channelFamilyOf } from '../../main/platform/llm/channel-family'

/**
 * C2 渠道家族判定与审查独立性断言单测（协作机制改造清单，2026-09-24）。
 *
 * 锁定：
 * - 同厂商多接入归一（zhipu/zhipu-coding/zhipu-coding-team → zhipu；kimi 两形态 → moonshot）
 * - 中转聚合类保守独立（anthropic-compatible ≠ anthropic）
 * - 未知/缺失 provider 以渠道 ID 成独立族
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

// （assertReviewFamilyDiversity 4 例随生产清尸删除，2026-10-03 删留执行：
//  该断言生产零调用——adversarial-review.ts:67 用 channelFamilyOf 自行比较。）

import { describe, expect, it } from 'vitest'
import {
  buildThinkingFragment,
  resolveProfile,
  THINKING_OMIT_PROVIDERS,
  type ThinkingLevel,
} from '../../shared/reasoning-profile'

/**
 * S4-REASON-001~013：推理档位管理移植（enhancements/reasoning-profile-port.md P1，
 * 蓝本 Proma v0.18.2 reasoning-profile.ts + thinking-capability.ts）。
 *
 * 零回归契约：level 缺省 + 模型未识别 + providerType 不在 omit 黑名单 →
 * 输出与现状逐字节一致（thinking:{type:'disabled'}）。
 */
describe('reasoning-profile（推理档位移植）', () => {
  it('deepseek-flash preserves the requested low thinking effort', () => {
    expect(buildThinkingFragment('deepseek-flash', 'deepseek', 'low')).toEqual(buildThinkingFragment('deepseek-v4-flash', 'deepseek', 'low'))
  })
  it('[S4-REASON-001] resolve deepseek-v4-flash 含 -latest 后缀', () => {
    expect(resolveProfile('deepseek-v4-flash-latest')?.id).toBe('deepseek-v4-flash')
  })

  it('[S4-REASON-002] resolve glm-5.3', () => {
    expect(resolveProfile('glm-5.3')?.id).toBe('glm-5.3')
  })

  it('[S4-REASON-003] resolve 大小写不敏感', () => {
    expect(resolveProfile('GLM-5.3')?.id).toBe('glm-5.3')
  })

  it('[S4-REASON-004] resolve 未知模型 → undefined（走现状兜底）', () => {
    expect(resolveProfile('claude-sonnet-4-5')).toBeUndefined()
  })

  it('[S4-REASON-005] DS4-flash max → enabled + output_config.effort=max', () => {
    const f = buildThinkingFragment('deepseek-v4-flash', 'deepseek', 'max')
    expect(f).toEqual({ thinking: { type: 'enabled' }, output_config: { effort: 'max' }, omit: false })
  })

  it('[S4-REASON-006] DS4-flash off → 显式 disabled（v4 硬要求）', () => {
    const f = buildThinkingFragment('deepseek-v4-flash', 'deepseek', 'off')
    expect(f).toEqual({ thinking: { type: 'disabled' }, omit: false })
  })

  it('[S4-REASON-007] DS4-pro low → effort=high（Pro 档位差）', () => {
    const f = buildThinkingFragment('deepseek-v4-pro', 'deepseek', 'low')
    expect(f.output_config?.effort).toBe('high')
  })

  it('[S4-REASON-008] GLM-5.3 + zhipu-coding → 不再 omit：off 档 disabled 生效（2026-10-09 anthropic 端点实测反转）', () => {
    // 2026-10-09 probe-glm.cjs / probe-glm-stream.cjs 实测：open.bigmodel.cn/api/anthropic
    // 接受 disabled（非流式 blocks=[text] 无思考；流式 thinking_delta=0）。旧断言
    // 「omit=true」是零正文根因——默认思考吃光小预算（狗粮 800/791 实锤）。
    const off = buildThinkingFragment('glm-5.3', 'zhipu-coding', 'off')
    expect(off).toEqual({ thinking: { type: 'disabled' }, omit: false })
    const max = buildThinkingFragment('glm-5.3', 'zhipu-coding', 'max')
    expect(max.omit).toBe(false)
    expect(max.thinking).toEqual({ type: 'enabled' })
    expect(max.output_config?.effort).toBe('max')
  })

  it('[S4-REASON-008b] GLM-5.3 + zhipu-coding-team → 仍 omit（同域端点未实测，保守保留）', () => {
    const f = buildThinkingFragment('glm-5.3', 'zhipu-coding-team', 'max')
    expect(f.omit).toBe(true)
  })

  it('[S4-REASON-009] GLM-5.3 + anthropic-compatible + off → disabled（补充 off 档，零回归契约对全模型成立）', () => {
    const f = buildThinkingFragment('glm-5.3', 'anthropic-compatible', 'off')
    expect(f).toEqual({ thinking: { type: 'disabled' }, omit: false })
  })

  it('[S4-REASON-009b] GLM-5.3 + anthropic-compatible + low → enabled + effort=low（显式思考档）', () => {
    const f = buildThinkingFragment('glm-5.3', 'anthropic-compatible', 'low')
    expect(f.thinking?.type).toBe('enabled')
    expect(f.output_config?.effort).toBe('low')
  })

  it('[S4-REASON-010] GLM-5.3 + anthropic-compatible 未传 level → 默认 max', () => {
    const f = buildThinkingFragment('glm-5.3', 'anthropic-compatible', undefined)
    expect(f.output_config?.effort).toBe('max')
  })

  it('[S4-REASON-011] Token Plan 渠道 → omit（发 disabled 都会 400）', () => {
    const f = buildThinkingFragment('qwen3.8-max-preview', 'qwen-token-plan', 'max')
    expect(f.omit).toBe(true)
    expect(f.thinking).toBeUndefined()
  })

  it('[S4-REASON-012] minimax 渠道不 omit：2026-08-16 事故证据证明 Bloma 的 MiniMax 接受且需要显式 disabled（审查 P1-①）', () => {
    const f = buildThinkingFragment('minimax-m3', 'minimax', undefined)
    expect(f.omit).toBe(false)
    expect(f.thinking).toEqual({ type: 'disabled' })
  })

  it('[S4-REASON-013] Claude 未知 providerType → disabled 不 omit（零回归契约）', () => {
    const f = buildThinkingFragment('claude-sonnet-4-5', 'anthropic', 'high')
    expect(f).toEqual({ thinking: { type: 'disabled' }, omit: false })
  })

  it('[S4-REASON-014] omit 黑名单含 6 家渠道（2026-10-09 zhipu-coding 移出：anthropic 端点实测接受 disabled；minimax 除外——Bloma 事故证据）', () => {
    for (const p of [
      'kimi-api', 'kimi-coding', 'zhipu-coding-team',
      'ark-coding-plan', 'qwen-token-plan', 'xiaomi-token-plan',
    ]) {
      expect(THINKING_OMIT_PROVIDERS.has(p)).toBe(true)
    }
    expect(THINKING_OMIT_PROVIDERS.has('zhipu-coding')).toBe(false)
    expect(THINKING_OMIT_PROVIDERS.has('minimax')).toBe(false)
  })

  it('[S4-REASON-015] kimi-k3 profile 可解析', () => {
    expect(resolveProfile('kimi-k3')?.id).toBe('kimi-k3')
    expect(resolveProfile('k3')?.id).toBe('kimi-k3')
  })

})

import { describe, it, expect, afterEach } from 'vitest'
import {
  visionAuditEnabled, deriveChatBaseUrl, resolveVisionPair, buildV2Prompt, digestVisionReport,
  type ChannelLike,
} from '../../../main/coding/vision-audit-gate'

/**
 * L1 双视觉审计门禁——纯函数单测。模型对固定：V1=deepseek-v4-flash-vision-exp / V2=qwen-vl-max
 * （用户 2026-09-06 指定：仅此两渠道有余额）。
 */

const DS: ChannelLike = {
  id: 'ch-ds', name: 'ds', base_url: 'https://api.deepseek.com/anthropic',
  api_key: 'hex-ds', models: [{ id: 'deepseek-v4-flash', enabled: true }, { id: 'deepseek-v4-flash-vision-exp', enabled: true }],
  enabled: true,
}
const ALI: ChannelLike = {
  id: 'ch-ali', name: '阿里云云工', base_url: 'https://ws-x.demo.aliyuncs.com/compatible-mode/v1',
  api_key: 'hex-ali', models: [{ id: 'qwen-vl-max', enabled: true }], enabled: true,
}
const decrypt = (hex: string) => `plain(${hex})`

describe('visionAuditEnabled（紧急逃生门，缺省开）', () => {
  const saved = process.env.BLOMA_VISION_AUDIT
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOMA_VISION_AUDIT
    else process.env.BLOMA_VISION_AUDIT = saved
  })
  it('未设置 → 启用', () => {
    delete process.env.BLOMA_VISION_AUDIT
    expect(visionAuditEnabled()).toBe(true)
  })
  it("'0' → 停用", () => {
    process.env.BLOMA_VISION_AUDIT = '0'
    expect(visionAuditEnabled()).toBe(false)
  })
})

describe('deriveChatBaseUrl', () => {
  it('ds anthropic 地址 → 根域 chat 端点', () => {
    expect(deriveChatBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com')
  })
  it('compatible-mode/v1 原样保留', () => {
    expect(deriveChatBaseUrl('https://ws-x.demo.aliyuncs.com/compatible-mode/v1')).toBe('https://ws-x.demo.aliyuncs.com/compatible-mode/v1')
  })
  it('尾斜杠归一', () => {
    expect(deriveChatBaseUrl('https://api.deepseek.com/anthropic/')).toBe('https://api.deepseek.com')
  })
})

describe('resolveVisionPair（从渠道表挑 V1/V2，密钥经注入的解密函数出明文）', () => {
  it('两模型齐备 → V1=ds、V2=qwen', () => {
    const pair = resolveVisionPair([DS, ALI], decrypt)
    expect(pair).not.toBeNull()
    expect(pair!.v1.model).toBe('deepseek-v4-flash-vision-exp')
    expect(pair!.v1.chatBase).toBe('https://api.deepseek.com')
    expect(pair!.v1.apiKey).toBe('plain(hex-ds)')
    expect(pair!.v2.model).toBe('qwen-vl-max')
    expect(pair!.v2.apiKey).toBe('plain(hex-ali)')
  })
  it('缺任一模型 → null（上层落 unavailable，绝不静默假通过）', () => {
    expect(resolveVisionPair([DS], decrypt)).toBeNull()
    expect(resolveVisionPair([ALI], decrypt)).toBeNull()
  })
  it('禁用渠道不参与挑选', () => {
    expect(resolveVisionPair([{ ...DS, enabled: false }, ALI], decrypt)).toBeNull()
  })
  it('models 字符串形态兼容', () => {
    const str: ChannelLike = { ...ALI, models: ['qwen-vl-max'] as never }
    expect(resolveVisionPair([DS, str], decrypt)?.v2.model).toBe('qwen-vl-max')
  })
  it('seed 变体名（前后缀污染）子串兼容命中', () => {
    const mangled: ChannelLike = { ...DS, models: [{ id: 'deepseek-deepseek-v4-flash-vision-exp-1', enabled: true }] }
    expect(resolveVisionPair([mangled, ALI], decrypt)?.v1.model).toBe('deepseek-v4-flash-vision-exp')
  })
})

describe('buildV2Prompt', () => {
  it('V1 报告全文内嵌（互证依赖）', () => {
    const p = buildV2Prompt('V1-REPORT-TEXT')
    expect(p).toContain('V1-REPORT-TEXT')
    expect(p).toContain('遗漏')
    expect(p).toContain('不真实')
    expect(p).toContain('若某类没有发现，写「无」')
  })
})

describe('digestVisionReport（给裁判的紧凑证据）', () => {
  it('V2 有发现 → flagged，摘要含计数与截断', () => {
    const v2 = '## 遗漏\n1. 元素A\n2. 元素B\n\n## 不具体修正\n1. 颜色X\n\n## 不真实纠正\n无'
    const d = digestVisionReport('x'.repeat(3000), v2)
    expect(d.flagged).toBe(true)
    expect(d.digest).toContain('视觉审计')
    expect(d.digest).toContain('遗漏2')
    expect(d.digest.length).toBeLessThanOrEqual(400)
  })
  it('V2 三类全无 → 不 flagged', () => {
    const d = digestVisionReport('v1', '## 遗漏\n无\n## 不具体修正\n无\n## 不真实纠正\n无')
    expect(d.flagged).toBe(false)
  })
})

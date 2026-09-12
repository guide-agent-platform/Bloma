import { describe, it, expect, afterEach } from 'vitest'
import {
  visionAuditEnabled, deriveChatBaseUrl, resolveVisionRoles, resolveVisionPair, pickVisionEndpoint,
  BLIND_DESCRIBE_PROMPT, buildComparePrompt, extractJson, parseCompareOutput, digestVisionReport,
  parseMaxTokensCap,
  type ChannelLike, type VisionProblem,
} from '../../../main/coding/vision-audit-gate'

/**
 * L1 视觉审计链路——纯函数单测。
 * 链路（2026-09-12 重构）：A 盲描述(JSON+坐标) → B 盲描述(独立) → 对照审核(二次识别→问题 JSON) → 编程模型修复。
 * 角色可选配、不绑定厂商；默认全 flash 档（本机限制）。
 */

const DS: ChannelLike = {
  id: 'ch-ds', name: 'ds', base_url: 'https://api.deepseek.com/anthropic',
  api_key: 'hex-ds', models: [{ id: 'deepseek-flash', enabled: true }, { id: 'deepseek-v4-flash-vision-exp', enabled: true }],
  enabled: true,
}
const ZHIPU: ChannelLike = {
  id: 'ch-zhipu', name: '智谱视觉', base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key: 'hex-zp', models: [{ id: 'glm-4v-flash', enabled: true }, { id: 'glm-4.6v', enabled: true }], enabled: true,
}
const QWEN: ChannelLike = {
  id: 'ch-qwen', name: '通义千问', base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  api_key: 'hex-qw', models: [{ id: 'qwen3-vl-flash', enabled: true }, { id: 'qwen3-vl-plus', enabled: true }], enabled: true,
}
const decrypt = (hex: string) => `plain(${hex})`

describe('visionAuditEnabled（紧急逃生门，缺省开）', () => {
  const saved = process.env.BLOMA_VISION_AUDIT
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOMA_VISION_AUDIT
    else process.env.BLOMA_VISION_AUDIT = saved
  })
  it("未设置 → 启用；'0' → 停用", () => {
    delete process.env.BLOMA_VISION_AUDIT
    expect(visionAuditEnabled()).toBe(true)
    process.env.BLOMA_VISION_AUDIT = '0'
    expect(visionAuditEnabled()).toBe(false)
  })
})

describe('deriveChatBaseUrl', () => {
  it('anthropic 根 / compatible-mode / 尾斜杠三种形态', () => {
    expect(deriveChatBaseUrl('https://api.deepseek.com/anthropic')).toBe('https://api.deepseek.com')
    expect(deriveChatBaseUrl('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1')
    expect(deriveChatBaseUrl('https://api.deepseek.com/anthropic/')).toBe('https://api.deepseek.com')
  })
})

describe('角色解析（A/B/对照，跨渠道优先，不绑定厂商）', () => {
  it('智谱(A) + 通义千问(B) → A=glm-4v-flash、B=qwen3-vl-flash、对照缺省复用 B', () => {
    const roles = resolveVisionRoles([ZHIPU, QWEN], decrypt)
    expect(roles!.a.model).toBe('glm-4v-flash')
    expect(roles!.b.model).toBe('qwen3-vl-flash')
    expect(roles!.compare.model).toBe('qwen3-vl-flash')
    expect(roles!.compare.channelName).toBe('通义千问')
    expect(roles!.a.apiKey).toBe('plain(hex-zp)')
  })

  it('B 优先换渠道；只剩一家时同渠道为次优解（不判失败）', () => {
    const both: ChannelLike = {
      ...ZHIPU, id: 'ch-both', name: '混合渠道',
      models: [{ id: 'glm-4v-flash', enabled: true }, { id: 'qwen3-vl-flash', enabled: true }],
    }
    const roles = resolveVisionRoles([both], decrypt)
    expect(roles!.a.channelName).toBe(roles!.b.channelName)
  })

  it('ds 不再被当作视觉来源（A 必须仍选 glm）', () => {
    const roles = resolveVisionRoles([DS, ZHIPU, QWEN], decrypt)
    expect(roles!.a.model).toBe('glm-4v-flash')
  })

  it('兼容旧名 resolveVisionPair：v1/v2 == A/B', () => {
    const pair = resolveVisionPair([ZHIPU, QWEN], decrypt)
    expect(pair!.v1.model).toBe('glm-4v-flash')
    expect(pair!.v2.model).toBe('qwen3-vl-flash')
  })

  it('缺 A 或缺 B → null（上层落 unavailable，绝不静默）', () => {
    expect(resolveVisionRoles([QWEN], decrypt)).toBeNull()
    expect(resolveVisionRoles([ZHIPU], decrypt)).toBeNull()
  })

  it('禁用渠道不参与', () => {
    expect(resolveVisionRoles([{ ...ZHIPU, enabled: false }, QWEN], decrypt)).toBeNull()
  })

  it('pickVisionEndpoint：excludeChannelId 语义', () => {
    expect(pickVisionEndpoint([ZHIPU, QWEN], ['qwen3-vl-flash'], ZHIPU.id)?.channel.id).toBe('ch-qwen')
    expect(pickVisionEndpoint([ZHIPU, QWEN], ['qwen3-vl-flash'], 'ch-qwen')).toBeUndefined()
  })
})

describe('盲描述与对照审核提示词', () => {
  it('盲描述要求 JSON + 坐标，且明确禁止推测/评价', () => {
    expect(BLIND_DESCRIBE_PROMPT).toContain('bbox')
    expect(BLIND_DESCRIBE_PROMPT).toContain('只输出一个 JSON 对象')
    expect(BLIND_DESCRIBE_PROMPT).toContain('禁止评价好坏')
    expect(BLIND_DESCRIBE_PROMPT).toContain('uncertain')
  })
  it('对照审核内嵌两份独立描述，并要求以原图为准、拿不准降级不删', () => {
    const p = buildComparePrompt('A-JSON', 'B-JSON')
    expect(p).toContain('A-JSON')
    expect(p).toContain('B-JSON')
    expect(p).toContain('problems')
    expect(p).toContain('以原图为准')
    expect(p).toContain('拿不准的降 severity，不要删')
  })
})

describe('extractJson（容忍围栏/噪声）', () => {
  it('裸 JSON / 围栏 / 前后文字 三种都能抠出', () => {
    expect(extractJson<{ a: number }>('{"a":1}')?.a).toBe(1)
    expect(extractJson<{ a: number }>('```json\n{"a":2}\n```')?.a).toBe(2)
    expect(extractJson<{ a: number }>('好的，结果如下：{"a":3} 以上。')?.a).toBe(3)
  })
  it('无 JSON → undefined', () => {
    expect(extractJson('没有任何对象')).toBeUndefined()
  })
})

describe('parseCompareOutput（问题 JSON → VisionProblem[]）', () => {
  const good = JSON.stringify({
    problems: [
      { kind: 'omission', severity: 'high', claim: '缺少保存按钮', bbox: [10, 20, 80, 32], evidence: '右上角无按钮', suggest_fix: '提供保存入口' },
      { kind: 'false_claim', severity: 'weird', claim: '空态文案被误述', bbox: null, evidence: '图中为「暂无数据」', suggest_fix: '如实显示空态' },
      { kind: 'not-a-kind', severity: 'high', claim: '非法类型应丢弃' },
      { kind: 'state_error', severity: 'low', claim: '' },
    ],
    corrections: [{ who: 'A', claim: 'x', actual: 'y' }],
    confidence: 'medium',
  })
  it('保留合法条目、丢弃非法 kind/空 claim、severity 非法回落 medium、bbox 校验', () => {
    const out = parseCompareOutput(good)
    expect(out.parsed).toBe(true)
    expect(out.problems).toHaveLength(2)
    expect(out.problems[0]).toMatchObject({ kind: 'omission', severity: 'high' })
    expect(out.problems[0].bbox).toEqual([10, 20, 80, 32])
    expect(out.problems[1].severity).toBe('medium')
    expect(out.problems[1].bbox).toBeNull()
    expect(out.confidence).toBe('medium')
  })
  it('非 JSON 输出 → parsed=false 且空问题（不猜）', () => {
    const out = parseCompareOutput('抱歉我没法分析')
    expect(out.parsed).toBe(false)
    expect(out.problems).toEqual([])
  })
  it('问题条数上限 30（防爆）', () => {
    const many = JSON.stringify({ problems: Array.from({ length: 50 }, (_, i) => ({ kind: 'omission', severity: 'low', claim: `p${i}` })) })
    expect(parseCompareOutput(many).problems).toHaveLength(30)
  })
})

describe('digestVisionReport（裁判摘要）', () => {
  const problems: VisionProblem[] = [
    { kind: 'omission', severity: 'high', claim: '缺少保存按钮', bbox: null, evidence: '', suggest_fix: '' },
    { kind: 'inaccurate', severity: 'low', claim: '颜色描述偏差', bbox: null, evidence: '', suggest_fix: '' },
  ]
  it('有问题 → flagged，摘要含计数与 high 数、长度 ≤400', () => {
    const { digest, flagged } = digestVisionReport('a'.repeat(500), 'b'.repeat(300), problems)
    expect(flagged).toBe(true)
    expect(digest).toContain('问题 2 条')
    expect(digest).toContain('high 1')
    expect(digest.length).toBeLessThanOrEqual(400)
  })
  it('无问题 → 不 flagged', () => {
    expect(digestVisionReport('a', 'b', []).flagged).toBe(false)
  })
})

describe('max_tokens 上限自适应', () => {
  it('解析智谱实测报错（中文范围）；英文方括号范围；解析不出返回 undefined', () => {
    expect(parseMaxTokensCap('{"error":{"code":"1210","message":"max_tokens参数非法：限制数值范围[1,1024]"}}')).toBe(1024)
    expect(parseMaxTokensCap('max_tokens must be in range [1, 4096]')).toBe(4096)
    expect(parseMaxTokensCap('{"error":"model not found"}')).toBeUndefined()
  })
})

import { describe, it, expect, afterEach } from 'vitest'
import {
  deriveChatBaseUrl, resolveVisionRoles, resolveVisionPair, pickVisionEndpoint,
  BLIND_DESCRIBE_PROMPT, buildComparePrompt, extractJson, parseCompareOutput, digestVisionReport,
  parseMaxTokensCap, productProblems, normalizeTarget, defaultTargetForKind,
  buildVisionRequest, VISION_TEMPERATURE, VISION_FRAMES, VISION_FRAME_INTERVAL_MS, VISION_VIEWPORT, VISION_WINDOW_MS,
  confirmationRequiredProblems,
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
  it('对照审核内嵌两份独立描述，并要求以原图为准、拿不准降级不删、混合问题拆条', () => {
    const p = buildComparePrompt('A-JSON', 'B-JSON')
    expect(p).toContain('A-JSON')
    expect(p).toContain('B-JSON')
    expect(p).toContain('problems')
    expect(p).toContain('以原图为准')
    expect(p).toContain('拿不准的降 severity，不要删')
    expect(p).toContain('target')
    expect(p).toContain('root_cause')
    expect(p).toContain('混合问题必须拆成多条')
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

describe('parseCompareOutput（问题 JSON → VisionProblem[] + Q5 路由）', () => {
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
  it('Q5 默认推导：omission→product、false_claim→description、root_cause 缺省 ambiguous', () => {
    const out = parseCompareOutput(good)
    expect(out.problems[0]).toMatchObject({ target: 'product', root_cause: 'ambiguous' })
    expect(out.problems[1]).toMatchObject({ target: 'description', root_cause: 'ambiguous' })
  })
  it('Q5 root_cause 改判：product 升级 false_claim；observer 降级 missing_element', () => {
    const out = parseCompareOutput(JSON.stringify({
      problems: [
        { kind: 'false_claim', severity: 'high', claim: '状态不可辨导致误述', root_cause: 'product' },
        { kind: 'missing_element', severity: 'medium', claim: '观察员漏看了一个图标', root_cause: 'observer' },
        { kind: 'missing_element', severity: 'high', claim: '产品缺少导出入口', root_cause: 'product' },
      ],
    }))
    expect(out.problems[0]).toMatchObject({ target: 'product', root_cause: 'product' })
    expect(out.problems[1]).toMatchObject({ target: 'description', root_cause: 'observer' })
    expect(out.problems[2]).toMatchObject({ target: 'product', root_cause: 'product' })
  })
  it('Q5 target 非法值→按 kind 推导；critical 档保留', () => {
    const out = parseCompareOutput(JSON.stringify({
      problems: [{ kind: 'layout_error', severity: 'critical', target: '乱七八糟', claim: '主区被遮挡' }],
    }))
    expect(out.problems[0]).toMatchObject({ target: 'product', severity: 'critical' })
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

describe('Q5 修复白名单（productProblems）', () => {
  it('只有 target=product 进编程模型；description 不回喂代码', () => {
    const out = parseCompareOutput(JSON.stringify({
      problems: [
        { kind: 'omission', severity: 'high', claim: '缺导出按钮' },
        { kind: 'inaccurate', severity: 'low', claim: '颜色描述偏差' },
        { kind: 'false_claim', severity: 'high', claim: '状态被误述', root_cause: 'product' },
      ],
    }))
    const product = productProblems(out.problems)
    // 缺导出按钮属"不存在"类断言 → 需二次窗口确认（评审 #3），不进白名单
    expect(product.map((p) => p.claim)).toEqual(['状态被误述'])
    expect(confirmationRequiredProblems(out.problems).map((p) => p.claim)).toEqual(['缺导出按钮'])
  })
})

describe('digestVisionReport（裁判摘要）', () => {
  const problems: VisionProblem[] = [
    { kind: 'omission', severity: 'high', target: 'product', root_cause: 'ambiguous', claim: '缺少保存按钮', bbox: null, evidence: '', suggest_fix: '' },
    { kind: 'inaccurate', severity: 'low', target: 'description', root_cause: 'observer', claim: '颜色描述偏差', bbox: null, evidence: '', suggest_fix: '' },
  ]
  it('有问题 → flagged；摘要区分产品侧/描述质量，长度 ≤400', () => {
    const { digest, flagged } = digestVisionReport('a'.repeat(500), 'b'.repeat(300), problems)
    expect(flagged).toBe(true)
    expect(digest).toContain('问题 2 条')
    expect(digest).toContain('产品侧 1')
    expect(digest).toContain('描述质量 1')
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

describe('采样参数固定（⑦）与多帧（⑥）', () => {
  const ep = { chatBase: 'https://x', apiKey: 'k', model: 'glm-4v-flash', channelName: '智谱视觉' }
  it('请求体：温度固定、多帧图块数 = frames、文本块在首位', () => {
    const frames = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]
    const req = buildVisionRequest(ep, 'INSTR', frames, 1024) as {
      temperature: number; max_tokens: number; messages: { content: { type: string; image_url?: { url: string } }[] }[]
    }
    expect(req.temperature).toBe(VISION_TEMPERATURE)
    expect(VISION_TEMPERATURE).toBe(0)
    expect(req.max_tokens).toBe(1024)
    const content = req.messages[0].content
    expect(content[0].type).toBe('text')
    expect(content).toHaveLength(1 + frames.length)
    for (const block of content.slice(1)) expect(block.image_url!.url.startsWith('data:image/png;base64,')).toBe(true)
  })
  it('缺省采样窗口 ≈5s（评审 #3：窗口须覆盖最慢游戏周期，不是只看帧数）', () => {
    expect(VISION_FRAMES).toBe(5)
    expect(VISION_FRAME_INTERVAL_MS).toBe(1000)
    expect(VISION_WINDOW_MS).toBeGreaterThanOrEqual(5000)
    expect(VISION_VIEWPORT).toEqual({ width: 1440, height: 900 })
  })
  it('盲描述与对照审核提示词都写明多帧存在性规则', () => {
    expect(BLIND_DESCRIBE_PROMPT).toContain('多帧规则')
    expect(BLIND_DESCRIBE_PROMPT).toContain('frames_seen')
    expect(BLIND_DESCRIBE_PROMPT).toContain('任一帧可见即视为存在')
    expect(buildComparePrompt('A', 'B')).toContain('任一帧可见即视为存在')
  })
})

describe('缺证据类问题需二次窗口确认（评审 #3）', () => {
  it('omission / missing_element 自动标记 needs_confirmation', () => {
    const out = parseCompareOutput(JSON.stringify({
      problems: [
        { kind: 'missing_element', severity: 'high', claim: '缺蛇' },
        { kind: 'omission', severity: 'medium', claim: '缺少分数显示' },
        { kind: 'state_error', severity: 'high', claim: '按钮状态不可辨' },
        { kind: 'false_claim', severity: 'low', claim: '颜色描述偏差' },
      ],
    }))
    expect(out.problems[0].needs_confirmation).toBe(true)
    expect(out.problems[1].needs_confirmation).toBe(true)
    expect(out.problems[2].needs_confirmation).toBeUndefined()
    expect(out.problems[3].needs_confirmation).toBeUndefined()
  })
  it('白名单排除待确认项；待确认清单单独可取', () => {
    const out = parseCompareOutput(JSON.stringify({
      problems: [
        { kind: 'missing_element', severity: 'critical', claim: '缺蛇' },
        { kind: 'false_claim', severity: 'high', claim: '状态被误述', root_cause: 'product' },
      ],
    }))
    expect(productProblems(out.problems).map((p) => p.claim)).toEqual(['状态被误述'])
    expect(confirmationRequiredProblems(out.problems).map((p) => p.claim)).toEqual(['缺蛇'])
  })
})

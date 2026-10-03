import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChannel, getFirstEnabledChannel, updateChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { resetCategoryRoutingForTests, saveCategoryRouting } from '../../main/platform/llm/category-routing'
import { getAgentSessionPath } from '../../storage/config-paths'
import {
  resolveChannelEnv,
  resetCategoryRouteThrottleForTests,
  setDecisionSink,
} from '../../main/platform/llm/runtime-fallback'
import { recordDecision } from '../../main/project/decision-log'

/**
 * 渠道自动回退的密钥解密守卫（getFirstEnabledChannel）。
 *
 * 背景：~/.proma/bloma-channels.json 里的项目渠道 api_key 用 safeStorage 加密。
 * 若 ciphertext 来自另一平台（macOS 的 "v10" 前缀在 Windows DPAPI 下解不开）
 * 或 safeStorage 密钥已变更，decryptSecret 会抛错。getFirstEnabledChannel
 * 必须跳过这类损坏渠道，否则自动选中后 runAgent 解密崩溃。
 */

function workingSafeStorage(): void {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
}

function seed(name: string, providerType: 'anthropic' | 'kimi-api' | 'zhipu-coding' | 'deepseek' = 'anthropic') {
  return createChannel({
    name,
    provider_type: providerType,
    base_url: `https://${name}.example`,
    api_key: `key-${name}`,
    models: [{ id: `${name}-m1`, name: `model-${name}`, enabled: true }],
  })
}

/** 从会话 JSONL 提取全部 system 决策行文本。 */
function readDecisionLines(sessionId: string): string[] {
  try {
    return readFileSync(getAgentSessionPath(sessionId), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; content: Array<{ type: string; text?: string }> })
      .filter((message) => message.role === 'system')
      .map((message) => message.content.find((block) => block.type === 'text')?.text ?? '')
      .filter((text) => text.startsWith('[decision]'))
  } catch {
    return []
  }
}

describe('channel auto-fallback decrypt guard', () => {
  const originalPromaHome = process.env.PROMA_HOME

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('密钥无法解密的渠道被跳过，返回 undefined 而不是抛错', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home
    // safeStorage 可用但读出的 ciphertext 解不开（模拟跨平台迁移的损坏密钥）
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: () => {
        throw new Error('Error while decrypting the ciphertext')
      },
    })

    createChannel({ name: 'broken', provider_type: 'anthropic', base_url: 'https://x', api_key: 'secret' })

    expect(getFirstEnabledChannel()).toBeUndefined()
  })

  it('密钥可解密的第一个启用渠道被选中', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })

    const first = createChannel({ name: 'a', provider_type: 'anthropic', base_url: 'https://a', api_key: 'key-a' })
    createChannel({ name: 'b', provider_type: 'anthropic', base_url: 'https://b', api_key: 'key-b' })

    expect(getFirstEnabledChannel()?.id).toBe(first.id)
  })

  it('损坏渠道在前、可用渠道在后时跳过损坏项选中可用项', () => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-fallback-'))
    process.env.PROMA_HOME = home

    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => {
        const text = value.toString('utf8')
        if (text === 'enc:bad') throw new Error('Error while decrypting the ciphertext')
        return text.replace(/^enc:/, '')
      },
    })

    createChannel({ name: 'broken', provider_type: 'anthropic', base_url: 'https://x', api_key: 'bad' })
    const good = createChannel({ name: 'good', provider_type: 'anthropic', base_url: 'https://y', api_key: 'good-key' })

    expect(getFirstEnabledChannel()?.id).toBe(good.id)
  })
})

/**
 * M5 类别路由 × resolveChannelEnv 集成（§10 扩展用例）：
 * - 优先级：显式 channel_id > 路由表 > 全局兜底；
 * - 路由主渠道生效：sketch 解析到 Kimi 渠道 env（断言 base_url/model）；
 * - 路由主渠道 build 失败 → 先按 fallback_channel_ids 顺序切 → 再任意渠道；
 * - 无路由配置与现状一致（回归）；
 * - 决策日志 category_route：命中路由落一条、30s 节流、缺 projectId/sessionId 跳过。
 *
 * 2026-10-03 删留执行：吸收 summary-channel-fallback.test.ts（三例与本 describe 的 sketch
 * 版逐一同构——runtime-fallback 对 summary 零特判，仅换 category 字符串），悬空/主渠道
 * 失败/无配置三场景参数化 sketch+summary 各跑一遍，防止「默认关」被误读成不参与路由。
 */
describe('category routing × resolveChannelEnv（M5）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-m5-routing-'))
    workingSafeStorage()
    resetCategoryRoutingForTests()
    resetCategoryRouteThrottleForTests()
    // PR4 后续：平台件已去域依赖，测试接真源（与 main/index 接线同款）
    setDecisionSink((input) => recordDecision(input as unknown as Parameters<typeof recordDecision>[0]))
    vi.restoreAllMocks()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    resetCategoryRoutingForTests()
    resetCategoryRouteThrottleForTests()
    vi.restoreAllMocks()
  })

  it('优先级：显式 channel_id 最高，其次路由表，未配置回退全局第一个启用渠道', () => {
    const ds = seed('ds-first', 'deepseek')
    const kimi = seed('kimi', 'kimi-api')
    const glm = seed('glm', 'zhipu-coding')
    saveCategoryRouting({ sketch: { channel_id: kimi.id } })

    // 无显式 channel_id → 路由表命中 kimi（不依赖 getFirstEnabledChannel 恰为 ds）
    const routed = resolveChannelEnv({ category: 'sketch' })
    expect(routed.env?.ANTHROPIC_BASE_URL).toBe('https://kimi.example')
    expect(routed.env?.ANTHROPIC_MODEL).toBe('model-kimi')
    expect(routed.channel?.id).toBe(kimi.id)

    // 显式 channel_id 压过路由表
    const explicit = resolveChannelEnv({ channelId: glm.id, category: 'sketch' })
    expect(explicit.channel?.id).toBe(glm.id)

    // 未配置类别（mvp）→ 全局兜底 ds-first
    const auto = resolveChannelEnv({ category: 'mvp' })
    expect(auto.channel?.id).toBe(ds.id)
  })

  it('目标映射（§11.2）：sketch→Kimi、mvp→GLM、guide/prd/judge/summary→DeepSeek 显式逐类生效', () => {
    const ds = seed('ds', 'deepseek')
    const kimi = seed('kimi', 'kimi-api')
    const glm = seed('glm', 'zhipu-coding')
    // 故意让全局默认不是 DeepSeek，证明映射不依赖渠道顺序
    saveCategoryRouting({
      sketch: { channel_id: kimi.id },
      mvp: { channel_id: glm.id },
      guide: { channel_id: ds.id },
      prd: { channel_id: ds.id },
      judge: { channel_id: ds.id },
      summary: { channel_id: ds.id },
    })

    const expectChannel = (category: 'sketch' | 'mvp' | 'guide' | 'prd' | 'judge' | 'summary', id: string) => {
      const resolution = resolveChannelEnv({ category })
      expect(resolution.channel?.id).toBe(id)
    }
    expectChannel('sketch', kimi.id)
    expectChannel('mvp', glm.id)
    expectChannel('guide', ds.id)
    expectChannel('prd', ds.id)
    expectChannel('judge', ds.id)
    expectChannel('summary', ds.id)
  })

  it.each(['sketch', 'summary'] as const)('路由悬空（渠道已删除）→ 回退全局默认渠道，不崩溃 [%s]', (category) => {
    const ds = seed('ds', 'deepseek')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    saveCategoryRouting({ [category]: { channel_id: 'deleted-id' } } as Parameters<typeof saveCategoryRouting>[0])

    const resolution = resolveChannelEnv({ category })
    expect(resolution.channel?.id).toBe(ds.id)
    expect(resolution.env).toBeDefined()
  })

  it.each(['sketch', 'summary'] as const)('路由主渠道 build 失败 → 先按 fallback_channel_ids 顺序切备用 [%s]', (category) => {
    const kimi = seed('kimi', 'kimi-api')
    const glm = seed('glm', 'zhipu-coding')
    seed('ds', 'deepseek')
    // kimi 渠道清空模型 → 主渠道 model_not_found
    updateChannel(kimi.id, { models: [] })
    saveCategoryRouting({
      [category]: { channel_id: kimi.id, fallback_channel_ids: [glm.id] },
    } as Parameters<typeof saveCategoryRouting>[0])

    const resolution = resolveChannelEnv({ category, projectId: `p-m5-${category}`, sessionId: `s-m5-${category}` })
    // 备用顺序优先：先 glm（配置的 fallback）而非配置序在前的其他渠道
    expect(resolution.channel?.id).toBe(glm.id)
    expect(resolution.env?.ANTHROPIC_BASE_URL).toBe('https://glm.example')
    // 切换留痕（T9 决策日志，非静默）
    const decisions = readDecisionLines(`s-m5-${category}`)
    expect(decisions.some((line) => line.includes('runtime_channel_switch') && line.includes('glm'))).toBe(true)
  })

  it.each(['sketch', 'summary'] as const)('无路由配置时与现状行为一致（回归）：全局第一个启用渠道 [%s]', (category) => {
    const first = seed('first', 'deepseek')
    seed('second', 'kimi-api')

    const resolution = resolveChannelEnv({ category })
    expect(resolution.channel?.id).toBe(first.id)
  })

  it('决策日志 category_route：路由命中落一条（含 channel/model/source），30s 窗口同键节流', () => {
    const kimi = seed('kimi', 'kimi-api')
    const ds = seed('ds', 'deepseek')
    saveCategoryRouting({ sketch: { channel_id: kimi.id }, guide: { channel_id: ds.id } })

    resolveChannelEnv({ category: 'sketch', projectId: 'p-route', sessionId: 's-route' })
    resolveChannelEnv({ category: 'sketch', projectId: 'p-route', sessionId: 's-route' })
    resolveChannelEnv({ category: 'guide', projectId: 'p-route', sessionId: 's-route' })

    const routeLines = readDecisionLines('s-route').filter((line) => line.includes('category_route'))
    // sketch 两次同键 → 30s 节流只落一条；guide 另一类别各一条
    const sketchLines = routeLines.filter((line) => line.includes('"sketch"') || line.includes('草图'))
    expect(sketchLines).toHaveLength(1)
    expect(routeLines.filter((line) => line.includes('"guide"'))).toHaveLength(1)

    const entry = JSON.parse(sketchLines[0]!.slice('[decision] '.length)) as {
      detail: { channel_id: string; channel_name: string; model: string; source: string; category: string }
    }
    expect(entry.detail).toMatchObject({
      category: 'sketch',
      channel_id: kimi.id,
      channel_name: 'kimi',
      model: 'model-kimi',
      source: 'category_routing',
    })
  })

  it('决策日志 category_route：projectId/sessionId 缺失时跳过不落（与 T9 口径一致）', () => {
    const kimi = seed('kimi', 'kimi-api')
    saveCategoryRouting({ sketch: { channel_id: kimi.id } })

    const resolution = resolveChannelEnv({ category: 'sketch' })
    expect(resolution.channel?.id).toBe(kimi.id)
    expect(readDecisionLines('s-none')).toEqual([])
  })

  it('决策日志 category_route：非路由命中（全局默认）不落', () => {
    seed('ds', 'deepseek')
    const resolution = resolveChannelEnv({ category: 'sketch', projectId: 'p-auto', sessionId: 's-auto' })
    expect(resolution.channel).toBeDefined()
    expect(readDecisionLines('s-auto').filter((line) => line.includes('category_route'))).toEqual([])
  })
})

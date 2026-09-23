// @vitest-environment node
/**
 * P2 测试盲区「summary 渠道回退」（2026-09-02 补测）。
 *
 * summary（T4-L3 蒸馏）是 ROUTABLE_CATEGORIES 里唯一「默认关」且不隶属任何角色的类别：
 * 不进 ROLE_CATEGORIES，只能走类别级路由表或全局兜底。既有 channel-fallback.test.ts
 * 只锁了 sketch 的回退链与 summary→DeepSeek 的显式映射，未锁 summary 自身的
 * 回退链 / 悬空回退 / 无配置回退。这里补三处，防止「默认关」被误读成「不参与路由」，
 * 或 summary 因非角色类别被回退链遗漏。
 */

import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChannel, updateChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { resetCategoryRoutingForTests, saveCategoryRouting } from '../../main/platform/llm/category-routing'
import { resetCategoryRouteThrottleForTests, resolveChannelEnv } from '../../main/platform/llm/runtime-fallback'

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

describe('summary 渠道回退（P2 盲区）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-summary-'))
    workingSafeStorage()
    resetCategoryRoutingForTests()
    resetCategoryRouteThrottleForTests()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    resetCategoryRoutingForTests()
    resetCategoryRouteThrottleForTests()
    vi.restoreAllMocks()
  })

  it('summary 主渠道 model_not_found → 按 fallback_channel_ids 顺序切备用', () => {
    const kimi = seed('kimi', 'kimi-api')
    const glm = seed('glm', 'zhipu-coding')
    seed('ds', 'deepseek')
    updateChannel(kimi.id, { models: [] }) // 主渠道清空模型 → model_not_found
    saveCategoryRouting({ summary: { channel_id: kimi.id, fallback_channel_ids: [glm.id] } })

    const resolution = resolveChannelEnv({ category: 'summary', projectId: 'p-summary', sessionId: 's-summary' })
    expect(resolution.channel?.id).toBe(glm.id)
    expect(resolution.env?.ANTHROPIC_BASE_URL).toBe('https://glm.example')
    expect(resolution.env?.ANTHROPIC_MODEL).toBe('model-glm')
  })

  it('summary 路由悬空（渠道已删除）→ 回退全局默认渠道，不崩溃', () => {
    const ds = seed('ds', 'deepseek')
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    saveCategoryRouting({ summary: { channel_id: 'deleted-id' } })

    const resolution = resolveChannelEnv({ category: 'summary' })
    expect(resolution.channel?.id).toBe(ds.id)
    expect(resolution.env).toBeDefined()
  })

  it('summary 无路由配置 → 回退全局默认（锁定「默认关」≠不参与路由）', () => {
    const first = seed('first', 'deepseek')
    seed('second', 'kimi-api')

    const resolution = resolveChannelEnv({ category: 'summary' })
    expect(resolution.channel?.id).toBe(first.id)
    expect(resolution.env?.ANTHROPIC_MODEL).toBe('model-first')
  })
})

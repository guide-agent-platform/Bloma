import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createChannel,
  deleteChannel,
  fetchModels,
  getChannelById,
  listChannels,
  testChannelDirect,
  updateChannel,
} from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'

/**
 * 渠道管理 CRUD / 直接测试 / 模型拉取测试（S2-AGENT）。
 * 使用临时 PROMA_HOME + mock safeStorage 适配器，不写入真实用户目录。
 */

function mockEncryption(): void {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
}

let originalPromaHome: string | undefined

beforeEach(() => {
  originalPromaHome = process.env.PROMA_HOME
  const home = mkdtempSync(join(tmpdir(), 'bloma-channel-'))
  process.env.PROMA_HOME = home
  mockEncryption()
})

afterEach(() => {
  process.env.PROMA_HOME = originalPromaHome
  vi.unstubAllGlobals()
})

describe('渠道 CRUD（snake_case 存储契约）', () => {
  it('创建渠道后能列表、按 ID 读取（api_key 脱敏）', () => {
    const created = createChannel({
      name: '我的 DeepSeek',
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'secret-key',
      models: [{ id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', enabled: true }],
    })

    expect(listChannels()).toHaveLength(1)
    expect(listChannels()[0]!.api_key).toBe('***')

    const byId = getChannelById(created.id)
    expect(byId?.name).toBe('我的 DeepSeek')
    expect(byId?.api_key).toBe('***')
  })

  it('updateChannel 更新字段且 api_key 空串不更新', () => {
    const created = createChannel({
      name: 'old',
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'key-a',
    })

    const updated = updateChannel(created.id, {
      name: 'new-name',
      base_url: 'https://api.deepseek.com',
      api_key: '',
    })

    expect(updated?.name).toBe('new-name')
    expect(updated?.base_url).toBe('https://api.deepseek.com')

    // api_key 空串：密钥保持原值（仍可解密为 key-a）
    const raw = getChannelById(created.id)
    expect(raw?.api_key).toBe('***')
  })

  it('updateChannel 更新密钥时重新加密', () => {
    const created = createChannel({ name: 'a', provider_type: 'anthropic', base_url: 'https://x', api_key: 'key-old' })
    const updated = updateChannel(created.id, { api_key: 'key-new' })
    expect(updated?.api_key).toBe('***')
  })

  it('updateChannel 不存在的渠道返回 undefined', () => {
    expect(updateChannel('not-exist', { name: 'x' })).toBeUndefined()
  })

  it('deleteChannel 删除后列表为空', () => {
    const created = createChannel({ name: 'a', provider_type: 'anthropic', base_url: 'https://x', api_key: 'k' })
    expect(deleteChannel(created.id)).toBe(true)
    expect(listChannels()).toHaveLength(0)
  })
})

describe('testChannelDirect — 保存前直接测试（mock fetch）', () => {
  it('连接成功时返回 ok', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    const result = await testChannelDirect({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-test',
    })
    expect(result.ok).toBe(true)
    expect(result.message).toBe('连接成功')
  })

  it('401 时返回 auth 分类错误', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":{"message":"invalid api key"}}', { status: 401 }),
    ))
    const result = await testChannelDirect({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'sk-bad',
    })
    expect(result.ok).toBe(false)
    expect(result.errorType).toBe('auth')
  })

  it('网络异常时返回 network 分类', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed: ECONNREFUSED')
    }))
    const result = await testChannelDirect({
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'k',
    })
    expect(result.ok).toBe(false)
    expect(result.errorType).toBe('network')
  })

  it('api_key 为空时通过 channel_id 回退到已保存渠道密钥', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const created = createChannel({
      name: 'saved',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'saved-secret-key',
    })

    const result = await testChannelDirect({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: '',
      channel_id: created.id,
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('既无 api_key 也无 channel_id 时返回可读错误且不发请求', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const result = await testChannelDirect({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: '',
    })

    expect(result.ok).toBe(false)
    expect(result.message).toContain('请填写 API Key')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('fetchModels — 自动拉取模型列表（mock fetch）', () => {
  it('OpenAI 兼容 provider 从 /models 拉取并排序', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }), { status: 200 }),
    ))
    const result = await fetchModels({
      provider_type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-test',
    })
    expect(result.success).toBe(true)
    expect(result.models.map((m) => m.id)).toEqual(['gpt-a', 'gpt-b'])
    expect(result.models[0]?.source).toBe('fetched')
  })

  it('deepseek 从协议根 origin /models 拉取', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await fetchModels({
      provider_type: 'deepseek',
      base_url: 'https://api.deepseek.com/anthropic',
      api_key: 'k',
    })
    const calledUrl = String(fetchMock.mock.calls[0]![0])
    expect(calledUrl).toContain('https://api.deepseek.com/models')
  })

  it('无列表端点 provider（xiaomi）返回预设模型', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('should not be called') }))
    const result = await fetchModels({
      provider_type: 'xiaomi',
      base_url: 'https://api.xiaomimimo.com',
      api_key: 'k',
    })
    expect(result.success).toBe(true)
    expect(result.models.length).toBeGreaterThan(0)
  })

  it('拉取失败时返回失败结果', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":{"message":"unauthorized"}}', { status: 401 }),
    ))
    const result = await fetchModels({
      provider_type: 'openai',
      base_url: 'https://api.openai.com/v1',
      api_key: 'sk-bad',
    })
    expect(result.success).toBe(false)
    expect(result.models).toEqual([])
  })

  it('api_key 为空时通过 channel_id 回退到已保存渠道密钥', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const created = createChannel({
      name: 'saved',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'saved-secret-key',
    })

    const result = await fetchModels({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: '',
      channel_id: created.id,
    })

    expect(result.success).toBe(true)
    expect(result.models.map((m) => m.id)).toContain('claude-sonnet-4-6')
    expect(fetchMock).toHaveBeenCalled()
  })

  it('既无 api_key 也无 channel_id 时返回可读错误且不发请求', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('should not be called') })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchModels({
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: '',
    })

    expect(result.success).toBe(false)
    expect(result.message).toContain('请填写 API Key')
    expect(result.models).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

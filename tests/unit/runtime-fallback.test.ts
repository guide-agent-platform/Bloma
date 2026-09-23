import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createChannel } from '../../main/platform/llm/channel-manager'
import { setSafeStorageAdapter } from '../../main/platform/storage/safe-storage'
import { getSdkQuery, resetSDKQueryForTests } from '../../main/orchestration/orchestrator'
import { setSseRetryWaitBudgetForTests } from '../../main/platform/upstream/providers/sse-reader'
import {
  isInfrastructureFailure,
  readFallbackContext,
  resolveChannelEnv,
  resetChannelSwitchThrottleForTests,
} from '../../main/platform/llm/runtime-fallback'
import { resetCategoryRoutingForTests, setCategoryRoutingForTests } from '../../main/platform/llm/category-routing'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { SDKMessage } from '../../shared/types'

/**
 * 运行时被动渠道回退（长期型改造 T9，M4 补丁）。
 *
 * M4 主动链只负责「运行前选哪个模型」；渠道瞬断（429/5xx/网络错误）或密钥损坏时
 * 原行为是整次生成静默降级（引导落规则路由/草图落模板）。这里锁定的行为：
 * - 请求期基础设施故障（尚未流出正文）→ 切备用渠道重试一次，落决策日志，不静默；
 * - 内容型失败（400/引擎层解析错）→ 不切换，原样上抛走既有重试链；
 * - 已流出正文 / 用户取消 / 无备用 → 不切换；
 * - 构建期密钥不可解密 → 同一切换语义（resolveChannelEnv）。
 */

function workingSafeStorage(): void {
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
}

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function failingStreamAfterFirstDelta(): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"半"}}\n\n'))
      // 延迟 error：同步 error 会被 undici 判为「已终止的流」转成 done 而非 reject
      setTimeout(() => controller.error(new Error('read ECONNRESET')), 10)
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const SSE_OK = () =>
  sseResponse([
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"备用渠道正文"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ])

interface SeededChannels {
  primary: { id: string }
  backup: { id: string }
}

function seedTwoChannels(): SeededChannels {
  workingSafeStorage()
  const primary = createChannel({
    name: '主渠道A',
    provider_type: 'anthropic',
    base_url: 'https://primary.example',
    api_key: 'key-a',
    models: [{ id: 'm1', name: 'model-a', enabled: true }],
  })
  const backup = createChannel({
    name: '备用渠道B',
    provider_type: 'anthropic',
    base_url: 'https://backup.example',
    api_key: 'key-b',
    models: [{ id: 'm2', name: 'model-b', enabled: true }],
  })
  return { primary, backup }
}

/** 从会话 JSONL 提取全部 system 行文本（决策行/系统行断言用）。 */
function readSystemLines(sessionId: string): string[] {
  const path = getAgentSessionPath(sessionId)
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; content: Array<{ type: string; text?: string }> })
      .filter((message) => message.role === 'system')
      .map((message) => message.content.find((block) => block.type === 'text')?.text ?? '')
  } catch {
    return []
  }
}

async function collect(query: ReturnType<typeof getSdkQuery>, prompt: string, env: Record<string, string>): Promise<SDKMessage[]> {
  const messages: SDKMessage[] = []
  for await (const message of query(prompt, { env, signal: new AbortController().signal, sessionId: 's-fallback' })) {
    messages.push(message)
  }
  return messages
}

describe('runtime channel fallback · T9 请求期被动切换', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    const home = mkdtempSync(join(tmpdir(), 'bloma-runtime-fallback-'))
    process.env.PROMA_HOME = home
    resetSDKQueryForTests()
    resetChannelSwitchThrottleForTests()
    // R1-providers：上游同渠道自愈重试（指数退避）在单测里会拖慢套件——禁用后
    // 首败直接交给 T9 被动切换，与旧路径钉点语义对齐
    setSseRetryWaitBudgetForTests(0)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    vi.unstubAllGlobals()
    setSseRetryWaitBudgetForTests()
  })

  it('首调基础设施故障（500）→ 切备用渠道重试一次，任务完成且决策日志含切换记录（验收正向）', async () => {
    const seeded = seedTwoChannels()
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('primary.example')) return new Response('upstream boom', { status: 500 })
      return SSE_OK()
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolution = resolveChannelEnv({ channelId: seeded.primary.id, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })
    expect(resolution.env).toBeDefined()
    // 回退上下文随 env 携带（请求期切换的依据）
    expect(readFallbackContext(resolution.env)?.channelId).toBe(seeded.primary.id)
    expect(readFallbackContext(resolution.env)?.category).toBe('sketch')

    const messages = await collect(getSdkQuery(), '画草图', resolution.env!)

    const text = messages
      .filter((message) => message.type === 'assistant')
      .map((message) => message.message?.content.map((block) => ('text' in block ? block.text : '')).join('') ?? '')
      .join('')
    expect(text).toBe('备用渠道正文')
    expect(messages.at(-1)).toEqual({ type: 'result', subtype: 'success' })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const systemLines = readSystemLines('s-fallback')
    // 决策行（T2）：触发原因 + 从哪切到哪
    const decision = systemLines.find((line) => line.startsWith('[decision]') && line.includes('runtime_channel_switch'))
    expect(decision).toBeDefined()
    expect(decision).toContain('主渠道A')
    expect(decision).toContain('备用渠道B')
    expect(decision).toContain('http_500')
    // 用户可见系统行（渲染端如实呈现，非静默）
    expect(systemLines.some((line) => line.startsWith('[channel-switch]') && line.includes('备用渠道B'))).toBe(true)
  })

  it('内容型失败（HTTP 400 请求级错误）不触发切换，原样上抛（验收负向）', async () => {
    const seeded = seedTwoChannels()
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('primary.example')) return new Response('bad request', { status: 400 })
      return SSE_OK()
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolution = resolveChannelEnv({ channelId: seeded.primary.id, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })
    await expect(collect(getSdkQuery(), '画草图', resolution.env!)).rejects.toThrow('SDK request failed with 400')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readSystemLines('s-fallback').some((line) => line.includes('runtime_channel_switch') || line.includes('[channel-switch]'))).toBe(false)
  })

  it('已流出正文后中断不切换（重试会导致 delta 重复拼接）', async () => {
    const seeded = seedTwoChannels()
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('primary.example')) return failingStreamAfterFirstDelta()
      return SSE_OK()
    })
    vi.stubGlobal('fetch', fetchMock)

    const resolution = resolveChannelEnv({ channelId: seeded.primary.id, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })
    await expect(collect(getSdkQuery(), '画草图', resolution.env!)).rejects.toThrow('ECONNRESET')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(readSystemLines('s-fallback').some((line) => line.includes('[channel-switch]'))).toBe(false)
  })

  it('用户主动取消不触发切换', async () => {
    const seeded = seedTwoChannels()
    const fetchMock = vi.fn(async () => SSE_OK())
    vi.stubGlobal('fetch', fetchMock)

    const resolution = resolveChannelEnv({ channelId: seeded.primary.id, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })
    const controller = new AbortController()
    controller.abort()
    await expect(
      (async () => {
        for await (const message of getSdkQuery()('画草图', { env: resolution.env!, signal: controller.signal, sessionId: 's-fallback' })) {
          void message
        }
      })(),
    ).rejects.toThrow('AGENT_CANCELLED')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无备用渠道时原错误照抛，不落切换记录', async () => {
    workingSafeStorage()
    createChannel({
      name: '唯一渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream boom', { status: 503 })))

    const resolution = resolveChannelEnv({ channelId: undefined, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })
    expect(resolution.env).toBeDefined()
    await expect(collect(getSdkQuery(), '画草图', resolution.env!)).rejects.toThrow('provider API 错误 (503)')
    expect(readSystemLines('s-fallback').some((line) => line.includes('[channel-switch]'))).toBe(false)
  })

  it('上层退避重试反复触发同一切换时，决策日志 30s 节流只落一条', async () => {
    const seeded = seedTwoChannels()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL) => {
        if (String(url).includes('primary.example')) return new Response('upstream boom', { status: 500 })
        return SSE_OK()
      }),
    )
    const resolution = resolveChannelEnv({ channelId: seeded.primary.id, category: 'sketch', projectId: 'p-fallback', sessionId: 's-fallback' })

    await collect(getSdkQuery(), '第一轮', resolution.env!)
    await collect(getSdkQuery(), '第二轮', resolution.env!)

    const switchLines = readSystemLines('s-fallback').filter((line) => line.includes('runtime_channel_switch'))
    expect(switchLines).toHaveLength(1)
  })
})

describe('runtime channel fallback · T9 构建期渠道解析', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-runtime-fallback-'))
    resetChannelSwitchThrottleForTests()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
  })

  it('主渠道密钥不可解密 → 构建期即切备用渠道并落决策（解密失败属基础设施故障）', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '坏密钥渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
    const backup = createChannel({
      name: '备用渠道B',
      provider_type: 'anthropic',
      base_url: 'https://backup.example',
      api_key: 'key-b',
      models: [{ id: 'm2', name: 'model-b', enabled: true }],
    })
    // 主渠道 ciphertext 解不开（模拟 safeStorage 密钥变更 / 跨平台迁移）
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => {
        const text = value.toString('utf8')
        if (text === 'enc:key-a') throw new Error('Error while decrypting the ciphertext')
        return text.replace(/^enc:/, '')
      },
    })

    const resolution = resolveChannelEnv({ channelId: primary.id, category: 'mvp', projectId: 'p-build', sessionId: 's-build' })
    expect(resolution.env?.ANTHROPIC_BASE_URL).toBe('https://backup.example')
    expect(resolution.channel?.id).toBe(backup.id)
    // 切换后的 env 仍携带上下文（channelId 指向备用渠道，供请求期继续判定）
    expect(readFallbackContext(resolution.env)?.channelId).toBe(backup.id)

    const systemLines = readSystemLines('s-build')
    const decision = systemLines.find((line) => line.startsWith('[decision]') && line.includes('runtime_channel_switch'))
    expect(decision).toContain('decrypt_failed')
    expect(decision).toContain('备用渠道B')
  })

  it('无任何可用渠道时如实返回 unusableReason，调用方维持原降级语义', () => {
    const resolution = resolveChannelEnv({ channelId: undefined, category: 'mvp', projectId: 'p-build', sessionId: 's-build' })
    expect(resolution.env).toBeUndefined()
    expect(resolution.channel).toBeUndefined()
    expect(resolution.unusableReason).toBe('no_channel')
  })

  it('requireTools：主渠道 supports_tools=false → 路由到 supports_tools=true 的备用渠道', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '不支持工具的主渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true, supports_tools: false }],
    })
    const backup = createChannel({
      name: '支持工具的备用渠道',
      provider_type: 'anthropic',
      base_url: 'https://backup.example',
      api_key: 'key-b',
      models: [{ id: 'm2', name: 'model-b', enabled: true, supports_tools: true }],
    })
    const resolution = resolveChannelEnv({ channelId: primary.id, category: 'mvp', projectId: 'p-tools', sessionId: 's-tools', requireTools: true })
    expect(resolution.channel?.id).toBe(backup.id)
    expect(resolution.modelName).toBe('model-b')
    expect(resolution.supportsTools).toBe(true)
  })

  it('requireTools：主/备用均 supports_tools=false → 如实返回 tools_unsupported', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '不支持工具的主渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true, supports_tools: false }],
    })
    const backup = createChannel({
      name: '不支持的备用渠道',
      provider_type: 'anthropic',
      base_url: 'https://backup.example',
      api_key: 'key-b',
      models: [{ id: 'm2', name: 'model-b', enabled: true, supports_tools: false }],
    })
    const resolution = resolveChannelEnv({ channelId: primary.id, category: 'mvp', projectId: 'p-tools', sessionId: 's-tools', requireTools: true })
    expect(resolution.env).toBeUndefined()
    expect(resolution.channel).toBeUndefined()
    expect(resolution.unusableReason).toBe('tools_unsupported')
  })

  it('requireTools：supports_tools 缺省（undefined）→ 放行走探测，不误判不支持', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '能力位未标注渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
    const resolution = resolveChannelEnv({ channelId: primary.id, category: 'mvp', projectId: 'p-tools', sessionId: 's-tools', requireTools: true })
    expect(resolution.channel?.id).toBe(primary.id)
    expect(resolution.modelName).toBe('model-a')
    expect(resolution.supportsTools).toBeUndefined()
  })

  it('回归：不传 requireTools 时行为不变（supports_tools=false 也不被过滤）', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '不带 requireTools 的主渠道',
      provider_type: 'anthropic',
      base_url: 'https://primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true, supports_tools: false }],
    })
    const resolution = resolveChannelEnv({ channelId: primary.id, category: 'mvp', projectId: 'p-tools', sessionId: 's-tools' })
    expect(resolution.channel?.id).toBe(primary.id)
    expect(resolution.modelName).toBe('model-a')
    expect(resolution.supportsTools).toBe(false)
    expect(resolution.unusableReason).toBeUndefined()
  })
})

describe('runtime channel fallback · 故障分类', () => {
  it('基础设施故障判定：429/5xx/529/401/403/网络错误为真，内容型与取消为假', () => {
    expect(isInfrastructureFailure(Object.assign(new Error('rate limited'), { statusCode: 429 }))).toBe(true)
    expect(isInfrastructureFailure(Object.assign(new Error('server'), { statusCode: 500 }))).toBe(true)
    expect(isInfrastructureFailure(Object.assign(new Error('overloaded'), { statusCode: 529 }))).toBe(true)
    expect(isInfrastructureFailure(Object.assign(new Error('unauthorized'), { statusCode: 401 }))).toBe(true)
    expect(isInfrastructureFailure(Object.assign(new Error('forbidden'), { statusCode: 403 }))).toBe(true)
    expect(isInfrastructureFailure(new Error('read ECONNRESET'))).toBe(true)
    // undici 网络失败：TypeError 'fetch failed' 包着 cause
    expect(isInfrastructureFailure(Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.example') }))).toBe(true)

    expect(isInfrastructureFailure(Object.assign(new Error('bad request'), { statusCode: 400 }))).toBe(false)
    expect(isInfrastructureFailure(new Error('PARSE_FAILED: 截断'))).toBe(false)
    expect(isInfrastructureFailure(new Error('AGENT_CANCELLED: 用户停止'))).toBe(false)
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    expect(isInfrastructureFailure(abortError)).toBe(false)
  })
})

describe('runtime channel fallback · 审查族 fallbackScope（闭环 PR4）', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-runtime-fallback-scope-'))
    resetChannelSwitchThrottleForTests()
    resetCategoryRoutingForTests()
  })

  afterEach(() => {
    process.env.PROMA_HOME = originalPromaHome
    resetCategoryRoutingForTests()
  })

  /** 主渠道 key-a 密钥不可解（模拟 safeStorage 密钥变更），其余渠道可用。 */
  function brokenPrimaryStorage(): void {
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => {
        const text = value.toString('utf8')
        if (text === 'enc:key-a') throw new Error('Error while decrypting the ciphertext')
        return text.replace(/^enc:/, '')
      },
    })
  }

  function seedJudgeChannels(): { primary: { id: string; name: string }; bystander: { id: string; name: string } } {
    brokenPrimaryStorage()
    const primary = createChannel({
      name: '审查主渠道',
      provider_type: 'anthropic',
      base_url: 'https://judge-primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
    const bystander = createChannel({
      name: '无关启用渠道',
      provider_type: 'anthropic',
      base_url: 'https://bystander.example',
      api_key: 'key-x',
      models: [{ id: 'mx', name: 'model-x', enabled: true }],
    })
    return { primary, bystander }
  }

  it("routed-only：无路由配置时不兜底全部启用渠道，如实 unusableReason（终审不落弱模型）", () => {
    const { primary, bystander } = seedJudgeChannels()
    expect(bystander.id).toBeTruthy() // 无关启用渠道存在，旧逻辑会兜到它

    const resolution = resolveChannelEnv({
      channelId: primary.id,
      category: 'prd',
      projectId: 'p-scope',
      sessionId: 's-scope-1',
      fallbackScope: 'routed-only',
    })
    expect(resolution.env).toBeUndefined()
    expect(resolution.channel).toBeUndefined()
    expect(resolution.unusableReason).toBe('decrypt_failed')
    // 没有切换发生：不落 runtime_channel_switch 决策行
    expect(readSystemLines('s-scope-1').filter((line) => line.includes('runtime_channel_switch'))).toHaveLength(0)
  })

  it('routed-only：路由配置的 fallback_channel_ids 命中 → 切配置域内备用，决策含 fallback_scope', () => {
    const { primary, bystander } = seedJudgeChannels()
    setCategoryRoutingForTests({ prd: { fallback_channel_ids: [bystander.id] } })

    const resolution = resolveChannelEnv({
      channelId: primary.id,
      category: 'prd',
      projectId: 'p-scope',
      sessionId: 's-scope-2',
      fallbackScope: 'routed-only',
    })
    expect(resolution.channel?.id).toBe(bystander.id)
    expect(resolution.modelName).toBe('model-x')

    const decision = readSystemLines('s-scope-2').find((line) => line.startsWith('[decision]') && line.includes('runtime_channel_switch'))
    expect(decision).toContain('无关启用渠道')
    expect(decision).toContain('routed-only')
  })

  it('routed-only：配置的备用也不可用 → 不兜底其它启用渠道（配置域内找不到就是找不到）', () => {
    const { primary } = seedJudgeChannels()
    // 配置一个同样密钥损坏的备用渠道 + 一个健康但未配置的旁观渠道
    const brokenBackup = createChannel({
      name: '坏密钥备用',
      provider_type: 'anthropic',
      base_url: 'https://broken-backup.example',
      api_key: 'key-broken',
      models: [{ id: 'mb', name: 'model-b', enabled: true }],
    })
    // brokenBackup 的密钥也解不开：切换 adapter 让 key-broken 也抛错
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => {
        const text = value.toString('utf8')
        if (text === 'enc:key-a' || text === 'enc:key-broken') throw new Error('Error while decrypting the ciphertext')
        return text.replace(/^enc:/, '')
      },
    })
    setCategoryRoutingForTests({ prd: { fallback_channel_ids: [brokenBackup.id] } })

    const resolution = resolveChannelEnv({
      channelId: primary.id,
      category: 'prd',
      projectId: 'p-scope',
      sessionId: 's-scope-3',
      fallbackScope: 'routed-only',
    })
    expect(resolution.env).toBeUndefined()
    expect(resolution.unusableReason).toBe('decrypt_failed')
  })

  it('回归：缺省与显式 all 均兜底全部启用渠道（现状不变）', () => {
    const { primary, bystander } = seedJudgeChannels()

    const byDefault = resolveChannelEnv({ channelId: primary.id, category: 'prd', projectId: 'p-scope', sessionId: 's-scope-4a' })
    expect(byDefault.channel?.id).toBe(bystander.id)

    const explicitAll = resolveChannelEnv({ channelId: primary.id, category: 'prd', projectId: 'p-scope', sessionId: 's-scope-4b', fallbackScope: 'all' })
    expect(explicitAll.channel?.id).toBe(bystander.id)
  })

  it('主渠道可用时 routed-only 零影响（备用链不触发，无切换决策）', () => {
    workingSafeStorage()
    const primary = createChannel({
      name: '健康审查主渠道',
      provider_type: 'anthropic',
      base_url: 'https://judge-primary.example',
      api_key: 'key-a',
      models: [{ id: 'm1', name: 'model-a', enabled: true }],
    })
    createChannel({
      name: '无关启用渠道',
      provider_type: 'anthropic',
      base_url: 'https://bystander.example',
      api_key: 'key-x',
      models: [{ id: 'mx', name: 'model-x', enabled: true }],
    })

    const resolution = resolveChannelEnv({
      channelId: primary.id,
      category: 'prd',
      projectId: 'p-scope',
      sessionId: 's-scope-5',
      fallbackScope: 'routed-only',
    })
    expect(resolution.channel?.id).toBe(primary.id)
    expect(resolution.modelName).toBe('model-a')
    expect(readSystemLines('s-scope-5').filter((line) => line.includes('runtime_channel_switch'))).toHaveLength(0)
  })
})

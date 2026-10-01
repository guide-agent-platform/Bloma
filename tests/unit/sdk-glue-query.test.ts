import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * queryWithRuntimeFallback 传输层行为锁（2026-10-01 补齐——web 线刀1 退役 orchestrator
 * 流式组后，providers 查询之上的 T9 回退包裹层一度无直测）。
 * 分类判定（isInfrastructureFailure/isUserCancelledQuery/extractErrorStatusCode）与
 * 渠道路由（readFallbackContext/pickBackupChannelEnv）由 runtime-fallback.test.ts 锁；
 * 本文件只锁包裹层的分支映射与备用渠道参数重派生。
 */

const h = vi.hoisted(() => ({
  providersQuery: vi.fn(),
  readFallbackContext: vi.fn(),
  pickBackupChannelEnv: vi.fn(),
  isInfrastructureFailure: vi.fn(),
  isUserCancelledQuery: vi.fn(),
  extractErrorStatusCode: vi.fn(),
  recordChannelSwitch: vi.fn(),
  resolveChannelEnv: vi.fn(),
}))

vi.mock('../../main/platform/upstream/providers/loop-query', () => ({
  anthropicMessagesQueryViaProviders: (prompt: string, options: unknown) => h.providersQuery(prompt, options),
}))

vi.mock('../../main/platform/llm/runtime-fallback', () => ({
  readFallbackContext: h.readFallbackContext,
  pickBackupChannelEnv: h.pickBackupChannelEnv,
  isInfrastructureFailure: h.isInfrastructureFailure,
  isUserCancelledQuery: h.isUserCancelledQuery,
  extractErrorStatusCode: h.extractErrorStatusCode,
  recordChannelSwitch: h.recordChannelSwitch,
  resolveChannelEnv: h.resolveChannelEnv,
}))

import { sdkQuery } from '../../main/orchestration/stages/sdk-glue'
import type { SDKQueryOptions } from '../../main/orchestration/stages/orchestration-contracts'
import type { SDKMessage } from '../../shared/types'

const assistantMsg = (text: string): SDKMessage => ({
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text }] },
})

function opts(): SDKQueryOptions {
  return {
    env: { ANTHROPIC_AUTH_TOKEN: 'primary-key' },
    signal: new AbortController().signal,
    sessionId: 'session-query-1',
    maxTokens: 16384,
    providerType: 'standard',
  }
}

const fakeContext = { channelId: 'primary', category: 'generation' as const, projectId: 'p1', sessionId: 's1' }
const fakeBackup = {
  env: { ANTHROPIC_AUTH_TOKEN: 'backup-key' },
  channel: { max_tokens: 8192, provider_type: 'token_plan' },
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  h.isUserCancelledQuery.mockReturnValue(false)
  h.isInfrastructureFailure.mockReturnValue(true)
  h.extractErrorStatusCode.mockReturnValue(undefined)
  h.readFallbackContext.mockReturnValue(undefined)
  h.pickBackupChannelEnv.mockReturnValue(undefined)
})

async function collect(gen: AsyncIterable<SDKMessage>): Promise<SDKMessage[]> {
  const out: SDKMessage[] = []
  for await (const msg of gen) out.push(msg)
  return out
}

describe('queryWithRuntimeFallback：正常路径', () => {
  it('providers 消息流原样透传（SSE 序：system → assistant → result），零回退副作用', async () => {
    h.providersQuery.mockImplementation(async function* () {
      yield { type: 'system', subtype: 'init' }
      yield assistantMsg('你好')
      yield { type: 'result' }
    })
    const out = await collect(sdkQuery('测试', opts()))
    expect(out.map((m) => m.type)).toEqual(['system', 'assistant', 'result'])
    expect(out[1].message?.content[0]).toMatchObject({ type: 'text', text: '你好' })
    expect(h.recordChannelSwitch).not.toHaveBeenCalled()
    expect(h.pickBackupChannelEnv).not.toHaveBeenCalled()
  })
})

describe('queryWithRuntimeFallback：回退分支（首 assistant 字节前）', () => {
  it('基础设施失败 → 切备用渠道：env/maxTokens/providerType 重派生 + recordChannelSwitch 留痕 + 备份结果透传', async () => {
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.pickBackupChannelEnv.mockReturnValue(fakeBackup)
    h.extractErrorStatusCode.mockReturnValue(503)
    h.providersQuery
      .mockImplementationOnce(async function* () {
        yield { type: 'system', subtype: 'init' } // system 不算首字节：仍可回退
        throw Object.assign(new Error('SDK request failed with 503'), { statusCode: 503 })
      })
      .mockImplementationOnce(async function* () {
        yield assistantMsg('备用渠道回答')
        yield { type: 'result' }
      })

    const out = await collect(sdkQuery('测试', opts()))

    // 首次半截流已透出的 system 保留，backup 消息接续
    expect(out.map((m) => m.type)).toEqual(['system', 'assistant', 'result'])
    expect(h.recordChannelSwitch).toHaveBeenCalledWith({
      context: fakeContext,
      reason: 'http_503',
      to: fakeBackup,
      statusCode: 503,
    })
    // 备用渠道参数三重重派生（maxTokens 上限差异 / providerType omit 防陈旧判定）
    const secondCallOptions = h.providersQuery.mock.calls[1][1] as SDKQueryOptions
    expect(secondCallOptions.env).toBe(fakeBackup.env)
    expect(secondCallOptions.maxTokens).toBe(8192)
    expect(secondCallOptions.providerType).toBe('token_plan')
    expect(h.providersQuery).toHaveBeenCalledTimes(2)
  })

  it('网络级失败（无状态码）→ reason=network_error 回退', async () => {
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.pickBackupChannelEnv.mockReturnValue(fakeBackup)
    h.extractErrorStatusCode.mockReturnValue(undefined)
    h.providersQuery
      .mockImplementationOnce(async function* () {
        throw new Error('fetch failed: socket hang up')
      })
      .mockImplementationOnce(async function* () {
        yield assistantMsg('备用')
      })
    const out = await collect(sdkQuery('测试', opts()))
    expect(out).toHaveLength(1)
    expect(h.recordChannelSwitch).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'network_error', statusCode: undefined }),
    )
  })

  it('无 fallback context（env 未带渠道标记）→ 原样抛不回退', async () => {
    h.readFallbackContext.mockReturnValue(undefined)
    h.providersQuery.mockImplementation(async function* () {
      throw new Error('socket hang up')
    })
    await expect(collect(sdkQuery('测试', opts()))).rejects.toThrow('socket hang up')
    expect(h.recordChannelSwitch).not.toHaveBeenCalled()
  })

  it('有 context 但无可用备用渠道 → 原样抛', async () => {
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.pickBackupChannelEnv.mockReturnValue(undefined)
    h.providersQuery.mockImplementation(async function* () {
      throw new Error('socket hang up')
    })
    await expect(collect(sdkQuery('测试', opts()))).rejects.toThrow('socket hang up')
    expect(h.recordChannelSwitch).not.toHaveBeenCalled()
  })
})

describe('queryWithRuntimeFallback：绝不回退分支', () => {
  it('assistant 首字节已发出后失败 → 原样抛（重试会产生重复半截回复）', async () => {
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.pickBackupChannelEnv.mockReturnValue(fakeBackup)
    h.providersQuery.mockImplementation(async function* () {
      yield assistantMsg('半截回答')
      throw Object.assign(new Error('SDK request failed with 500'), { statusCode: 500 })
    })
    await expect(collect(sdkQuery('测试', opts()))).rejects.toThrow('500')
    expect(h.pickBackupChannelEnv).not.toHaveBeenCalled()
    expect(h.recordChannelSwitch).not.toHaveBeenCalled()
    expect(h.providersQuery).toHaveBeenCalledTimes(1)
  })

  it('用户主动取消（AbortError/AGENT_CANCELLED）→ 不是故障，原样抛不切渠道', async () => {
    h.isUserCancelledQuery.mockReturnValue(true)
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.providersQuery.mockImplementation(async function* () {
      throw new Error('This operation was aborted')
    })
    await expect(collect(sdkQuery('测试', opts()))).rejects.toThrow('aborted')
    expect(h.pickBackupChannelEnv).not.toHaveBeenCalled()
  })

  it('请求级失败（400 等非基础设施类）→ 原样抛不回退', async () => {
    h.isInfrastructureFailure.mockReturnValue(false)
    h.extractErrorStatusCode.mockReturnValue(400)
    h.readFallbackContext.mockReturnValue(fakeContext)
    h.providersQuery.mockImplementation(async function* () {
      throw Object.assign(new Error('SDK request failed with 400'), { statusCode: 400 })
    })
    await expect(collect(sdkQuery('测试', opts()))).rejects.toThrow('400')
    expect(h.pickBackupChannelEnv).not.toHaveBeenCalled()
    expect(h.providersQuery).toHaveBeenCalledTimes(1)
  })
})

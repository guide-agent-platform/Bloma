/**
 * Provider Qualification 单测（批9 工件6.3，2026-10-07）：
 * 渠道/fetch 全注入——零真实 LLM 调用（测试预算护栏本身）。
 * 覆盖：llm_role=none 跳过；声明缺失/坏 schema 如实降级；渠道不可用 skip；
 * openai/anthropic 两形态真实调用判定（成功/HTTP 4xx/重试预算≤2）；幂等短路。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../main/platform/llm/runtime-fallback', () => ({
  resolveChannelEnv: vi.fn(),
}))

import {
  runProviderQualification,
  parseLlmDeclaration,
  LLM_QUALIFICATION_REL,
} from '../../../main/desktop/provider-qualification'
import { resolveChannelEnv } from '../../../main/platform/llm/runtime-fallback'

const mockedResolve = vi.mocked(resolveChannelEnv)

function channelEnv(overrides: Record<string, string> = {}) {
  return {
    env: {
      ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-key',
      ANTHROPIC_MODEL: 'glm-test',
      ANTHROPIC_PROVIDER_TYPE: 'openai',
      ...overrides,
    },
    channel: { id: 'ch1', name: 'test' },
  }
}

const DECL = JSON.stringify({
  schema_version: 1,
  provider: 'openai_compatible',
  auth: 'user_config',
  request_sample: { messages: [{ role: 'user', content: '你好' }] },
})

function makeOpts(overrides: Record<string, unknown> = {}) {
  const written: Record<string, string> = {}
  return {
    projectId: 'proj-1',
    sessionId: 'sess-1',
    sandboxRoot: 'C:/sandbox',
    llmRole: 'core' as const,
    fetchImpl: vi.fn(),
    readDeclaration: vi.fn(() => DECL),
    readPriorResult: vi.fn(() => undefined),
    writeResult: (rel: string, content: string) => {
      written[rel] = content
    },
    written,
    ...overrides,
  }
}

beforeEach(() => {
  mockedResolve.mockReset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('parseLlmDeclaration', () => {
  it('合法声明 schema 通过；messages 脏结构判不合法', () => {
    expect(parseLlmDeclaration(DECL).schemaValid).toBe(true)
    expect(parseLlmDeclaration('{"request_sample":{"messages":[]}}').schemaValid).toBe(false)
    expect(parseLlmDeclaration('not json').schemaValid).toBe(false)
    expect(parseLlmDeclaration(undefined).schemaValid).toBe(false)
    expect(
      parseLlmDeclaration('{"request_sample":{"messages":[{"role":"user","content":""}]}}').schemaValid,
    ).toBe(false)
  })
})

describe('runProviderQualification', () => {
  it('llm_role=none → 跳过（不执行不调用）', async () => {
    const opts = makeOpts({ llmRole: 'none' })
    const outcome = await runProviderQualification(opts)
    expect(outcome.executed).toBe(false)
    expect(outcome.skipped_reason).toContain('llm_role=none')
    expect(opts.fetchImpl).not.toHaveBeenCalled()
  })

  it('声明缺失 → executed + qualified=false + findings 如实（不冒充验证过）', async () => {
    const opts = makeOpts({ readDeclaration: vi.fn(() => undefined) })
    const outcome = await runProviderQualification(opts)
    expect(outcome.executed).toBe(true)
    expect(outcome.qualified).toBe(false)
    expect(outcome.request_schema_valid).toBe(false)
    expect(outcome.findings[0]).toContain('llm-provider.json')
    expect(opts.written[LLM_QUALIFICATION_REL]).toContain('qualified')
  })

  it('渠道不可用 → skip 留痕（真实验证缺位如实呈现）', async () => {
    mockedResolve.mockReturnValue({ env: undefined, channel: undefined, unusableReason: 'no_channel' })
    const opts = makeOpts()
    const outcome = await runProviderQualification(opts)
    expect(outcome.executed).toBe(false)
    expect(outcome.skipped_reason).toContain('渠道不可用')
    expect(opts.fetchImpl).not.toHaveBeenCalled()
  })

  it('openai 形态 2xx + choices 结构 → qualified（真实调用 1 次）', async () => {
    mockedResolve.mockReturnValue(channelEnv() as never)
    const opts = makeOpts()
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: '你好！' } }] }),
    })
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(true)
    expect(outcome.calls).toBe(1)
    expect(outcome.channel_base_host).toBe('api.example.com')
    expect(opts.fetchImpl).toHaveBeenCalledTimes(1)
    // 请求体按产物声明 schema 构造（messages 来自 request_sample）
    const call = (opts.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    const body = JSON.parse(call[1].body)
    expect(body.messages[0].content).toBe('你好')
    expect(body.model).toBe('glm-test')
  })

  it('anthropic 形态：base 无 /v1 时正确拼 /v1/messages（陷阱 12 回归锁）', async () => {
    mockedResolve.mockReturnValue(
      channelEnv({
        ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
        ANTHROPIC_PROVIDER_TYPE: 'anthropic',
      }) as never,
    )
    const opts = makeOpts()
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: '你好' }] }),
    })
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(true)
    const url = (opts.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(String(url)).toBe('https://open.bigmodel.cn/api/anthropic/v1/messages')
  })

  it('anthropic 形态：openai 惯例 system 首条剥为顶层 system 字段（批9.5 审核修正）', async () => {
    mockedResolve.mockReturnValue(
      channelEnv({ ANTHROPIC_PROVIDER_TYPE: 'anthropic' }) as never,
    )
    const opts = makeOpts()
    opts.readDeclaration = vi.fn(() =>
      JSON.stringify({
        schema_version: 1,
        provider: 'openai_compatible',
        request_sample: {
          messages: [
            { role: 'system', content: '你是一个助手' },
            { role: 'user', content: '你好' },
          ],
        },
      }),
    )
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ content: [{ type: 'text', text: '你好！' }] }),
    })
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(true)
    const body = JSON.parse((opts.fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.system).toBe('你是一个助手')
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user'])
  })

  it('HTTP 401 不重试（4xx 无意义重试）；预算=1 次调用', async () => {
    mockedResolve.mockReturnValue(channelEnv() as never)
    const opts = makeOpts()
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'invalid api key' }),
    })
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(false)
    expect(outcome.calls).toBe(1)
    expect(outcome.findings[0]).toContain('HTTP 401')
  })

  it('网络异常重试一次（预算护栏 ≤2）后如实降级', async () => {
    mockedResolve.mockReturnValue(channelEnv() as never)
    const opts = makeOpts()
    opts.fetchImpl = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(false)
    expect(outcome.calls).toBe(2)
    expect(opts.fetchImpl).toHaveBeenCalledTimes(2)
    expect(outcome.findings[0]).toContain('未通过')
  })

  it('2xx 但响应结构无内容块 → qualified=false（schema 疑似不匹配）', async () => {
    mockedResolve.mockReturnValue(channelEnv() as never)
    const opts = makeOpts()
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ unexpected: true }),
    })
    const outcome = await runProviderQualification(opts)
    expect(outcome.qualified).toBe(false)
    expect(outcome.findings[0]).toContain('不含内容块')
  })

  it('幂等短路：已 qualified 的重跑直接返回上次结果（不再消耗预算）', async () => {
    mockedResolve.mockReturnValue(channelEnv() as never)
    let prior: string | undefined
    const opts = makeOpts()
    opts.readPriorResult = vi.fn(() => prior)
    opts.fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
    })
    opts.writeResult = (rel: string, content: string) => {
      prior = content
    }
    await runProviderQualification(opts)
    expect(opts.fetchImpl).toHaveBeenCalledTimes(1)
    const outcome2 = await runProviderQualification(opts)
    expect(outcome2.qualified).toBe(true)
    expect(opts.fetchImpl).toHaveBeenCalledTimes(1) // 短路：无第二次真实调用
  })
})

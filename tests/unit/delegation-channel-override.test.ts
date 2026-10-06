import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKMessage } from '../../shared/types'
import type { SDKQuery } from '../../main/orchestration/orchestrator'
import { createToolState, type ToolContext } from '../../main/agent/loop/agent-loop'
import {
  getChannelByIdRaw,
  listChannels,
  decryptApiKey,
} from '../../main/platform/llm/channel-manager'
import type { Channel } from '../../shared/types'
import {
  DelegationChannelError,
  resolveDelegationChannelOverride,
} from '../../main/agent/delegation/delegation-channel'
import {
  disposeParentDelegationState,
  findDelegation,
  getDelegationSummary,
  listDelegations,
  registerParentLoopContext,
  setChildToolsBuilder,
  startDelegation,
  unregisterParentLoopContext,
  waitForDelegations,
} from '../../main/agent/delegation/agent-collaboration'

vi.mock('../../main/platform/llm/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/platform/llm/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: vi.fn(),
    listChannels: vi.fn(() => [] as Channel[]),
    decryptApiKey: vi.fn(() => 'sk-plain-test'),
  }
})

/**
 * C1 委派渠道覆盖单测（协作机制改造清单，2026-09-24）。
 *
 * 锁定：
 * - channelId 缺省 → null（继承父渠道，零行为变化）
 * - 显式渠道+模型 → 专属 env（AUTH_TOKEN/MODEL/BASE_URL 换轨，query 函数不变）
 * - 跨渠道未传 modelId → 自动选首个 supports_tools !== false 的已启用模型
 * - 拒绝必教育：渠道不存在/禁用、模型未启用、不支持工具、密钥不可解四类失败均带可用清单与正确动作
 * - startDelegation 集成腿：record/summary 携带渠道摘要，子 loop 实际收到覆盖 env
 */

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'zhipu-main',
    name: '智谱',
    provider_type: 'zhipu',
    base_url: 'https://zhipu.example/api',
    api_key: 'encrypted-hex',
    enabled: true,
    models: [
      { id: 'glm-5.3', name: 'GLM-5.3', enabled: true },
      { id: 'glm-5.2', name: 'GLM-5.2', enabled: false },
      { id: 'glm-4.6v', name: 'GLM-4.6V', enabled: true, supports_tools: false },
    ],
    ...overrides,
  }
}

function textMessage(text: string): SDKMessage {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
}

function oneShotQuery(): SDKQuery {
  return async function* () {
    yield textMessage('子任务完成')
    yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
  }
}

let parentSessionId = 'session-c1'

function parentContext(): ToolContext {
  return {
    projectId: 'project-c1',
    sessionId: parentSessionId,
    requestId: 'req-c1',
    signal: new AbortController().signal,
    state: createToolState(0),
  }
}

describe('C1 委派渠道覆盖解析', () => {
  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-c1-'))
    parentSessionId = `session-c1-${Date.now()}-${Math.random().toString(36).slice(2)}`
    vi.mocked(getChannelByIdRaw).mockReset()
    vi.mocked(listChannels).mockReset().mockReturnValue([])
    vi.mocked(decryptApiKey).mockReset().mockReturnValue('sk-plain-test')
  })
  afterEach(() => {
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
    vi.mocked(getChannelByIdRaw).mockRestore
  })

  it('channelId 缺省 → null（继承父渠道，零行为变化）', () => {
    expect(resolveDelegationChannelOverride({})).toBeNull()
    expect(resolveDelegationChannelOverride({ channelId: '  ' })).toBeNull()
    expect(getChannelByIdRaw).not.toHaveBeenCalled()
  })

  it('有效渠道 + 显式模型名 → 专属 env（token/model/base_url 换轨）', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(makeChannel())

    const override = resolveDelegationChannelOverride({ channelId: 'zhipu-main', modelId: 'GLM-5.3' })
    expect(override).not.toBeNull()
    expect(override!.env.ANTHROPIC_AUTH_TOKEN).toBe('sk-plain-test')
    expect(override!.env.ANTHROPIC_MODEL).toBe('GLM-5.3')
    expect(String(override!.env.ANTHROPIC_BASE_URL)).toContain('https://zhipu.example/api')
    expect(override!.channelName).toBe('智谱')
    expect(override!.providerType).toBe('zhipu')
  })

  it('短名解析（2026-10-06 对称化）：id 查不到时按渠道名精确匹配已启用渠道——编排器写 glm/kimi 短名不再空转', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(undefined)
    vi.mocked(listChannels).mockReturnValue([makeChannel()])

    const override = resolveDelegationChannelOverride({ channelId: '智谱', modelId: 'GLM-5.3' })
    expect(override).not.toBeNull()
    expect(override!.channelName).toBe('智谱')
    expect(override!.env.ANTHROPIC_MODEL).toBe('GLM-5.3')
  })

  it('短名解析：未启用/不存在仍拒必教育（列出 name(id) 清单）', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(undefined)
    vi.mocked(listChannels).mockReturnValue([makeChannel({ enabled: false })])

    expect(() => resolveDelegationChannelOverride({ channelId: '智谱' })).toThrow(DelegationChannelError)
    expect(() => resolveDelegationChannelOverride({ channelId: '智谱' })).toThrow(/接受完整 id 或渠道名/)
  })

  it('跨渠道未传 modelId → 自动选首个支持工具的已启用模型（跳过禁用与不支持工具项）', () => {
    const channel = makeChannel({
      models: [
        { id: 'm1', name: 'Model-NoTools', enabled: true, supports_tools: false },
        { id: 'm2', name: 'Model-OK', enabled: true },
        { id: 'm3', name: 'Model-Disabled', enabled: false },
      ],
    })
    vi.mocked(getChannelByIdRaw).mockReturnValue(channel)

    const override = resolveDelegationChannelOverride({ channelId: 'zhipu-main' })
    expect(override!.modelName).toBe('Model-OK')
  })

  it('渠道不存在/禁用 → 教育文案列出可用渠道', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(undefined)
    vi.mocked(listChannels).mockReturnValue([makeChannel()])

    expect(() => resolveDelegationChannelOverride({ channelId: 'nope' })).toThrow(DelegationChannelError)
    try {
      resolveDelegationChannelOverride({ channelId: 'nope' })
      expect.unreachable('应抛错')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('nope')
      expect(message).toContain('智谱(zhipu-main)')
      expect(message).toContain('去掉 channelId')
    }

    vi.mocked(getChannelByIdRaw).mockReturnValue(makeChannel({ enabled: false }))
    expect(() => resolveDelegationChannelOverride({ channelId: 'zhipu-main' })).toThrow(DelegationChannelError)
  })

  it('模型未启用 → 教育文案列出该渠道已启用模型', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(makeChannel())

    try {
      resolveDelegationChannelOverride({ channelId: 'zhipu-main', modelId: 'GLM-5.2' })
      expect.unreachable('应抛错')
    } catch (error) {
      const message = (error as Error).message
      expect(message).toContain('GLM-5.2')
      expect(message).toContain('GLM-5.3')
      expect(message).not.toContain('GLM-5.2、')  // 已启用清单不含禁用模型自身
    }
  })

  it('显式指定不支持工具的模型 → 拒绝并说明原因', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(makeChannel())

    expect(() =>
      resolveDelegationChannelOverride({ channelId: 'zhipu-main', modelId: 'GLM-4.6V' }),
    ).toThrow(/不支持工具调用/)
  })

  it('密钥不可解 → 渠道密钥文案指引重存 Key', () => {
    vi.mocked(getChannelByIdRaw).mockReturnValue(makeChannel())
    vi.mocked(decryptApiKey).mockImplementation(() => {
      throw new Error('safeStorage decrypt failed')
    })

    expect(() => resolveDelegationChannelOverride({ channelId: 'zhipu-main' })).toThrow(/密钥不可解/)
  })
})

describe('C1 startDelegation 集成', () => {
  const originalPromaHome = process.env.PROMA_HOME

  /** 捕获子 loop 实际收到的 env（query 的 options.env 由 runAgentLoop 传入）。 */
  let capturedEnv: Record<string, string> | undefined

  beforeEach(() => {
    process.env.PROMA_HOME = mkdtempSync(join(tmpdir(), 'bloma-c1-int-'))
    parentSessionId = `session-c1-int-${Date.now()}-${Math.random().toString(36).slice(2)}`
    capturedEnv = undefined
    vi.mocked(getChannelByIdRaw).mockReset().mockReturnValue(makeChannel())
    vi.mocked(listChannels).mockReset().mockReturnValue([])
    vi.mocked(decryptApiKey).mockReset().mockReturnValue('sk-plain-test')
    setChildToolsBuilder(() => [])
    const probeQuery: SDKQuery = async function* (_prompt, options) {
      capturedEnv = options.env
      yield textMessage('子任务完成')
      yield { type: 'result', subtype: 'success', stop_reason: 'end_turn' }
    }
    registerParentLoopContext(parentSessionId, {
      query: probeQuery,
      env: { ANTHROPIC_MODEL: 'parent-model', ANTHROPIC_AUTH_TOKEN: 'parent-token' },
      maxTokens: 256,
      maxTurns: 6,
      delegationMaxTurns: 4,
      permissionMode: 'allow-all',
      temperature: 0.5,
      system: '父系统提示',
      editFormat: 'diff',
      publish: () => undefined,
    })
  })
  afterEach(() => {
    disposeParentDelegationState(parentSessionId)
    unregisterParentLoopContext(parentSessionId)
    if (originalPromaHome === undefined) delete process.env.PROMA_HOME
    else process.env.PROMA_HOME = originalPromaHome
  })

  it('带 channelId 的委派：子 loop 收到覆盖 env，summary 携带渠道摘要；完成后完结', async () => {
    const created = startDelegation(parentContext(), {
      task: '用异族模型复查产出',
      role: 'research',
      channelId: 'zhipu-main',
      modelId: 'GLM-5.3',
    })
    expect(created.delegation_id).toBeTruthy()

    const record = findDelegation(parentSessionId, created.delegation_id)
    expect(record?.channelOverride?.channelName).toBe('智谱')
    expect(record?.channelOverride?.env.ANTHROPIC_MODEL).toBe('GLM-5.3')

    const summaries = await waitForDelegations(parentContext(), {
      delegationIds: [created.delegation_id],
      timeout_ms: 3000,
    })
    expect(summaries[0]?.status).toBe('completed')
    expect(summaries[0]?.channel).toBe('智谱/GLM-5.3')

    // 子 loop 的 query 收到的是覆盖 env（而非父 env 的 parent-model）
    expect(capturedEnv?.ANTHROPIC_MODEL).toBe('GLM-5.3')
    expect(capturedEnv?.ANTHROPIC_AUTH_TOKEN).toBe('sk-plain-test')
  })

  it('无 channelId 的委派：子 loop 仍收到父 env（零行为变化回归腿）', async () => {
    const created = startDelegation(parentContext(), {
      task: '同渠道子任务',
      role: 'explore',
    })
    await waitForDelegations(parentContext(), { delegationIds: [created.delegation_id], timeout_ms: 3000 })
    expect(capturedEnv?.ANTHROPIC_MODEL).toBe('parent-model')
    expect(getDelegationSummary(findDelegation(parentSessionId, created.delegation_id)!).channel).toBeUndefined()
  })
})

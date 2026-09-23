import { describe, expect, it, vi, afterEach } from 'vitest'
import { autoNameProject, deriveFallbackName } from '../../main/coding/programming-orchestrator'
import type { SDKMessage } from '../../shared/types'

const { findProjectMock, updateProjectMock, readPrimaryIntentMock, readPrdBackplaneMock } = vi.hoisted(() => ({
  findProjectMock: vi.fn(),
  updateProjectMock: vi.fn(() => ({})),
  readPrimaryIntentMock: vi.fn((): string | undefined => undefined),
  readPrdBackplaneMock: vi.fn(() => ({
    project_id: 'project-name',
    name: '帮我做个东西',
    positioning: '一个家庭记账工具',
    requirements: [
      { id: 'F-001', description: '记录每日收支' },
      { id: 'F-002', description: '按月汇总统计' },
    ],
    acceptance: {},
    out_of_scope: [],
    assumptions: [],
  })),
}))

vi.mock('../../main/channel-manager', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/channel-manager')>()
  return {
    ...actual,
    getChannelByIdRaw: () => ({
      id: 'test-channel',
      name: 'Test',
      provider_type: 'anthropic',
      base_url: 'https://api.anthropic.com',
      api_key: 'encrypted-test-key',
      models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
      enabled: true,
    }),
    decryptApiKey: () => 'test-key-from-channel',
    getFirstEnabledChannel: () => undefined,
  }
})

vi.mock('../../main/project-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/project-service')>()
  return { ...actual, findProject: findProjectMock, updateProject: updateProjectMock }
})

vi.mock('../../main/document-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/document-engine')>()
  return { ...actual, readPrdBackplane: readPrdBackplaneMock }
})

vi.mock('../../main/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/session-service')>()
  return { ...actual, readPrimaryIntent: readPrimaryIntentMock }
})

function assistantTextQuery(text: string) {
  return async function* (_prompt: string): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }
  }
}

function makeInput(query?: (prompt: string) => AsyncGenerator<SDKMessage>) {
  return {
    request_id: 'req-name',
    session_id: 'session-name',
    project_id: 'project-name',
    mode: 'quick' as const,
    channel_id: 'test-channel',
    query,
  }
}

afterEach(() => {
  vi.clearAllMocks()
  updateProjectMock.mockReturnValue({})
})

/**
 * 需求确认后自动命名（autoNameProject）：
 * - LLM 按 PRD 背板起名，产出清洗（引号/多行/截断）后落盘并标记 auto_named；
 * - LLM 不可用/产出不合格 → 首句口述确定性剥前缀兜底；
 * - auto_named 标记防止二次生成时覆盖（含未来手动改名）。
 */
describe('deriveFallbackName 口述前缀剥离', () => {
  it('循环剥离组合前缀：帮我制作一个计算器 → 计算器', () => {
    expect(deriveFallbackName('帮我制作一个计算器')).toBe('计算器')
  })

  it('我要音乐合成器 → 音乐合成器（我要 前缀）', () => {
    expect(deriveFallbackName('我要音乐合成器')).toBe('音乐合成器')
  })

  it('剥掉收尾语气标点，超长截断到 12 字', () => {
    expect(deriveFallbackName('做一个倒计时提醒！')).toBe('倒计时提醒')
    expect(deriveFallbackName('帮我做个购物清单，')).toBe('购物清单')
    expect(deriveFallbackName('做一个特别特别特别特别特别特别特别长的名字')).toHaveLength(12)
  })

  it('剥完为空返回 null（如整句都是前缀）', () => {
    expect(deriveFallbackName('帮我')).toBeNull()
    expect(deriveFallbackName('')).toBeNull()
  })
})

describe('autoNameProject 自动命名', () => {
  it('LLM 起名成功：清洗后落盘并标记 auto_named', async () => {
    findProjectMock.mockReturnValue({ project_id: 'project-name', name: '帮我做个东西' })
    const query = vi.fn(assistantTextQuery('「家庭记账本」'))

    await autoNameProject(makeInput(query))

    expect(query).toHaveBeenCalledTimes(1)
    // 喂给模型的上下文含 PRD 定位与核心功能，不含引号包裹的旧名
    const prompt = query.mock.calls[0][0] as string
    expect(prompt).toContain('家庭记账工具')
    expect(prompt).toContain('记录每日收支')
    expect(updateProjectMock).toHaveBeenCalledWith('project-name', { name: '家庭记账本', auto_named: true })
  })

  it('LLM 产出多行解释（不合格）→ 首句口述兜底', async () => {
    findProjectMock.mockReturnValue({ project_id: 'project-name', name: '帮我做个东西' })
    readPrimaryIntentMock.mockReturnValue('帮我制作一个计算器')

    await autoNameProject(makeInput(vi.fn(assistantTextQuery('好的，我建议命名为：\n计算器助手工具'))))

    expect(updateProjectMock).toHaveBeenCalledWith('project-name', { name: '计算器', auto_named: true })
  })

  it('LLM 抛错不阻断：静默走兜底', async () => {
    findProjectMock.mockReturnValue({ project_id: 'project-name', name: '帮我做个东西' })
    readPrimaryIntentMock.mockReturnValue('我想做一个模拟钢琴')
    const query = vi.fn(async function* (): AsyncGenerator<SDKMessage> {
      throw new Error('network down')
      yield { type: 'assistant' }
    })

    await autoNameProject(makeInput(query))

    expect(updateProjectMock).toHaveBeenCalledWith('project-name', { name: '模拟钢琴', auto_named: true })
  })

  it('auto_named 已标记：不再命名（保护用户手动改名）', async () => {
    findProjectMock.mockReturnValue({ project_id: 'project-name', name: '我的收藏名', auto_named: true })
    const query = vi.fn(assistantTextQuery('新名字'))

    await autoNameProject(makeInput(query))

    expect(query).not.toHaveBeenCalled()
    expect(updateProjectMock).not.toHaveBeenCalled()
  })

  it('无 query 句柄：直接走兜底；兜底也为空时只落标记', async () => {
    findProjectMock.mockReturnValue({ project_id: 'project-name', name: '帮我' })
    readPrimaryIntentMock.mockReturnValue('帮我')

    await autoNameProject(makeInput())

    expect(updateProjectMock).toHaveBeenCalledWith('project-name', { auto_named: true })
  })
})

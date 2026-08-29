import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { resolvePrdBackplane } from '../../main/programming-orchestrator'
import { generatePrdLlm } from '../../main/prd-engine-llm'
import { enrichRequirementsLlm, mergeEnrichment, type EnrichedSketchRequirement } from '../../main/requirement-enricher'
import { createChannel } from '../../main/channel-manager'
import { setSafeStorageAdapter } from '../../main/safe-storage'
import { createProject, recordSketchGenerated } from '../../main/project-service'
import { getAgentSessionPath } from '../../storage/config-paths'
import { appendJsonLine } from '../../storage/json-store'
import type { Channel, SDKMessage } from '../../shared/types'
import type { MvpTaskInput } from '../../main/programming-orchestrator'
import type { SDKQuery } from '../../main/orchestrator'
import type { PrdBackplane, SketchRequirement } from '../../main/sketch-engine'

/**
 * 功能项加厚（2026-08-18 设计 §5 编排器测试计划）：resolvePrdBackplane 并行两路
 * （generatePrdLlm + enrichRequirementsLlm）+ 三层守卫并入 + 兜底链。
 *
 * - LLM 函数整体 mock（importOriginal + spread 保留真实实现，逐个用例覆盖），真实
 *   mergeEnrichment 为默认实现；合并/守卫细节由 requirement-enricher.test.ts 覆盖；
 * - 渠道用真实 channel-manager（createChannel + safeStorage 适配器），满足「enabled
 *   model 约束」且不脆断；max_tokens 从渠道配置传导到两路 LLM 调用；
 * - 任何失败路径一律降级、绝不阻断主链路（模板 / 冻结清单）。
 */

const FROZEN: SketchRequirement[] = [
  { id: 'F-001', description: '做一个家庭记账本' },
  { id: 'F-002', description: '展示本月结余' },
]

const ENRICHED: EnrichedSketchRequirement[] = [
  {
    id: 'F-001',
    story: '作为用户，我想记录收支，以便月底看结余',
    behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }],
    priority: 'P0',
  },
  {
    id: 'F-002',
    story: '作为用户，我想看结余',
    behavior_assertions: [{ assertion: '点击刷新按钮→结余数字变化', source: '月底看结余' }],
    priority: 'P1',
  },
]

vi.mock('../../main/prd-engine-llm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/prd-engine-llm')>()
  return { ...actual, generatePrdLlm: vi.fn() }
})

vi.mock('../../main/requirement-enricher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/requirement-enricher')>()
  return {
    ...actual,
    enrichRequirementsLlm: vi.fn(),
    // 默认委托真实合并实现；单个用例用 mockImplementationOnce 注入抛错
    mergeEnrichment: vi.fn((frozen, enriched, existing, userTexts) => actual.mergeEnrichment(frozen, enriched, existing, userTexts)),
  }
})

const originalPromaHome = process.env.PROMA_HOME
let home: string | undefined
let channelId: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  restorePromaHome(originalPromaHome)
  home = undefined
  channelId = undefined
})

/** 真实渠道（enabled model + max_tokens）+ 真实项目 + 已冻结草图需求。 */
function setup(prefix: string): { project_id: string; session_id: string } {
  home = mkdtempSync(join(tmpdir(), prefix))
  process.env.PROMA_HOME = home
  setSafeStorageAdapter({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
  })
  const channel: Channel = createChannel({
    name: 'Test Channel',
    provider_type: 'anthropic',
    base_url: 'https://api.anthropic.com',
    api_key: 'test-key',
    models: [{ id: 'claude-sonnet-4-6', name: 'Claude', enabled: true }],
    max_tokens: 4096,
  })
  channelId = channel.id
  const project = createProject({ request_id: 'o-enrich', mode: 'quick' })
  recordSketchGenerated(project.project_id, FROZEN)
  return { project_id: project.project_id, session_id: 'o-enrich-session' }
}

function seedUserTurn(session_id: string, text: string): void {
  appendJsonLine(getAgentSessionPath(session_id), {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
  })
}

/** 输入.query 占位（两路 LLM 均被 mock，不会被真正调用）。 */
const stubQuery: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
  yield { type: 'result', subtype: 'success' }
}

function makeInput(project_id: string, session_id: string): MvpTaskInput {
  return {
    request_id: 'o-enrich',
    session_id,
    project_id,
    mode: 'quick',
    channel_id: channelId,
    query: stubQuery,
  }
}

function llmBackplane(project_id: string): PrdBackplane {
  return {
    project_id,
    name: '',
    positioning: '家庭记账本：记录收支并展示结余',
    requirements: FROZEN,
    acceptance: { 'F-001': '能新增一笔收入或支出并保存', 'F-002': '按自然月显示结余' },
    out_of_scope: [],
    assumptions: [],
  }
}

describe('resolvePrdBackplane — 功能项加厚并行并入', () => {
  it('并行成功：PRD 背板 + 功能项加厚都成功 → 背板含加厚字段（story/断言/优先级）', async () => {
    const { project_id, session_id } = setup('o-enrich-ok-')
    seedUserTurn(session_id, '我想做一个家庭记账本，要能记收入和支出，月底看结余')
    vi.mocked(generatePrdLlm).mockResolvedValue(llmBackplane(project_id))
    vi.mocked(enrichRequirementsLlm).mockResolvedValue(ENRICHED)

    const backplane = await resolvePrdBackplane(makeInput(project_id, session_id), FROZEN)

    // 两路并行调用、共用渠道 max_tokens 上限
    expect(generatePrdLlm).toHaveBeenCalledTimes(1)
    expect(enrichRequirementsLlm).toHaveBeenCalledTimes(1)
    expect(vi.mocked(enrichRequirementsLlm)).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }))
    expect(vi.mocked(generatePrdLlm)).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 4096 }))
    // 背板字段来自 LLM
    expect(backplane.positioning).toBe('家庭记账本：记录收支并展示结余')
    expect(backplane.acceptance['F-001']).toBe('能新增一笔收入或支出并保存')
    // 加厚字段并入冻结项（只填缺省）
    expect(backplane.requirements[0].story).toBe('作为用户，我想记录收支，以便月底看结余')
    expect(backplane.requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
    expect(backplane.requirements[0].priority).toBe('P0')
    expect(backplane.requirements[1].story).toBe('作为用户，我想看结余')
    expect(backplane.requirements[1].behavior_assertions).toEqual(['点击刷新按钮→结余数字变化'])
    expect(backplane.requirements[1].priority).toBe('P1')
  })

  it('并行成功：丢弃/抑制统计落决策日志（enrichment_stats），不阻断主链路', async () => {
    const { project_id, session_id } = setup('o-enrich-stats-')
    seedUserTurn(session_id, '我想做一个家庭记账本，要能记收入和支出，月底看结余')
    vi.mocked(generatePrdLlm).mockResolvedValue(llmBackplane(project_id))
    // F-002 的断言为人工验收类（①格式守卫丢弃）→ prioritySuppressed=1
    vi.mocked(enrichRequirementsLlm).mockResolvedValue([
      {
        id: 'F-001',
        story: 'S1',
        behavior_assertions: [{ assertion: '点击保存按钮→列表新增一条记录', source: '要能记收入和支出' }],
        priority: 'P0',
      },
      { id: 'F-002', priority: 'P0', behavior_assertions: [{ assertion: '用户手动测试功能正常', source: '要能正常' }] },
    ])

    await resolvePrdBackplane(makeInput(project_id, session_id), FROZEN)

    const sessionText = readFileSync(getAgentSessionPath(session_id), 'utf8')
    expect(sessionText).toContain('enrichment_stats')
    expect(sessionText).toContain('prioritySuppressed')
  })

  it('enricher 返回 null（失败路径）→ 加厚不生效，背板正常返回（保持薄形态）', async () => {
    const { project_id, session_id } = setup('o-enrich-null-')
    seedUserTurn(session_id, '我想做一个家庭记账本')
    vi.mocked(generatePrdLlm).mockResolvedValue(llmBackplane(project_id))
    vi.mocked(enrichRequirementsLlm).mockResolvedValue(null)

    const backplane = await resolvePrdBackplane(makeInput(project_id, session_id), FROZEN)

    expect(backplane).not.toBeNull()
    expect(backplane.positioning).toBe('家庭记账本：记录收支并展示结余')
    // 冻结项保持薄形态：无加厚 story/断言；F-002 无 priority（读取侧缺省 P2）
    expect(backplane.requirements[0].story).toBeUndefined()
    expect(backplane.requirements[0].behavior_assertions).toBeUndefined()
    expect(backplane.requirements[1].priority).toBeUndefined()
    expect(backplane.requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
  })

  it('generatePrdLlm reject → 模板兜底，但加厚仍应用（冻结清单为权威 id 集）', async () => {
    const { project_id, session_id } = setup('o-enrich-llmdown-')
    seedUserTurn(session_id, '我想做一个家庭记账本，要能记收入和支出')
    vi.mocked(generatePrdLlm).mockRejectedValue(new Error('network down'))
    vi.mocked(enrichRequirementsLlm).mockResolvedValue(ENRICHED)

    const backplane = await resolvePrdBackplane(makeInput(project_id, session_id), FROZEN)

    // llm 失败 → 确定性模板兜底；加厚结果并入原始冻结清单
    expect(backplane).not.toBeNull()
    expect(backplane.positioning).toBeTruthy()
    expect(backplane.requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
    expect(backplane.requirements[0].story).toBe('作为用户，我想记录收支，以便月底看结余')
    expect(backplane.requirements[0].behavior_assertions).toEqual(['点击保存按钮→列表新增一条记录'])
  })

  it('mergeEnrichment 抛错 → 回退冻结清单，绝不阻断主链路', async () => {
    const { project_id, session_id } = setup('o-enrich-mergeboom-')
    seedUserTurn(session_id, '我想做一个家庭记账本，要能记收入和支出')
    vi.mocked(generatePrdLlm).mockResolvedValue(llmBackplane(project_id))
    vi.mocked(enrichRequirementsLlm).mockResolvedValue(ENRICHED)
    vi.mocked(mergeEnrichment).mockImplementationOnce(() => {
      throw new Error('merge boom')
    })

    const backplane = await resolvePrdBackplane(makeInput(project_id, session_id), FROZEN)

    // 回退冻结清单（llm 成功时 = llm 背板的功能项），无加厚字段
    expect(backplane).not.toBeNull()
    expect(backplane.requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
    expect(backplane.requirements[0].story).toBeUndefined()
    expect(backplane.requirements[0].behavior_assertions).toBeUndefined()
  })

  it('无可用渠道 → 回退确定性模板（不调用两路 LLM）', async () => {
    // 只建项目不建渠道：resolveChannelEnv 返回 no_channel → template()
    home = mkdtempSync(join(tmpdir(), 'o-enrich-nochan-'))
    process.env.PROMA_HOME = home
    setSafeStorageAdapter({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(`enc:${value}`, 'utf8'),
      decryptString: (value) => value.toString('utf8').replace(/^enc:/, ''),
    })
    const project = createProject({ request_id: 'o-enrich', mode: 'quick' })
    recordSketchGenerated(project.project_id, FROZEN)
    const input = makeInput(project.project_id, 'o-enrich-session-nochan')
    input.channel_id = undefined

    const backplane = await resolvePrdBackplane(input, FROZEN)

    expect(backplane).not.toBeNull()
    expect(generatePrdLlm).not.toHaveBeenCalled()
    expect(enrichRequirementsLlm).not.toHaveBeenCalled()
    expect(backplane.requirements.map((r) => r.id)).toEqual(['F-001', 'F-002'])
  })
})

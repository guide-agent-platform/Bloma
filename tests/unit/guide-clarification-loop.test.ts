/**
 * ② 追问通路集成测试（guide-clarification-loop，2026-09-03）。
 *
 * 验收级闭环（陷阱 36：模块内路由只能验收级测试）：
 * 收敛触发 runPrdPipeline → 加厚腿声明缺口（resolvePrdBackplane 第三参回调）→
 * 挂起（发追问卡 + requested 决策行 + PRD 不落盘）→ 用户卡上回答（selected_option_id
 * 回传）→ 答案落会话 + answered 决策行 → 整轮重跑（第二次调用不再触发追问）→
 * 走完现状路径（PRD 落盘 + 确认卡）。
 *
 * decision-log 不 mock（真实落盘临时 PROMA_HOME 的会话 JSONL）——轮次守卫/
 * 孤儿检测从决策行推导，mock 掉会让挂起守卫永远放行，测不到真实状态机。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/coding/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  // 默认实现：不带追问的背板（重跑轮走这里）
  resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })),
  setProgrammingEventPublisher: vi.fn(),
  nextRequirementId: vi.fn((existing: Array<{ id: string }>) => {
    const max = existing.reduce((acc, item) => {
      const match = /^F-(\d+)$/.exec(item.id)
      return match ? Math.max(acc, Number(match[1])) : acc
    }, 0)
    return `F-${String(max + 1).padStart(3, '0')}`
  }),
  refineModificationDescription: vi.fn((text: string) => text.trim()),
}))
vi.mock('../../main/platform-services', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/document-engine', () => ({
  syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })),
  markPrdUserConfirmed: vi.fn(() => ({ project_id: 'proj-1', user_confirmed_at: '2026-08-26T00:00:00.000Z' })),
}))
vi.mock('../../main/project-service', () => ({
  findProject: vi.fn(() => ({
    project_id: 'proj-1',
    workspace_slug: 'default-software-builder',
    name: '未命名项目',
    mode: 'quick',
    status: 'active',
    current_stage: 'clarifying',
    root_path: '/tmp/proj-1',
  })),
  updateProject: vi.fn(),
}))
vi.mock('../../main/session-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../main/session-service')>()
  return { ...actual, readPrimaryIntent: vi.fn((): string | undefined => undefined) }
})
// decision-log 刻意不 mock：轮次守卫/孤儿检测依赖真实会话 JSONL 决策行
vi.mock('../../main/guide/guide-research', () => ({
  normalizeResearchQuery: (q: string) => q,
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({ available: false, queries, results: [], summary: '' })),
}))
vi.mock('../../main/runtime-fallback', () => ({
  resolveChannelEnv: vi.fn(() => ({ env: undefined, channel: undefined })),
}))

import { handleGuideMessage, resolveRequirementConfirm } from '../../main/guide/guide-agent-service'
import { resolvePrdBackplane } from '../../main/coding/programming-orchestrator'
import { syncDocuments } from '../../main/document-engine'
import { hasPendingEnrichmentClarification, takePendingEnrichmentClarification, type EnrichmentClarificationRequest } from '../../main/guide/clarification'
import { getAgentSessionPath } from '../../storage/config-paths'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestrator'

const SESSION_ID = 'sess-clar-loop'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '记账本，记录日常收支' },
    { id: 'F-002', description: '按月汇总统计' },
  ],
  research_queries: [],
})

const reviewPassJson = JSON.stringify({
  issues: [{ dimension: 'U', severity: 'minor', location: 'F-001', claim: '措辞可更具体', evidence: ['记账'] }],
  clean_dimensions: ['F', 'I', 'Z', 'L', 'G'],
})

function scriptedQuery(): SDKQuery {
  let confirmServed = false
  return async function* (prompt: string): AsyncGenerator<SDKMessage> {
    if (!confirmServed && !prompt.includes('六维')) {
      confirmServed = true
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: confirmJson }] } }
      yield { type: 'result', subtype: 'success' }
      return
    }
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reviewPassJson }] } }
    yield { type: 'result', subtype: 'success' }
  }
}

function makeModel(query: SDKQuery): GuideModelOptions {
  const history: ConversationTurn[] = [
    { role: 'user', content: '做个记账的东西' },
    { role: 'assistant', content: '自己用还是全家？' },
    { role: 'user', content: '自己用，要能按月看统计' },
  ]
  return {
    query,
    env: { PATH: 'x', ANTHROPIC_AUTH_TOKEN: 'test', ANTHROPIC_BASE_URL: 'https://example.com' },
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    history,
    maxTokens: 2048,
    persistAssistant: vi.fn(),
  }
}

function makeInput(overrides: Partial<AgentSendMessageInput> = {}): AgentSendMessageInput {
  return {
    request_id: 'req-cl1',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content: '自己用，要能按月看统计',
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
    ...overrides,
  }
}

describe('② 追问通路闭环（挂起 → 回答 → 重跑）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let events: AgentEvent[]
  let home: string | undefined

  beforeEach(() => {
    // 2026-09-16: BLOMA_GUIDE_LOOP default-on; pin legacy path for this file
    process.env.BLOMA_GUIDE_LOOP = '0'
    process.env.BLOMA_DELEGATED_REVIEW = '0'
    home = mkdtempSync(join(tmpdir(), 'proma-clar-loop-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    events = []
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(syncDocuments).mockClear()
  })

  afterEach(() => {
    delete process.env.BLOMA_DELEGATED_REVIEW
    process.env.PROMA_HOME = originalPromaHome
    vi.restoreAllMocks()
    if (home) {
      const { rmSync } = require('node:fs') as typeof import('node:fs')
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
    home = undefined
  })

  /** 收敛触发 + 需求弹窗确认，走到 runPrdPipeline（第一次 resolvePrdBackplane 触发追问） */
  async function triggerPipelineWithClarification(): Promise<void> {
    vi.mocked(resolvePrdBackplane).mockImplementationOnce(
      async (_input, requirements, onClarification?: (requests: EnrichmentClarificationRequest[]) => void) => {
        onClarification?.([{ for: 'F-001', question: '记账记录要保留多久？要不要分类标签？', options: [{ id: 'a', label: '保留一年' }] }])
        return {
          project_id: 'proj-1',
          name: '未命名项目',
          positioning: '个人记账工具',
          requirements,
          acceptance: {},
          out_of_scope: [],
          assumptions: [],
        }
      },
    )
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(scriptedQuery()))
    await resolveRequirementConfirm({ request_id: 'req-cl2', session_id: SESSION_ID, project_id: 'proj-1', decision: 'confirm' })
  }

  it('挂起：发追问卡 + PRD 不落盘 + 不发确认卡（状态机图①②）', async () => {
    await triggerPipelineWithClarification()

    expect(vi.mocked(resolvePrdBackplane)).toHaveBeenCalledTimes(1)
    // 追问卡事件已发（kind=enrichment_clarification）
    const clarificationCards = events.filter(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string })?.kind === 'enrichment_clarification',
    )
    expect(clarificationCards).toHaveLength(1)
    // PRD 未落盘（挂起期间不写 prd.json，answered 后整轮重跑再落）
    expect(vi.mocked(syncDocuments)).not.toHaveBeenCalled()
    // 未发 PRD 确认卡（管线挂起，未走完现状路径）
    const prdCards = events.filter(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string })?.kind === 'prd_confirm',
    )
    expect(prdCards).toHaveLength(0)
    // 挂起上下文在内存（等待回答）
    expect(hasPendingEnrichmentClarification('proj-1')).toBe(true)
  })

  it('回答 → 答案落会话 + answered 决策行 + 整轮重跑 → 走完现状路径出确认卡（图③）', async () => {
    await triggerPipelineWithClarification()
    events = []

    // 用户在追问卡回答（selected_option_id 回传；答案文本即 content）
    await handleGuideMessage(
      makeInput({
        content: '保留最近一年，要分类标签，按餐饮/交通/日用分。',
        metadata: { source: 'card_option', selected_option_id: 'enrichment_clarification_answer' },
      }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    // 整轮重跑：第二次 resolvePrdBackplane（默认实现不触发追问）
    expect(vi.mocked(resolvePrdBackplane)).toHaveBeenCalledTimes(2)
    // 挂起已终结
    expect(hasPendingEnrichmentClarification('proj-1')).toBe(false)
    // PRD 落盘 + 确认卡（现状路径走完）
    expect(vi.mocked(syncDocuments)).toHaveBeenCalled()
    const prdCards = events.filter(
      (event) => event.type === 'user_decision_required' && (event.payload as { kind?: string })?.kind === 'prd_confirm',
    )
    expect(prdCards).toHaveLength(1)
    // 答案已落会话（「答案落会话」态：user 轮次成为下一轮接地证据）
    const sessionText = await import('node:fs').then((fs) => fs.readFileSync(getAgentSessionPath(SESSION_ID), 'utf8'))
    expect(sessionText).toContain('保留最近一年，要分类标签')
    // 决策行：requested + answered 均落盘
    expect(sessionText).toContain('enrichment_clarification_requested')
    expect(sessionText).toContain('enrichment_clarification_answered')
  })

  it('过期回答（内存 pending 已被 take）→ 如实提示过期，不重跑管线', async () => {
    await triggerPipelineWithClarification()
    // 模拟超时/重启：内存 pending 被清除
    takePendingEnrichmentClarification('proj-1')
    events = []
    vi.mocked(resolvePrdBackplane).mockClear()

    await handleGuideMessage(
      makeInput({
        content: '保留最近一年。',
        metadata: { source: 'card_option', selected_option_id: 'enrichment_clarification_answer' },
      }),
      (event) => events.push(event),
      makeModel(scriptedQuery()),
    )

    // 过期：不重跑管线，如实提示
    expect(vi.mocked(resolvePrdBackplane)).not.toHaveBeenCalled()
    const hint = events.find((event) => event.type === 'message_delta')
    expect(hint?.payload && typeof hint.payload.text === 'string' ? hint.payload.text : '').toContain('过期')
  })
})

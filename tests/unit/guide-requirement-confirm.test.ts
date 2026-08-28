import { restorePromaHome } from '../support/proma-home-guard'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, AgentSendMessageInput, SDKMessage } from '../../shared/types'

vi.mock('../../main/programming-orchestrator', () => ({
  runSketchTask: vi.fn().mockResolvedValue({ preview_url: 'http://localhost', snapshot: {}, summary: 'ok' }),
  resolvePrdBackplane: vi.fn(async (_input: unknown, requirements: unknown) => ({
    name: '未命名项目',
    positioning: '个人记账工具',
    requirements,
  })),
  setProgrammingEventPublisher: vi.fn(),
}))
vi.mock('../../main/platform-services', () => ({ trackAnalytics: vi.fn() }))
vi.mock('../../main/document-engine', () => ({ syncDocuments: vi.fn(() => ({ documents: [], stale_documents: [] })) }))
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
vi.mock('../../main/decision-log', () => ({ recordDecision: vi.fn(), parseDecisionText: vi.fn() }))
vi.mock('../../main/guide-research', () => ({
  researchMarketSimilar: vi.fn(async (queries: string[]) => ({
    available: true,
    queries,
    results: [{ title: '十款记账应用盘点', url: 'https://a.example.com/ledger', snippet: '流行的记账工具对比' }],
    summary: '1. 十款记账应用盘点 — a.example.com\n   流行的记账工具对比',
  })),
}))

import {
  handleGuideMessage,
  resolveRequirementConfirm,
  takePendingRequirementConfirm,
} from '../../main/guide-agent-service'
import { recordDecision } from '../../main/decision-log'
import { resolvePrdBackplane, runSketchTask } from '../../main/programming-orchestrator'
import { syncDocuments } from '../../main/document-engine'
import { researchMarketSimilar } from '../../main/guide-research'
import type { ConversationTurn, GuideModelOptions, SDKQuery } from '../../main/orchestrator'

/**
 * 需求确认弹窗（confirm_requirements，2026-08-26）：
 * - 模型判定需求成型 → 市调 → 弹窗事件 + pending 状态，不直接开工；
 * - 用户 confirm（勾选子集）→ PRD 前移（requirement_confirmed 检查点）→ 以勾选集开工；
 * - 用户 delegate → 向导清单全量开工；
 * - 无 pending → started:false（幂等，弹窗重复提交不炸）。
 */

const SESSION_ID = 'sess-req-confirm'

const confirmJson = JSON.stringify({
  action: 'confirm_requirements',
  reply: '我整理好了，请确认这份需求',
  requirements: [
    { id: 'F-001', description: '记账本，记录日常收支' },
    { id: 'F-002', description: '按月汇总统计' },
  ],
  research_queries: ['记账 应用 推荐'],
})

function makeModel(): GuideModelOptions {
  const query: SDKQuery = async function* (): AsyncGenerator<SDKMessage> {
    yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: confirmJson }] } }
    yield { type: 'result', subtype: 'success' }
  }
  const history: ConversationTurn[] = [
    { role: 'user', content: '做个记账的东西' },
    { role: 'assistant', content: '自己用还是全家？' },
    { role: 'user', content: '自己用' },
  ]
  return {
    query,
    env: { PATH: 'x' },
    signal: new AbortController().signal,
    sessionId: SESSION_ID,
    history,
    maxTokens: 2048,
    persistAssistant: vi.fn(),
  }
}

function makeInput(): AgentSendMessageInput {
  return {
    request_id: 'req-c1',
    session_id: SESSION_ID,
    project_id: 'proj-1',
    content: '自己用，还要能按月看统计',
    mode: 'quick',
    current_stage: 'clarifying',
    metadata: { source: 'chat' },
  }
}

describe('需求确认弹窗（confirm_requirements）', () => {
  const originalPromaHome = process.env.PROMA_HOME
  let home: string
  let events: AgentEvent[]
  let persistSystem: ReturnType<typeof vi.fn>

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-req-confirm-'))
    process.env.PROMA_HOME = home
    mkdirSync(join(home, 'agent-sessions'), { recursive: true })
    events = []
    // 按生产语义落盘（orchestrator 传入的 persistSystem 会写会话 JSONL），供回访追溯断言
    persistSystem = vi.fn((text: string) => {
      appendFileSync(
        join(home, 'agent-sessions', `${SESSION_ID}.jsonl`),
        JSON.stringify({ role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() }) + '\n',
      )
    })
    vi.mocked(runSketchTask).mockClear()
    vi.mocked(resolvePrdBackplane).mockClear()
    vi.mocked(syncDocuments).mockClear()
    vi.mocked(recordDecision).mockClear()
    vi.mocked(researchMarketSimilar).mockClear()
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    vi.restoreAllMocks()
  })

  it('模型判定需求成型 → 执行市调并弹确认窗，不直接开工', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    expect(runSketchTask).not.toHaveBeenCalled()
    // 市调按模型的 research_queries 执行（增强注入弹窗）
    expect(researchMarketSimilar).toHaveBeenCalledWith(['记账 应用 推荐'])
    const confirmEvent = events.find((event) => event.type === 'user_decision_required')
    expect(confirmEvent?.payload.kind).toBe('requirement_confirm')
    expect(confirmEvent?.payload.requirements).toHaveLength(2)
    expect(confirmEvent?.payload.research).toMatchObject({ available: true })
    // 落盘留痕：弹窗内容可事后追溯 + 决策日志
    expect(persistSystem).toHaveBeenCalledWith(expect.stringContaining('[decision-card] 需求确认：'))
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirm_card' }),
    }))
    // 阶段进入待决策
    expect(events.some((event) => event.type === 'stage_changed' && event.payload.stage === 'blocked_for_user_decision')).toBe(true)
    // pending 状态已建立（供 IPC 回传使用）
    expect(takePendingRequirementConfirm('proj-1')).toBeDefined()
    // 弹窗后 pending 被取走（幂等），再来一次为空
    expect(takePendingRequirementConfirm('proj-1')).toBeUndefined()
  })

  it('用户勾选子集 confirm → PRD 前移落盘（requirement_confirmed）+ 以勾选集开工', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    const result = await resolveRequirementConfirm({
      request_id: 'req-c2',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      requirement_ids: ['F-002'],
    })

    expect(result).toMatchObject({ started: true, prd_written: true })
    // PRD 前移：勾选后的需求集 + requirement_confirmed 检查点
    expect(resolvePrdBackplane).toHaveBeenCalledWith(expect.anything(), [
      { id: 'F-002', description: '按月汇总统计' },
    ])
    expect(syncDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ checkpoint: 'requirement_confirmed', project_id: 'proj-1' }),
      expect.anything(),
    )
    expect(runSketchTask).toHaveBeenCalledWith(expect.objectContaining({
      requirements: [{ id: 'F-002', description: '按月汇总统计' }],
    }))
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirmed', title: '用户确认需求清单' }),
    }))
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('产品需求文档'))).toBe(true)
  })

  it('[S4-AGENT-066] confirm 带 reference_url → 草图 prompt 追加设计参考节（r56 提取器接线）', async () => {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html><head><title>示例商城</title><style>body{color:#ff5000}</style></head><body><h1>品质好物</h1></body></html>')
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const refUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/ref`
    try {
      await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

      const result = await resolveRequirementConfirm({
        request_id: 'req-c6',
        session_id: SESSION_ID,
        project_id: 'proj-1',
        decision: 'confirm',
        requirement_ids: ['F-001'],
        reference_url: refUrl,
      })
      expect(result.started).toBe(true)
      const call = vi.mocked(runSketchTask).mock.calls.at(-1)?.[0] as { prompt: string }
      expect(call.prompt).toContain('【设计参考】')
      expect(call.prompt).toContain('示例商城')
      expect(call.prompt).toContain('#ff5000')
    } finally {
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    }
  })

  it('[S4-AGENT-067] 无 reference_url → prompt 不含设计参考节（零回归）', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)
    await resolveRequirementConfirm({
      request_id: 'req-c7',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
    })
    const call = vi.mocked(runSketchTask).mock.calls.at(-1)?.[0] as { prompt: string }
    expect(call.prompt).not.toContain('设计参考')
  })

  it('[S4-AGENT-068] reference_url 非 http(s) → SSRF 拒绝，prompt 无参考节且照常开工', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)
    const result = await resolveRequirementConfirm({
      request_id: 'req-c8',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      reference_url: 'file:///etc/passwd',
    })
    expect(result.started).toBe(true)
    const call = vi.mocked(runSketchTask).mock.calls.at(-1)?.[0] as { prompt: string }
    expect(call.prompt).not.toContain('设计参考')
  })

  it('用户选择「由向导决定」（delegate）→ 清单全量开工，决策注明让渡', async () => {
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    await resolveRequirementConfirm({
      request_id: 'req-c3',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'delegate',
    })

    expect(runSketchTask).toHaveBeenCalledWith(expect.objectContaining({
      requirements: [
        { id: 'F-001', description: '记账本，记录日常收支' },
        { id: 'F-002', description: '按月汇总统计' },
      ],
    }))
    expect(recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'requirement_confirmed', title: '用户让渡：由向导决定需求' }),
    }))
  })

  it('无 pending（重复提交/重启丢失）→ started:false 幂等不炸', async () => {
    const result = await resolveRequirementConfirm({
      request_id: 'req-c4',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
      requirement_ids: ['F-001'],
    })
    expect(result).toMatchObject({ started: false, prd_written: false })
    expect(runSketchTask).not.toHaveBeenCalled()
  })

  it('PRD 前移失败 → 不阻断草图（话术如实降级），仍开工', async () => {
    vi.mocked(resolvePrdBackplane).mockRejectedValueOnce(new Error('CHANNEL_DOWN'))
    await handleGuideMessage(makeInput(), (event) => events.push(event), makeModel(), undefined, persistSystem)

    const result = await resolveRequirementConfirm({
      request_id: 'req-c5',
      session_id: SESSION_ID,
      project_id: 'proj-1',
      decision: 'confirm',
    })

    expect(result).toMatchObject({ started: true, prd_written: false })
    expect(runSketchTask).toHaveBeenCalledTimes(1)
    const deltas = events.filter((event) => event.type === 'message_delta').map((event) => String(event.payload.text))
    expect(deltas.some((text) => text.includes('开始画草图'))).toBe(true)
    // 会话 JSONL 落盘了弹窗留痕（回访可追溯）
    const sessionText = readFileSync(join(home, 'agent-sessions', `${SESSION_ID}.jsonl`), 'utf8')
    expect(sessionText).toContain('[decision-card] 需求确认：')
  })
})

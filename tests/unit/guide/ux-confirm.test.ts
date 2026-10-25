/**
 * UX 草图确认门测试（2026-10-04 确认门新规）——生命周期/回传拦截/调整轮次/回门。
 *
 * mock 面：ux-sketch（生成+沙箱桩）；desktop-route（enterDesktopLine 桩——确认后
 * 进桌面线的断言点）；project-service/prd-store（回门判定数据源）；decision-log（spy）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../shared/types'

vi.mock('../../../main/guide/ux-sketch', () => ({
  generateUxSketch: vi.fn(),
  stageUxSketch: vi.fn(),
  freezeConfirmedUxSketch: vi.fn(),
}))

vi.mock('../../../main/desktop/desktop-route', () => ({
  enterDesktopLine: vi.fn(),
  // 2026-10-05：ux-confirm 改用品类集合判定（game 直进桌面线）——mock 同步补导出（陷阱 36）
  DESKTOP_LINE_TEMPLATE_TYPES: new Set(['desktop_tool', 'game']),
}))

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('../../../main/project/prd-store', () => ({
  readPrdBackplane: vi.fn(),
}))

vi.mock('../../../main/project/decision-log', () => ({
  recordDecision: vi.fn(),
}))

import { freezeConfirmedUxSketch, generateUxSketch, stageUxSketch } from '../../../main/guide/ux-sketch'
import { enterDesktopLine } from '../../../main/desktop/desktop-route'
import { findProject } from '../../../main/project/project-service'
import { readPrdBackplane } from '../../../main/project/prd-store'
import { recordDecision } from '../../../main/project/decision-log'
import { FALLBACK_UX_SUMMARY } from '../../../main/model/ux-design'
import {
  isUxResumeIntent,
  resetUxConfirmForTests,
  UX_CONFIRM_OPTION_ADJUST,
  UX_CONFIRM_OPTION_CONFIRM,
  UX_CONFIRM_OPTION_DISMISS,
  UX_CONFIRM_OPTION_RETRY,
  retryUxSketch,
  UX_SKETCH_ADJUST_LIMIT,
  resolveUxConfirmCardAnswer,
  republishUxCardFromArchive,
  resumeUxConfirmConfirmed,
  runUxAdjustRound,
  runUxConfirmGate,
  startUxAdjustAwait,
  takeUxAdjustFeedback,
  type PendingUxConfirm,
} from '../../../main/guide/ux-confirm'

const mockGenerate = vi.mocked(generateUxSketch)
const mockStage = vi.mocked(stageUxSketch)
const mockEnter = vi.mocked(enterDesktopLine)
const mockFindProject = vi.mocked(findProject)
const mockReadPrd = vi.mocked(readPrdBackplane)
const mockDecision = vi.mocked(recordDecision)

function makePublish() {
  const events: AgentEvent[] = []
  return {
    events,
    publish: (event: AgentEvent) => {
      events.push(event)
    },
  }
}

function basePending(overrides: Partial<PendingUxConfirm> = {}): PendingUxConfirm {
  return {
    request_id: 'r1',
    session_id: 's1',
    project_id: 'p1',
    mode: 'quick',
    query: {} as never,
    env: { K: 'V' },
    publish: makePublish().publish,
    round: 1,
    positioning: '科学计算器',
    requirements: [{ id: 'F-001', description: '做一个计算器' }],
    ...overrides,
  }
}

function cardInput(optionId: string) {
  return {
    request_id: 'r2',
    session_id: 's1',
    project_id: 'p1',
    content: '选项',
    metadata: { source: 'card_option', selected_option_id: optionId },
  } as never
}

function plainInput(content: string) {
  return {
    request_id: 'r3',
    session_id: 's1',
    project_id: 'p1',
    content,
    metadata: { source: 'chat' },
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  resetUxConfirmForTests()
  mockGenerate.mockResolvedValue({ html: '<!DOCTYPE html><html></html>', source: 'llm', design: {
    version: 1, summary: '计算器界面', pages: [], flows: [], interactions: [], non_ui_features: [],
  } } as never)
  mockStage.mockResolvedValue({ preview_url: 'http://localhost:41000/00_UX/ux-sketch.html', sketch_path: '/tmp/ux-sketch.html', html_hash: 'mock-hash' } as never)
  mockFindProject.mockImplementation(() => ({ project_id: 'p1', template_type: 'desktop_tool', mode: 'quick', name: '计算器' }) as never)
  mockReadPrd.mockImplementation(() => ({ project_id: 'p1', name: '计算器', user_confirmed_at: '2026-10-04T00:00:00Z', positioning: 'x', requirements: [{ id: 'F-001', description: '做一个计算器' }], acceptance: {}, assumptions: [], out_of_scope: [] }) as never)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('runUxConfirmGate（发门）', () => {
  it('旁白 + stage_changed(generating_sketch) + ux_sketch_ready + 确认卡，pending 挂起', async () => {
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }), round: 1 })
    const types = events.map((e) => e.type)
    expect(types).toContain('stage_changed')
    expect(events.find(e => e.type === 'stage_changed')?.payload.stage).toBe('generating_sketch')
    expect(types).toContain('ux_sketch_ready')
    expect(types).toContain('user_decision_required')
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('ux_confirm')
    expect((card?.payload.questions as Array<{ id: string }>).map((q) => q.id)).toContain(UX_CONFIRM_OPTION_CONFIRM)
    // 预览 URL 原样透传
    expect(events.find((e) => e.type === 'ux_sketch_ready')?.payload.preview_url).toContain('/00_UX/ux-sketch.html')
    // 卡挂起可被回传识别拦截
    expect(resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)).toBe('confirm')
  })

  it('预览失败：明确未就绪，只能重试或调整，不能以文字代替界面确认', async () => {
    mockStage.mockRejectedValue(new Error('UX_SKETCH_SANDBOX_FAILED: down') as never)
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    expect(events.map((e) => e.type)).not.toContain('ux_sketch_ready')
    expect(events.map((e) => e.type)).toContain('user_decision_required')
    expect(events.some((e) => e.type === 'message_delta' && String(e.payload.text).includes('失败'))).toBe(true)
    const questions = events.find(e => e.type === 'user_decision_required')!.payload.questions as Array<{ id: string }>
    expect(questions.map(q => q.id)).toContain(UX_CONFIRM_OPTION_RETRY)
    expect(questions.map(q => q.id)).not.toContain(UX_CONFIRM_OPTION_CONFIRM)
    expect(events.at(-1)?.payload.subtype).toBe('incomplete')
    await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM))
    expect(mockEnter).not.toHaveBeenCalled()
  })

  it('模板需求列表不能进入草图确认；明确重试后才展示成功草图', async () => {
    mockGenerate.mockResolvedValueOnce({ html: '<!DOCTYPE html><html>F-001 需求清单</html>', source: 'template', design: { summary: FALLBACK_UX_SUMMARY } } as never)
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    expect(mockStage).not.toHaveBeenCalled()
    expect(events.some(e => e.type === 'ux_sketch_ready')).toBe(false)
    expect(resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_RETRY))).toBe('retry')
    expect(mockGenerate).toHaveBeenCalledTimes(1)
    await retryUxSketch(cardInput(UX_CONFIRM_OPTION_RETRY))
    expect(mockGenerate).toHaveBeenCalledTimes(2)
    expect(events.some(e => e.type === 'ux_sketch_ready')).toBe(true)
  })
})

describe('确认/让渡/调整回传', () => {
  it('propagates the first production interruption after a successful UX confirmation', async () => {
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    mockEnter.mockImplementationOnce(async (input, _query, _env, deps) => {
      deps.complete(input.sessionId, input.projectId, 'incomplete')
      return true
    })
    await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)
    expect(events.filter(event => event.type === 'message_completed').at(-1)?.payload.subtype).toBe('incomplete')
  })

  it('a failed confirmed-sketch write preserves pending and allows retry', async () => {
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    vi.mocked(freezeConfirmedUxSketch).mockImplementationOnce(() => { throw new Error('disk failure') })
    await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)
    expect(mockEnter).not.toHaveBeenCalled()
    expect(events.some(event => String(event.payload.text).includes('保存已确认草图失败'))).toBe(true)
    expect(events.filter(event => event.type === 'message_completed').at(-1)?.payload.subtype).toBe('incomplete')
    expect(resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)).toBe('confirm')
    await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)
    expect(mockEnter).toHaveBeenCalledTimes(1)
  })
  it('confirm：ack + ux_sketch_closed + 进桌面线', async () => {
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    const decision = resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)
    expect(decision).toBe('confirm')
    await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)
    const types = events.map((e) => e.type)
    expect(types).toContain('ux_sketch_closed')
    expect(mockEnter).toHaveBeenCalledTimes(1)
    // 二次确认不重复触发（pending 已消费）
    expect(await resumeUxConfirmConfirmed(cardInput(UX_CONFIRM_OPTION_CONFIRM) as never)).toBe(false)
  })

  it('adjust：转等反馈态 → 反馈文本触发重画（round+1）', async () => {
    const { publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    expect(resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_ADJUST) as never)).toBe('adjust')
    startUxAdjustAwait(cardInput(UX_CONFIRM_OPTION_ADJUST) as never)
    const taken = takeUxAdjustFeedback(plainInput('按钮太挤，改成两行') as never)
    expect(taken?.feedback).toBe('按钮太挤，改成两行')
    expect(taken?.pending.round).toBe(1)
    await runUxAdjustRound(cardInput(UX_CONFIRM_OPTION_ADJUST) as never, taken!)
    // 重画带反馈入参（最后一次调用——首次发门无 feedback）
    expect(mockGenerate.mock.calls.at(-1)?.[0]?.feedback).toBe('按钮太挤，改成两行')
  })

  it('等反馈态收到停止词：不作为反馈消费', async () => {
    const { publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    startUxAdjustAwait(cardInput(UX_CONFIRM_OPTION_ADJUST) as never)
    expect(takeUxAdjustFeedback(plainInput('停止 生成') as never)).toBeUndefined()
  })

  it('dismiss：pending 消费留痕 + ux_sketch_closed + 可经继续词回门', async () => {
    const { events, publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }) })
    expect(resolveUxConfirmCardAnswer(cardInput(UX_CONFIRM_OPTION_DISMISS) as never)).toBe('dismiss')
    const dismissModule = await import('../../../main/guide/ux-confirm')
    dismissModule.consumeUxConfirmDismiss(cardInput(UX_CONFIRM_OPTION_DISMISS) as never)
    expect(events.map((e) => e.type)).toContain('ux_sketch_closed')
    // 回门：桌面项目 + PRD 已确认 + 无 desktop_phase → 重发卡
    const republishPublish = makePublish()
    const reopened = await republishUxCardFromArchive(plainInput('按草图开工') as never, republishPublish.publish, { query: {} as never, env: {} })
    expect(reopened).toBe(true)
    expect(republishPublish.events.map((e) => e.type)).toContain('user_decision_required')
  })

  it('回门拒绝条件：已进桌面线（desktop_phase 已设）不再回门', async () => {
    mockFindProject.mockImplementation(() => ({ project_id: 'p1', template_type: 'desktop_tool', mode: 'quick', desktop_phase: 'desktop-implement' }) as never)
    const { publish } = makePublish()
    expect(await republishUxCardFromArchive(plainInput('按草图开工') as never, publish, { query: {} as never, env: {} })).toBe(false)
  })

  it('回门词表：isUxResumeIntent 覆盖「按草图开工」等提示语原文（真机踩坑回归锁）', () => {
    expect(isUxResumeIntent('按草图开工')).toBe(true)
    expect(isUxResumeIntent('开工')).toBe(true)
    expect(isUxResumeIntent('开始桌面交付')).toBe(true)
    expect(isUxResumeIntent('我想加一个历史记录功能')).toBe(false)
    expect(isUxResumeIntent('')).toBe(false)
  })
})

describe('轮次熔断', () => {
  it(`调整超过 ${UX_SKETCH_ADJUST_LIMIT} 轮：停下重画并重发选择卡，不自动开工`, async () => {
    const { publish } = makePublish()
    await runUxConfirmGate({ ...basePending({ publish }), round: UX_SKETCH_ADJUST_LIMIT })
    startUxAdjustAwait(cardInput(UX_CONFIRM_OPTION_ADJUST) as never)
    const taken = takeUxAdjustFeedback(plainInput('再改一版') as never)
    expect(taken).toBeDefined()
    mockEnter.mockClear()
    mockGenerate.mockClear()
    mockDecision.mockClear()
    await runUxAdjustRound(plainInput('再改一版') as never, taken!)
    // 超限不再重画，直接开工
    expect(mockGenerate).not.toHaveBeenCalled()
    expect(mockEnter).not.toHaveBeenCalled()
    expect(mockDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ title: expect.stringContaining('上限') }),
    }))
  })
})

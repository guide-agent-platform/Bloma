/**
 * longterm MVP 确认门测试（2026-10-04 确认门新规）——挂起/确认交付/调整回炉。
 *
 * mock 面：project-service 状态化桩；decision-log spy。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '../../../shared/types'

vi.mock('../../../main/project/project-service', () => ({
  findProject: vi.fn(),
  updateProject: vi.fn(),
}))

vi.mock('../../../main/delivery/preview-scheme', () => ({
  mintProjectPreviewUrl: vi.fn(() => 'bloma-file://p1/00_VERIFY/mvp-review.html'),
}))

vi.mock('../../../main/project/decision-log', () => ({
  recordDecision: vi.fn(),
}))

import { findProject, updateProject } from '../../../main/project/project-service'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordDecision } from '../../../main/project/decision-log'
import {
  resetMvpConfirmForTests,
  MVP_OPTION_ADJUST,
  MVP_OPTION_CONFIRM,
  confirmMvpDelivered,
  consumeMvpPendingForRework,
  holdForMvpConfirm,
  isMvpConfirmPending,
  isMvpFeedbackMessage,
  resolveMvpConfirmAnswer,
} from '../../../main/desktop/mvp-confirm'

const mockUpdate = vi.mocked(updateProject)
const mockDecision = vi.mocked(recordDecision)

function makeDeps() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = []
  return {
    events,
    deps: {
      publish: (_t: unknown, type: AgentEvent['type'] | string, payload: Record<string, unknown>) => {
        events.push({ type: String(type), payload })
      },
      persistAssistant: () => undefined,
      persistSystem: () => undefined,
      complete: () => undefined,
    },
  }
}

const input = { sessionId: 's1', projectId: 'p1', content: '', requestId: 'r1' }

let projectRoot: string

beforeEach(() => {
  vi.clearAllMocks()
  resetMvpConfirmForTests()
  projectRoot = mkdtempSync(join(tmpdir(), 'bloma-mvp-confirm-'))
  vi.mocked(findProject).mockImplementation(() => ({ project_id: 'p1', root_path: projectRoot }) as never)
})

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true })
})

describe('holdForMvpConfirm（挂起）', () => {
  it('pending 挂起 + MVP 卡 + 不置 delivered', () => {
    const { events, deps } = makeDeps()
    holdForMvpConfirm({
      input,
      deps,
      fromPhase: 'desktop-verify',
      notice: { projectName: '计算器', fromPhaseTitle: '验收', screenshotPaths: ['00_VERIFY/screenshots/S1.png'], driverSummary: { passed: 7, total: 9 }, deliveryDigest: '运行：python app.py' },
    })
    expect(isMvpConfirmPending('p1')).toBe(true)
    const card = events.find((e) => e.type === 'user_decision_required')
    expect(card?.payload.kind).toBe('mvp_confirm')
    // 成品过目页（像 UX 门一样右栏呈现）：落盘 + mvp_review_ready 事件 + paused 阶段
    expect(events.some((e) => e.type === 'mvp_review_ready' && String(e.payload.preview_url).includes('mvp-review.html'))).toBe(true)
    expect(events.some((e) => e.type === 'stage_changed' && e.payload.paused === true)).toBe(true)
    expect(existsSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'))).toBe(true)
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('screenshots/S1.png')
    expect(html).toContain('7/9 场景 PASS')
    expect((card?.payload.questions as Array<{ id: string }>).map((q) => q.id)).toEqual([MVP_OPTION_CONFIRM, MVP_OPTION_ADJUST])
    expect(mockUpdate).not.toHaveBeenCalledWith('p1', expect.objectContaining({ desktop_phase: 'delivered' }))
    expect(mockDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ type: 'mvp_confirm', title: expect.stringContaining('挂起') }),
    }))
  })
})

describe('回传拦截', () => {
  it('confirm 选项 → 确认；adjust 选项 → 调整；非本卡选项 → undefined', () => {
    const { deps } = makeDeps()
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    expect(resolveMvpConfirmAnswer({ projectId: 'p1', cardOptionId: MVP_OPTION_CONFIRM })).toBe('confirm')
    expect(resolveMvpConfirmAnswer({ projectId: 'p1', cardOptionId: MVP_OPTION_ADJUST })).toBe('adjust')
    expect(resolveMvpConfirmAnswer({ projectId: 'p1', cardOptionId: 'other' })).toBeUndefined()
    expect(resolveMvpConfirmAnswer({ projectId: 'p2', cardOptionId: MVP_OPTION_CONFIRM })).toBeUndefined()
  })

  it('挂起期间普通消息＝反馈（停止词除外；卡回传不算反馈）', () => {
    const { deps } = makeDeps()
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    expect(isMvpFeedbackMessage({ projectId: 'p1' }, false)).toBe(true)
    expect(isMvpFeedbackMessage({ projectId: 'p1' }, true)).toBe(false)
    expect(isMvpFeedbackMessage({ projectId: 'p1', cardOptionId: MVP_OPTION_ADJUST }, false)).toBe(false)
  })
})

describe('confirmMvpDelivered（确认交付）', () => {
  it('delivered 收口 + viaMvpConfirm 通知卡话术 + pending 清理', () => {
    const { events, deps } = makeDeps()
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: '计算器', fromPhaseTitle: '验收' } })
    confirmMvpDelivered({ input, deps })
    expect(mockUpdate).toHaveBeenCalledWith('p1', expect.objectContaining({ desktop_phase: 'delivered', status: 'completed', current_stage: 'completed' }))
    const notice = events.find((e) => e.type === 'message_delta' && String(e.payload.text).includes('交付完成'))
    expect(notice?.payload.text).toContain('已按你的确认正式交付')
    expect(isMvpConfirmPending('p1')).toBe(false)
  })
})

describe('consumeMvpPendingForRework（调整回炉）', () => {
  it('消费 pending + 决策留痕', () => {
    const { deps } = makeDeps()
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    expect(consumeMvpPendingForRework({ projectId: 'p1', sessionId: 's1' })).toEqual({ from_phase: 'desktop-verify' })
    expect(isMvpConfirmPending('p1')).toBe(false)
    expect(mockDecision).toHaveBeenCalledWith(expect.objectContaining({
      entry: expect.objectContaining({ title: expect.stringContaining('回炉') }),
    }))
  })
})

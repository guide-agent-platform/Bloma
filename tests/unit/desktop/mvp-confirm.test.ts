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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

  it('信任报告三段（批10 2026-10-07 外部意见吸收）：已确认能做/目前限制/给你的建议全部呈现，限制为空时如实兑底', () => {
    const { deps } = makeDeps()
    holdForMvpConfirm({
      input,
      deps,
      fromPhase: 'desktop-verify',
      notice: { projectName: '记账本', fromPhaseTitle: '验收', screenshotPaths: ['00_VERIFY/screenshots/S1.png'], driverSummary: { passed: 7, total: 9 }, deliveryDigest: '运行：python app.py' },
    })
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('本版本已确认能做（附验证方式）')
    expect(html).toContain('7/9 场景 PASS——平台实际启动了程序')
    expect(html).toContain('程序能正常启动并显示界面')
    expect(html).toContain('目前限制')
    expect(html).toContain('平台检查没有发现已知限制')
    expect(html).toContain('给你的建议')
    expect(html).toContain('怎么运行、数据存在哪里、怎么备份')
    expect(html).toContain('交付说明原文')
    expect(html).not.toContain('探索会话未正常完成')
  })

  it('探索发现段（2026-10-05 探索驱动测试批）：drive-findings.json 存在时注入过目页，含严重级/标题/actual', () => {
    const { deps } = makeDeps()
    mkdirSync(join(projectRoot, '00_VERIFY'), { recursive: true })
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-findings.json'),
      JSON.stringify({
        project_id: 'p1',
        findings: [{ id: 'F1', severity: 'P0', title: '保存后数据丢失', expected: '保存后重启可读回', actual: '重启后为空' }],
      }),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('探索发现（1 项')
    expect(html).toContain('[P0] 保存后数据丢失')
    expect(html).toContain('重启后为空')
  })

  it('探索状态真相段（B4，2026-10-06）：会话全非正常收尾时如实呈现「未含探索证据」；正常收尾不渲染', () => {
    const { deps } = makeDeps()
    mkdirSync(join(projectRoot, '00_VERIFY'), { recursive: true })
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-sessions.json'),
      JSON.stringify([{ session_id: 'drive-muwcxxx-abc123', outcome: 'open-timeout', ops: 3 }]),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    let html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('探索会话未正常完成')
    expect(html).toContain('open-timeout')
    // 正常收尾：不渲染警告段
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-sessions.json'),
      JSON.stringify([{ session_id: 'drive-muwcxxx-abc123', outcome: 'closed', ops: 12 }]),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).not.toContain('探索会话未正常完成')
  })

  it('部分会话未收尾（批10 旧账①）：任一非 closed 即进限制段并说明未 report 语义；全 closed 不渲染', () => {
    const { deps } = makeDeps()
    mkdirSync(join(projectRoot, '00_VERIFY'), { recursive: true })
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-sessions.json'),
      JSON.stringify([
        { session_id: 'drive-muwcxxx-abc123', outcome: 'closed', ops: 12 },
        { session_id: 'drive-muwcxxx-def456', outcome: 'disposed', ops: 8 },
      ]),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('探索会话未正常完成')
    expect(html).toContain('def456:disposed')
    expect(html).toContain('2 个探索会话中 1 个未正常收尾')
    // 全 closed 不渲染
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-sessions.json'),
      JSON.stringify([{ session_id: 'drive-muwcxxx-abc123', outcome: 'closed', ops: 12 }]),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y' } })
    const html2 = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html2).not.toContain('探索会话未正常完成')
  })

  it('副标题条件化+转义锁（批10.5 审查C）：存在限制项不宣称全部通过；deliveryDigest 转义后渲染', () => {
    const { deps } = makeDeps()
    mkdirSync(join(projectRoot, '00_VERIFY'), { recursive: true })
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'drive-sessions.json'),
      JSON.stringify([{ session_id: 'drive-muwcxxx-abc123', outcome: 'disposed', ops: 8, findings: 0 }]),
      'utf8',
    )
    holdForMvpConfirm({
      input,
      deps,
      fromPhase: 'desktop-verify',
      notice: { projectName: '记账本', fromPhaseTitle: '验收', driverSummary: { passed: 9, total: 9 }, deliveryDigest: '运行说明<script>alert(1)</script>与<img src=x onerror=1>' },
    })
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    // 副标题：限制项存在 → 不再宣称全部通过
    expect(html).toContain('存在下面这些限制')
    expect(html).not.toContain('自动检查已全部通过')
    // 转义锁：恶意 deliveryDigest 不得以原始标签进入页面
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<img')
  })

  it('击杀汇总行（批10.5 审查C 锚补）：fault-kill 报告存在时「测试有效性抽查」进已确认能做段', () => {
    const { deps } = makeDeps()
    mkdirSync(join(projectRoot, '00_VERIFY'), { recursive: true })
    writeFileSync(
      join(projectRoot, '00_VERIFY', 'fault-kill-report.json'),
      JSON.stringify({ faultKill: { entries: [{ fid: 'F-001', seed: 'FS-VALIDATION-REMOVE', result: 'killed' }], killed: 1, executed: 1, survived: 0, notApplicable: 0, notRun: 0 } }),
      'utf8',
    )
    holdForMvpConfirm({ input, deps, fromPhase: 'desktop-verify', notice: { projectName: 'x', fromPhaseTitle: 'y', driverSummary: { passed: 9, total: 9 } } })
    const html = readFileSync(join(projectRoot, '00_VERIFY', 'mvp-review.html'), 'utf8')
    expect(html).toContain('测试有效性抽查：故意植入 1 个已知缺陷，全部被测试抓住')
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

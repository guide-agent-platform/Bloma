import { restorePromaHome } from '../support/proma-home-guard'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleAgentStreamEvent,
  isPendingDecisionIgnored,
  markPendingDecisionIgnored,
  resetNotificationRuntimeForTests,
  scanPendingDecisionsForReminder,
  setNotificationBackend,
  setReminderIntervalForTests,
  setWindowFocusedHook,
  type NotificationBackend,
} from '../../main/platform/shell/notifications'
import { createProject, updateProject } from '../../main/project/project-service'
import type { AgentEvent, Project } from '../../shared/types'

const REMINDER_INTERVAL = 60_000

function event(projectId: string, type: AgentEvent['type'], payload: Record<string, unknown> = {}): AgentEvent {
  return {
    event_id: 'evt',
    session_id: 'session-1',
    project_id: projectId,
    type,
    payload,
    created_at: new Date().toISOString(),
  }
}

describe('T6 后台执行通知（完成/失败/需决策 + 待决策持续提醒）', () => {
  let home: string
  let project: Project
  let shown: Array<{ notification: { title: string; body: string }; hooks?: { onClick?: () => void; onDismiss?: () => void } }>

  const originalPromaHome = process.env.PROMA_HOME

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'proma-t6-notify-'))
    process.env.PROMA_HOME = home
    project = createProject({ request_id: 'req-t6', mode: 'quick' })
    shown = []
    const backend: NotificationBackend = {
      show: (notification, hooks) => {
        shown.push({ notification, hooks })
      },
      isSupported: () => true,
    }
    setNotificationBackend(backend)
    setWindowFocusedHook(() => false) // 默认未聚焦，便于断言待决策提醒真实触发
    setReminderIntervalForTests(REMINDER_INTERVAL)
  })

  afterEach(() => {
    restorePromaHome(originalPromaHome)
    resetNotificationRuntimeForTests()
  })

  function firstShown(): { title: string; body: string } {
    return shown[0]?.notification ?? { title: '', body: '' }
  }

  describe('完成通知', () => {
    it('引导澄清轮次的 completed 不打扰（阶段 clarifying 不发通知）', () => {
      handleAgentStreamEvent(event(project.project_id, 'completed', { subtype: 'success' }))
      expect(shown).toHaveLength(0)
    })

    it('MVP/迭代完成（阶段 ready）的 completed 发系统通知', () => {
      updateProject(project.project_id, { current_stage: 'ready' })
      handleAgentStreamEvent(event(project.project_id, 'completed', { subtype: 'success' }))
      expect(shown).toHaveLength(1)
      expect(firstShown().title).toContain('已完成')
    })

    it('sketch_ready / mvp_ready 直接发完成通知', () => {
      handleAgentStreamEvent(event(project.project_id, 'sketch_ready', { preview_url: 'http://localhost:1' }))
      expect(firstShown().title).toContain('已完成')
      expect(firstShown().body).toContain('草图')

      handleAgentStreamEvent(event(project.project_id, 'mvp_ready', { preview_url: 'http://localhost:1' }))
      expect(shown).toHaveLength(2)
      expect(shown[1].notification.body).toContain('MVP')
    })
  })

  describe('失败通知', () => {
    it('普通失败发通知', () => {
      handleAgentStreamEvent(event(project.project_id, 'error', { code: 'AGENT_SDK_ERROR', message: '渠道请求失败' }))
      expect(shown).toHaveLength(1)
      expect(firstShown().title).toContain('出问题了')
      expect(firstShown().body).toContain('渠道请求失败')
    })

    it('用户主动停止（AGENT_CANCELLED）不当作失败打扰', () => {
      handleAgentStreamEvent(event(project.project_id, 'error', { code: 'AGENT_CANCELLED' }))
      expect(shown).toHaveLength(0)
    })
  })

  describe('需用户决策通知', () => {
    it('user_decision_required 发通知，并带点击聚焦 / 关闭即忽略的钩子', () => {
      handleAgentStreamEvent(
        event(project.project_id, 'user_decision_required', { kind: 'blocked', title: '缺了按月统计功能' }),
      )
      expect(shown).toHaveLength(1)
      expect(firstShown().title).toContain('需要你决策')
      expect(firstShown().body).toContain('缺了按月统计功能')
      // 点击聚焦、关闭记忽略：钩子都在
      expect(typeof shown[0].hooks?.onClick).toBe('function')
      expect(typeof shown[0].hooks?.onDismiss).toBe('function')
    })

    it('新一轮 user_decision_required 会再次通知（每个决策都是一次独立诉求）', () => {
      handleAgentStreamEvent(event(project.project_id, 'user_decision_required', { kind: 'blocked', title: '决策一' }))
      handleAgentStreamEvent(event(project.project_id, 'user_decision_required', { kind: 'blocked', title: '决策二' }))
      expect(shown).toHaveLength(2)
    })
  })

  describe('待决策持续提醒（不沉底）', () => {
    it('项目处于 blocked_for_user_decision 时按频率上限重复提醒，直至处理', () => {
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'mvp_repair' })

      // T0：首次扫描发提醒
      const first = scanPendingDecisionsForReminder(1_000)
      expect(first.notified).toEqual([project.project_id])
      expect(firstShown().title).toContain('还在等你决策')

      // T0 + 半周期：频率上限内不发
      const second = scanPendingDecisionsForReminder(1_000 + REMINDER_INTERVAL / 2)
      expect(second.notified).toHaveLength(0)

      // 满一个周期后：持续提醒（不沉底）
      const third = scanPendingDecisionsForReminder(1_000 + REMINDER_INTERVAL)
      expect(third.notified).toEqual([project.project_id])
      expect(shown).toHaveLength(2)
    })

    it('窗口聚焦时跳过（用户正看着决策卡），失焦后能立刻提醒', () => {
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'test_repair' })
      setWindowFocusedHook(() => true)

      const result = scanPendingDecisionsForReminder(1_000)
      expect(result.notified).toHaveLength(0)
      expect(result.skippedFocused).toEqual([project.project_id])

      // 失焦后同一次时间窗口也能提醒（聚焦跳过的空窗不浪费）
      setWindowFocusedHook(() => false)
      const next = scanPendingDecisionsForReminder(2_000)
      expect(next.notified).toEqual([project.project_id])
    })

    it('显式忽略后不再提醒，直到项目脱离阻塞态后新阻塞重新武装', () => {
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'judge_return' })

      handleAgentStreamEvent(event(project.project_id, 'user_decision_required', { kind: 'blocked', title: '等待' }))
      markPendingDecisionIgnored(project.project_id)
      expect(isPendingDecisionIgnored(project.project_id)).toBe(true)

      const ignoredScan = scanPendingDecisionsForReminder(1_000)
      expect(ignoredScan.notified).toHaveLength(0)
      expect(ignoredScan.skippedIgnored).toEqual([project.project_id])

      // 用户处理：阶段脱离阻塞 → 忽略标记清除
      handleAgentStreamEvent(event(project.project_id, 'stage_changed', { stage: 'ready' }))
      expect(isPendingDecisionIgnored(project.project_id)).toBe(false)

      // 项目再次阻塞 → 重新武装，能再次提醒
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'mvp_repair' })
      const rearMed = scanPendingDecisionsForReminder(2_000)
      expect(rearMed.notified).toEqual([project.project_id])
    })

    it('已处理的待决策项目从 pending 中消失，状态被清理', () => {
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'mvp_repair' })
      scanPendingDecisionsForReminder(1_000)
      expect(shown).toHaveLength(1)

      // 决策被处理（阶段离开阻塞态）
      updateProject(project.project_id, { current_stage: 'ready' })
      const result = scanPendingDecisionsForReminder(1_000 + REMINDER_INTERVAL)
      expect(result.pending).toHaveLength(0)
      expect(result.notified).toHaveLength(0)
      // 清理后新一轮阻塞会重新提醒（无旧状态压制）
      updateProject(project.project_id, { current_stage: 'blocked_for_user_decision', blocked_action: 'mvp_repair' })
      const again = scanPendingDecisionsForReminder(2_000)
      expect(again.notified).toEqual([project.project_id])
    })
  })
})

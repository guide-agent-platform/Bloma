/**
 * T6 后台执行通知（主进程侧）
 *
 * 设计要点（勿破坏）：
 * - 本模块**不静态 import electron**（避免 vitest 纯 node 环境加载 electron 失败）：
 *   生产后端由 index.ts 注入（Electron Notification），测试注入假后端。
 * - 通知入口 `handleAgentStreamEvent(event)`：completed / error / user_decision_required
 *   三类触发即时系统通知；stage_changed 离开阻塞态时清理待决策提醒状态。
 *   completed 只对「真完成」通知（项目阶段 ready/completed），引导澄清轮次的
 *   completed 是对话轮次不是任务完成，不打扰（频率上限的一部分）。
 * - 待决策持续提醒：以项目存储 `current_stage === 'blocked_for_user_decision'` 为持久
 *   依据（切项目/重启都找得回），轮询扫描（默认 5 分钟，`BLOMA_PENDING_REMINDER_INTERVAL_MS`
 *   可调）重发系统通知，直至处理或用户显式忽略；窗口聚焦时跳过（用户正看着决策卡），
 *   频率上限防打扰。
 */

import type { AgentEvent, Project } from '../../../shared/types'
import { findProject, listProjects } from '../../project/project-service'

type ProjectBlockedAction = Project['blocked_action']

export interface SystemNotification {
  title: string
  body: string
}

export interface NotificationHooks {
  onClick?: () => void
  /** 用户显式忽略（关闭通知）。点击与关闭的竞态由后端负责（点击不触发忽略）。 */
  onDismiss?: () => void
}

export interface NotificationBackend {
  show(notification: SystemNotification, hooks?: NotificationHooks): void
  isSupported(): boolean
}

const noopBackend: NotificationBackend = {
  show: () => undefined,
  isSupported: () => false,
}

let backend: NotificationBackend = noopBackend
/** 生产注入真实主窗焦点检查；默认视为聚焦（不打扰）——接线忘设也不至于骚扰。 */
let isWindowFocused: () => boolean = () => true
/** 生产注入聚焦主窗动作（点通知回到应用）。 */
let focusWindowAction: () => void = () => undefined

export function setNotificationBackend(next: NotificationBackend): void {
  backend = next
}

export function setWindowFocusedHook(hook: () => boolean): void {
  isWindowFocused = hook
}

export function setFocusWindowAction(action: () => void): void {
  focusWindowAction = action
}

const DEFAULT_REMINDER_INTERVAL_MS = 5 * 60 * 1000
let reminderIntervalMs = readIntervalFromEnv()

function readIntervalFromEnv(): number {
  const raw = process.env.BLOMA_PENDING_REMINDER_INTERVAL_MS
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REMINDER_INTERVAL_MS
}

export function setReminderIntervalForTests(ms: number): void {
  reminderIntervalMs = ms
}

/** project_id：用户显式忽略（关闭通知等）——同一项目不再反复提醒，直到该项目脱离阻塞态。 */
const ignored = new Set<string>()
/** project_id -> 上次系统通知时间戳（频率上限与「是否已提醒过」共用）。 */
const lastNotifiedAt = new Map<string, number>()

export function resetNotificationRuntimeForTests(): void {
  backend = noopBackend
  isWindowFocused = () => true
  focusWindowAction = () => undefined
  reminderIntervalMs = readIntervalFromEnv()
  ignored.clear()
  lastNotifiedAt.clear()
  stopPendingDecisionReminderLoop()
}

// =========================================================================
// 事件路由：agent 流事件 → 系统通知
// =========================================================================

export function handleAgentStreamEvent(event: AgentEvent): void {
  const projectId = event.project_id
  if (!projectId) return
  switch (event.type) {
    case 'completed':
      handleCompleted(projectId)
      break
    case 'error': {
      const code = typeof event.payload.code === 'string' ? event.payload.code : ''
      if (code === 'AGENT_CANCELLED') break // 用户主动停止，不是失败，不打扰
      handleFailed(projectId, typeof event.payload.message === 'string' ? event.payload.message : undefined)
      break
    }
    case 'sketch_ready':
      notifyTaskCompleted(projectId, '草图已经画好了，看看预览是不是你要的样子？确认后我继续做 MVP。')
      break
    case 'mvp_ready':
      notifyTaskCompleted(projectId, 'MVP 已经生成好了，可以去预览区看看；想走向完整程序（数据上服务端/加功能/导出）直接说。')
      break
    case 'user_decision_required':
      handleDecisionRequired(projectId, typeof event.payload.title === 'string' ? event.payload.title : undefined)
      break
    case 'stage_changed': {
      const stage = typeof event.payload.stage === 'string' ? event.payload.stage : ''
      // 项目脱离阻塞态：清掉忽略标记与提醒时间，下一轮阻塞能正常重新提醒
      if (stage !== 'blocked_for_user_decision') clearProjectReminderState(projectId)
      break
    }
    default:
      break
  }
}

function handleCompleted(projectId: string): void {
  // completed 是通用终态：引导澄清轮次也会发。只对「真完成」（当前阶段 ready/completed）
  // 弹系统通知——MVP / 迭代 / 修复闭环；澄清轮次用户正对着聊天窗，通知纯属打扰。
  let stage: string
  try {
    stage = findProject(projectId).current_stage
  } catch {
    stage = ''
  }
  if (stage === 'ready' || stage === 'completed') {
    notifyTaskCompleted(projectId, '生成和测试都跑完了，可以点开预览看看；想调整直接告诉我。')
  }
}

function handleFailed(projectId: string, message: string | undefined): void {
  showSystem(projectId, `「${projectName(projectId)}」出问题了`, message || '生成中途失败，请回到应用看看怎么回事。', {
    onClick: focusWindow,
  })
}

function handleDecisionRequired(projectId: string, title: string | undefined): void {
  showSystem(projectId, `「${projectName(projectId)}」需要你决策`, title || '有一个选择需要你拍板，等你回复后继续。', {
    onClick: focusWindow,
    onDismiss: () => markPendingDecisionIgnored(projectId),
  })
  // 记下时间：待决策轮询的频率上限从这次通知算起
  lastNotifiedAt.set(projectId, Date.now())
}

function notifyTaskCompleted(projectId: string, body: string): void {
  showSystem(projectId, `「${projectName(projectId)}」已完成`, body, { onClick: focusWindow })
}

function showSystem(projectId: string, title: string, body: string, hooks?: NotificationHooks): void {
  if (!backend.isSupported()) return
  backend.show({ title, body }, hooks)
}

function focusWindow(): void {
  focusWindowAction()
}

function projectName(projectId: string): string {
  try {
    const name = findProject(projectId).name
    return name || '项目'
  } catch {
    // 项目索引缺失（测试字面 id / 已删除）时用兜底文案，不把通知链路打挂
    return '项目'
  }
}

// =========================================================================
// 待决策持续提醒（不沉底）
// =========================================================================

export interface PendingDecisionScanResult {
  /** 本次实际发了系统通知的项目 */
  notified: string[]
  /** 当前所有待决策项目 */
  pending: string[]
  /** 待决策但窗口聚焦被跳过（用户正看着决策卡） */
  skippedFocused: string[]
  /** 被显式忽略、本次不发 */
  skippedIgnored: string[]
}

/**
 * 轮询一次：对「仍处于 blocked_for_user_decision」的项目按频率上限重发提醒。
 * 清理已脱离阻塞项目的旧状态（忽略标记/时间戳），保证新一轮阻塞能重新提醒。
 */
export function scanPendingDecisionsForReminder(now: number): PendingDecisionScanResult {
  const pending = listProjects('active').filter((p) => p.current_stage === 'blocked_for_user_decision')
  const pendingIds = new Set(pending.map((p) => p.project_id))

  for (const key of [...lastNotifiedAt.keys()]) {
    if (!pendingIds.has(key)) lastNotifiedAt.delete(key)
  }
  for (const key of [...ignored]) {
    if (!pendingIds.has(key)) ignored.delete(key)
  }

  const notified: string[] = []
  const skippedFocused: string[] = []
  const skippedIgnored: string[] = []
  for (const project of pending) {
    if (ignored.has(project.project_id)) {
      skippedIgnored.push(project.project_id)
      continue
    }
    const last = lastNotifiedAt.get(project.project_id)
    // 频率上限：仅当「上次确实通知过」且还没到周期才跳过；从未通知过（undefined）立即提醒
    if (last !== undefined && now - last < reminderIntervalMs) continue
    if (isWindowFocused()) {
      // 用户正看着应用（决策卡可见），本次跳过但**不推进**时间戳——失焦后立刻能提醒
      skippedFocused.push(project.project_id)
      continue
    }
    lastNotifiedAt.set(project.project_id, now)
    showSystem(
      project.project_id,
      `「${project.name}」还在等你决策`,
      blockedDecisionBody(project.blocked_action),
      {
        onClick: focusWindow,
        onDismiss: () => markPendingDecisionIgnored(project.project_id),
      },
    )
    notified.push(project.project_id)
  }
  return { notified, pending: [...pendingIds], skippedFocused, skippedIgnored }
}

function blockedDecisionBody(action: ProjectBlockedAction | undefined): string {
  switch (action) {
    case 'mvp_repair':
      return 'MVP 预览反复启动失败，我停在这里等你选：继续修复 / 接受现状 / 换个做法。'
    case 'test_repair':
      return '功能测试反复不过，我停在这里等你选：继续修复 / 接受现状 / 补充说明。'
    case 'judge_return':
      return '质量审查反复不过，我停在这里等你选：继续修复 / 接受现状 / 补充说明。'
    case 'security_repair':
      return '检测到的安全隐患反复修不好，我停在这里等你选：继续修复 / 接受现状 / 补充说明。'
    default:
      return '有一个决策还等着你拍板，处理完我就能继续。'
  }
}

/** 用户显式忽略（关闭系统通知 / 其他入口）：同一项目不再反复提醒，直到该项目脱离阻塞态。 */
export function markPendingDecisionIgnored(projectId: string): void {
  ignored.add(projectId)
  lastNotifiedAt.set(projectId, Date.now())
}

export function isPendingDecisionIgnored(projectId: string): boolean {
  return ignored.has(projectId)
}

function clearProjectReminderState(projectId: string): void {
  ignored.delete(projectId)
  lastNotifiedAt.delete(projectId)
}

// =========================================================================
// 轮询定时器（生产由 index.ts 启动）
// =========================================================================

let reminderTimer: ReturnType<typeof setInterval> | undefined

export function startPendingDecisionReminderLoop(): void {
  if (reminderTimer) return
  reminderTimer = setInterval(() => {
    try {
      scanPendingDecisionsForReminder(Date.now())
    } catch {
      // 轮询异常不崩应用：下轮重试
    }
  }, reminderIntervalMs)
}

export function stopPendingDecisionReminderLoop(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer)
    reminderTimer = undefined
  }
}

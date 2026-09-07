/**
 * Sprint 2 新增 Atoms — B 角色
 *
 * 本文件为 Sprint 2 新增的 Jotai atoms，集成到主项目时合并进
 * renderer/agent-atoms.ts 或 renderer/components/atoms.ts。
 *
 * 所有类型从 shared/types 导入。
 *
 * === F-001 修复（2026-08-12）===
 * 已移除 `require()` 动态导入（ESM/浏览器环境不可用），
 * 改为顶部静态 ES import `pendingPermissionRequestsAtom`。
 * `permissionQueueAtom` 从 `pendingPermissionRequestsAtom` 派生，
 * 与 `PermissionDialog.tsx` 内部展平逻辑共享同一数据源。
 */

import { atom } from 'jotai'
import type { CategoryRoutingRoleView, CategoryRoutingView, Channel, PermissionRequest, PromptSlotId, PromptSlotInfo } from '../../shared/types'
import { pendingPermissionRequestsAtom } from '../agent-atoms'

// =========================================================================
// 1. 权限模式（全局，可在设置中切换）
// =========================================================================

/**
 * 当前权限模式 atom 定义已上移至 agent-atoms.ts（F8：全局监听器需在收到
 * permission_mode_changed 广播时写它；定义在上游消除 agent-atoms ← atoms-sprint2
 * 循环依赖）。此处 re-export 保持既有 import 路径兼容。
 */
export { permissionModeAtom } from '../agent-atoms'

// =========================================================================
// 2. 权限队列（从 agent-atoms 的 pendingPermissionRequestsAtom 派生，FIFO）
// =========================================================================

/** 权限请求队列（FIFO，按创建时间排序） */
export const permissionQueueAtom = atom<PermissionRequest[]>((get) => {
  const map = get(pendingPermissionRequestsAtom)
  const all: PermissionRequest[] = []
  for (const requests of map.values()) {
    all.push(...requests)
  }
  return all.sort(
    (a, b) =>
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  )
})

// =========================================================================
// 3. 渠道管理状态（channel:* IPC 的真实类型见 shared/types 的 ElectronAPI.channels，此处不重复手写）
// =========================================================================

/** 已配置的渠道列表 */
export const channelsListAtom = atom<Channel[]>([])

/** 渠道列表加载状态 */
export const channelsLoadingAtom = atom<'idle' | 'loading' | 'loaded' | 'error'>('idle')

/**
 * 聊天输入草稿（WC-P2，2026-08-29）：提升到 atom 使零渠道提交被拦截直达设置页后，
 * 返回工作区时输入仍在——连接成功即可直接发送，不重打一遍。
 */
export const chatInputDraftAtom = atom('')

/**
 * 是否有可用 AI 渠道（QW#1 ux-first-run-0basics I1）：
 * null=未决（加载中/未加载）；true/false=已决（有启用渠道且含启用模型）。
 * 供 WorkspaceHeader 三态徽标（「未配置 AI / AI 就绪 / 离线」）消费，替代 navigator.onLine 误导。
 */
export const hasUsableChannelsAtom = atom<boolean | null>((get) => {
  const loading = get(channelsLoadingAtom)
  if (loading !== 'loaded') return null
  return get(channelsListAtom).some((channel) => channel.enabled && (channel.models ?? []).some((model) => model.enabled))
})

/** 模块级 in-flight 守卫：App 与 Settings 页只允许首次真正发一次 channels.list（审查 P2-②） */
let channelsFetchStarted = false

/** 测试用：重置 in-flight 守卫（模块级状态跨用例会污染） */
export function resetChannelsFetchFlagForTests(): void {
  channelsFetchStarted = false
}

/**
 * 加载渠道列表到 atoms（QW#1：Header 三态徽标需要启动时就绪；Settings 页复用）。
 * 守卫：首次调用真正发请求，后续调用直接返回（保存/删除渠道由 handler 本地 setChannels 同步，无需重拉）。
 */
export async function refreshChannelsList(
  setChannels: (channels: Channel[]) => void,
  setLoading: (state: 'idle' | 'loading' | 'loaded' | 'error') => void,
): Promise<void> {
  if (channelsFetchStarted) return
  channelsFetchStarted = true
  const api = window.electronAPI
  if (!api?.channels?.list) {
    setLoading('error')
    return
  }
  setLoading('loading')
  try {
    const result = await api.channels.list({ request_id: crypto.randomUUID() })
    if (result.ok) {
      setChannels(result.data)
      setLoading('loaded')
    } else {
      setLoading('error')
    }
  } catch {
    setLoading('error')
  }
}

/** 渠道测试连接结果 */
export const channelTestResultAtom = atom<{
  channelId: string
  ok: boolean
  message: string
} | null>(null)

// =========================================================================
// 3.5 角色路由（M5「职责分工」：三角色渠道视图模型）
// =========================================================================

/** 三角色职责视图模型（null = 未加载/不可用） */
export const categoryRoutingRoleViewsAtom = atom<CategoryRoutingRoleView[] | null>(null)

/** 历史类别视图 atom 保留，供旧组件/测试兼容。 */
export const categoryRoutingViewsAtom = atom<CategoryRoutingView[] | null>(null)


// =========================================================================
// 4. MVP 确认 / 继续操作（供用户决策）
// =========================================================================

// userDecisionAtom 已移除（N-003 修复：未被任何组件消费的死代码）。
// settingsOpenAtom / settingsActiveTabAtom / SettingsTab 已移除（2026-08-15）：
// 设置页改为 route === 'settings' 路由，不再需要这些全局状态。
// blocked_for_user_decision 阶段的 UI 决策需求由 MvpStatusBanner 通过
// agentStreamStateFamily events 中的 stage_changed 事件直接派生。

// =========================================================================
// 5. 提示词配置状态（设置页「提示词配置」Tab）
// =========================================================================

/** 提示词槽位列表 */
export const promptSlotsAtom = atom<PromptSlotInfo[]>([])

/** 提示词槽位列表加载状态 */
export const promptSlotsLoadingAtom = atom<'idle' | 'loading' | 'loaded' | 'error'>('idle')

/** 当前选中的提示词槽位 id */
export const promptActiveSlotIdAtom = atom<PromptSlotId | null>(null)

/** 保存/恢复提示词的结果提示 */
export const promptSaveStatusAtom = atom<{ ok: boolean; message: string } | null>(null)

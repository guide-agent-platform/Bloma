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

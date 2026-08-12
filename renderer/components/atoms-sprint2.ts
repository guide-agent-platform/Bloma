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
import type {
  PermissionRequest,
  Channel,
  ChannelModel,
  ProviderType,
  RequestEnvelope,
  ApiResult,
} from '../../shared/types'
import { pendingPermissionRequestsAtom } from '../agent-atoms'

// =========================================================================
// 1. 权限模式（全局，可在设置中切换）
// =========================================================================

/** 当前权限模式：safe=自动拒绝危险 / ask=弹窗确认 / allow-all=全部放行 */
export const permissionModeAtom = atom<'safe' | 'ask' | 'allow-all'>('ask')

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
// 3. 渠道管理 —— ElectronAPI.channels 期望接口签名（M-001 修复）
// =========================================================================

/**
 * A 侧实现 `channel:*` IPC 通道后，`window.electronAPI.channels` 的期望接口。
 * 供集成者参考——实际实现位于 main/ipc.ts → preload/bridge.ts。
 */
export interface ElectronChannelsAPI {
  list(
    input: RequestEnvelope,
  ): Promise<ApiResult<Channel[]>>
  create(
    input: { name: string; provider_type: ProviderType; base_url: string; api_key: string; models?: ChannelModel[] } & RequestEnvelope,
  ): Promise<ApiResult<Channel>>
  test(
    input: { channel_id: string } & RequestEnvelope,
  ): Promise<ApiResult<{ ok: boolean; message: string; models?: ChannelModel[] }>>
  delete(
    input: { channel_id: string } & RequestEnvelope,
  ): Promise<ApiResult<{ deleted: boolean }>>
}

// =========================================================================
// 4. 渠道管理状态
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
// 5. 设置页路由（集成到 WorkspaceHeader / App）
// =========================================================================

export type SettingsTab = 'channels' | 'general'

export const settingsOpenAtom = atom<boolean>(false)
export const settingsActiveTabAtom = atom<SettingsTab>('channels')

// =========================================================================
// 6. MVP 确认 / 继续操作（供用户决策）
// =========================================================================

// userDecisionAtom 已移除（N-003 修复：未被任何组件消费的死代码）。
// blocked_for_user_decision 阶段的 UI 决策需求由 MvpStatusBanner 通过
// agentStreamStateFamily events 中的 stage_changed 事件直接派生。

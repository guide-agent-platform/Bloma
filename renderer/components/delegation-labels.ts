import type { DelegationViewStatus } from '../agent-atoms'

/**
 * 委派协作视图共享标签映射（审计 P3-8：此前 CollaborationPanel 与 DelegationFeed 各持一份
 * 硬编码拷贝，新增 role/status 需双改）。role 用宽松 Record<string,string>——渲染端容忍
 * 未知的自定义 role（显示原始值），status 键收紧为 DelegationViewStatus。
 */

export const DELEGATION_ROLE_LABELS: Record<string, string> = {
  explore: '探索',
  research: '调研',
  implement: '实现',
  review: '审查',
  custom: '协作',
}

export const DELEGATION_STATUS_LABELS: Record<DelegationViewStatus, string> = {
  running: '协作中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已停止',
}

export const DELEGATION_STATUS_COLORS: Record<DelegationViewStatus, string> = {
  running: 'var(--color-warning)',
  completed: 'var(--color-quick)',
  failed: 'var(--color-danger)',
  cancelled: 'var(--gray-400)',
}

/**
 * PermissionDialog — 权限确认弹窗
 *
 * Sprint 2 B 交付物 · A2-12 硬依赖
 *
 * 触发链：
 *   main 发 permission_requested → agent-atoms 的 setupGlobalAgentListeners
 *   收集到 pendingPermissionRequestsAtom → PermissionDialog 渲染 →
 *   用户 allow/deny → electronAPI.permissions.respond → main resolve
 *
 * 等级规则（对齐 api-spec §13）：
 *   - safe：自动允许/拒绝（不弹窗）
 *   - warning：弹确认，可"记住我的选择"（会话内不再询问）
 *   - dangerous：必须每次明确确认（无"记住"选项）
 *
 * 无人值守豁免（对齐 A2-12）：
 *   自动快照/自动修复等自动化路径默认 safe 模式，不弹窗；
 *   仅用户显式操作（手动回滚、沙箱运行等）走 ask 弹窗流程。
 *
 * 集成方式：
 *   在 App.tsx 中挂载 <PermissionDialog />，始终渲染；
 *   组件内部通过 Jotai useAtomValue 订阅 pendingPermissionRequestsAtom。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { DangerLevel, PermissionRequest } from '../../shared/types'
import { clearPermissionRequest } from '../agent-atoms'
import { permissionQueueAtom } from './atoms-sprint2'

// =========================================================================
// 内联 SVG 图标（主 icons.tsx 中没有这些，集成时可迁移过去）
// =========================================================================

const IconX: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" /><path d="M6 6l12 12" />
  </svg>
)

const IconShieldCheck: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.06 1.06 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="m9 12 2 2 4-4" />
  </svg>
)

const IconShield: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.06 1.06 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
  </svg>
)

const IconShieldAlert: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.06 1.06 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    <path d="M12 8v4" /><path d="M12 16h.01" />
  </svg>
)

// =========================================================================
// 等级 → 视觉映射
// =========================================================================

const DANGER_LABEL: Record<DangerLevel, string> = {
  safe: '安全操作',
  warning: '需要确认',
  dangerous: '⚠️ 重要操作',
}

const DANGER_COLOR: Record<DangerLevel, string> = {
  safe: 'var(--color-success)',
  warning: '#F59E0B',
  dangerous: 'var(--color-danger)',
}

const DANGER_BG: Record<DangerLevel, string> = {
  safe: '#ECFDF5',
  warning: '#FFFBEB',
  dangerous: '#FEF2F2',
}

const DANGER_ICON: Record<DangerLevel, React.FC<{ size?: number }>> = {
  safe: IconShieldCheck,
  warning: IconShield,
  dangerous: IconShieldAlert,
}

// =========================================================================
// 工具名称 → P0 用户可读名称
// =========================================================================

const TOOL_NAME_READABLE: Record<string, string> = {
  generate_sketch: '生成验证草图',
  generate_mvp: '生成完整功能',
  run_project: '启动预览',
  run_gwt_tests: '运行功能检查',
  capture_preview: '截取预览图',
  create_snapshot: '保存当前版本',
  rollback_snapshot: '回到旧版本',
  collect_dom_context: '读取点击位置',
  run_security_scan: '安全扫描',
  create_project_sandbox: '创建项目目录',
}

function toolReadableName(toolName: string): string {
  return TOOL_NAME_READABLE[toolName] ?? toolName
}

// =========================================================================
// Props & Component
// =========================================================================

export interface PermissionDialogProps {
  /**
   * 权限模式。
   * 'safe'      → 危险操作直接拒绝不弹窗（无人值守/自动化管线默认）
   * 'ask'       → 弹窗确认（默认）
   * 'allow-all' → 全部自动放行（仅开发/演示用）
   */
  mode?: 'safe' | 'ask' | 'allow-all'
}

export const PermissionDialog: React.FC<PermissionDialogProps> = ({
  mode = 'ask',
}) => {
  // -------- 从 atoms-sprint2 订阅权限队列（N-004 修复：消除重复展平逻辑）--------
  const requests = useAtomValue(permissionQueueAtom)

  // FIFO 队首为当前展示的请求
  const currentRequest = requests.length > 0 ? requests[0] : null

  const [rememberChecked, setRememberChecked] = useState(false)

  // 请求切换时重置记住选择
  useEffect(() => {
    setRememberChecked(false)
  }, [currentRequest?.id])

  // ==================== 响应处理 ====================

  const handleRespond = useCallback(
    (decision: 'allow' | 'deny') => {
      if (!currentRequest) return

      const api = window.electronAPI
      if (!api?.permissions?.respond) return

      // B3 修复：await respond，仅在 IPC 结算后清除队列。
      // 之前是 fire-and-forget + 立即清除，respond 失败时 UI 假成功、主进程 Promise 仍挂起。
      api.permissions
        .respond({
          request_id: crypto.randomUUID(),
          permission_request_id: currentRequest.id,
          session_id: currentRequest.session_id,
          decision,
          remember_for_session: decision === 'allow' && rememberChecked,
        })
        .then(() => {
          clearPermissionRequest(currentRequest.session_id, currentRequest.id)
        })
        .catch(() => {
          // respond 失败（请求已过期等）：仍清除队列，避免 UI 卡死
          clearPermissionRequest(currentRequest.session_id, currentRequest.id)
        })
    },
    [currentRequest, rememberChecked],
  )

  // ==================== safe 模式自动处理 ====================

  useEffect(() => {
    if (mode !== 'safe' || !currentRequest) return
    if (currentRequest.danger_level === 'dangerous') {
      // safe 模式：危险工具直接拒绝
      handleRespond('deny')
      return
    }
    // safe/warning 工具：A 侧 PermissionService.canUseTool 在 safe 模式下直接放行，
    // 不会产生 permission_requested 事件；这里作为兜底：如果仍收到了就自动放行。
    if (
      currentRequest.danger_level === 'safe' ||
      currentRequest.danger_level === 'warning'
    ) {
      handleRespond('allow')
    }
  }, [mode, currentRequest, handleRespond])

  // ==================== 渲染判断 ====================

  // 无请求 → 不渲染
  if (!currentRequest) return null

  // allow-all 模式 → 不弹窗
  if (mode === 'allow-all') return null

  // safe 模式不在 UI 层弹窗（已在 effect 中自动处理）
  if (mode === 'safe') return null

  // ask 模式：按等级渲染
  const level = currentRequest.danger_level
  const Icon = DANGER_ICON[level]
  const showRemember = level === 'warning'

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`权限确认：${toolReadableName(currentRequest.tool_name)}`}
      data-ai-id="permission-dialog"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'tile-enter 0.15s ease both',
      }}
      onClick={(e) => {
        // dangerous 不允许点遮罩关闭
        if (level !== 'dangerous' && e.target === e.currentTarget) {
          handleRespond('deny')
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && level !== 'dangerous') {
          handleRespond('deny')
        }
      }}
    >
      <div
        style={{
          background: 'var(--white)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-6)',
          maxWidth: 420,
          width: '90%',
          boxShadow: 'var(--shadow-lg)',
          animation: 'tile-enter 0.2s ease both',
        }}
      >
        {/* ── 头部 ── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
          }}
        >
          <span
            style={{
              width: 40,
              height: 40,
              borderRadius: 'var(--radius-md)',
              background: DANGER_BG[level],
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: DANGER_COLOR[level],
              flexShrink: 0,
            }}
          >
            <Icon size={20} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <p
              style={{
                fontSize: 'var(--font-size-sm)',
                fontWeight: 700,
                color: 'var(--color-text)',
                marginBottom: 2,
                lineHeight: 1.3,
              }}
            >
              {toolReadableName(currentRequest.tool_name)}
            </p>
            <p
              style={{
                fontSize: 'var(--font-size-xs)',
                fontWeight: 500,
                color: DANGER_COLOR[level],
              }}
            >
              {DANGER_LABEL[level]}
            </p>
          </div>
          {/* 非 dangerous 级别才有关闭按钮 */}
          {level !== 'dangerous' && (
            <button
              onClick={() => handleRespond('deny')}
              aria-label="关闭"
              style={{
                width: 28,
                height: 28,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-text-muted)',
                flexShrink: 0,
                transition: 'all var(--transition-fast)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--color-surface-muted)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent'
              }}
            >
              <IconX size={16} />
            </button>
          )}
        </div>

        {/* ── 操作说明 ── */}
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text)',
            lineHeight: 'var(--line-height-base)',
            marginBottom: 'var(--space-4)',
          }}
        >
          {currentRequest.user_visible_summary ||
            `即将执行：${toolReadableName(currentRequest.tool_name)}`}
        </p>

        {/* ── "记住选择"（仅 warning） ── */}
        {showRemember && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-muted)',
              marginBottom: 'var(--space-4)',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            <input
              type="checkbox"
              checked={rememberChecked}
              onChange={(e) => setRememberChecked(e.target.checked)}
              style={{ accentColor: 'var(--color-quick)', cursor: 'pointer' }}
            />
            这次对话中不再询问类似操作
          </label>
        )}

        {/* ── 操作按钮 ── */}
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            justifyContent: 'flex-end',
          }}
        >
          <button
            onClick={() => handleRespond('deny')}
            data-ai-id="permission-deny"
            style={{
              height: 36,
              padding: '0 var(--space-5)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              color: 'var(--color-text)',
              background: 'var(--color-surface-muted)',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--color-surface)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'var(--color-surface-muted)'
            }}
          >
            取消
          </button>
          <button
            onClick={() => handleRespond('allow')}
            data-ai-id="permission-allow"
            style={{
              height: 36,
              padding: '0 var(--space-5)',
              fontSize: 'var(--font-size-sm)',
              fontWeight: 600,
              color: 'var(--white)',
              background:
                'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'all var(--transition-fast)',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)'
              e.currentTarget.style.boxShadow =
                '0 6px 16px -2px rgba(124,58,237,0.5)'
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'none'
              e.currentTarget.style.boxShadow =
                '0 4px 12px -2px rgba(124,58,237,0.4)'
            }}
          >
            确认
          </button>
        </div>

        {/* ── 队列提示 ── */}
        {requests.length > 1 && (
          <p
            style={{
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text-muted)',
              marginTop: 'var(--space-3)',
              textAlign: 'center',
            }}
          >
            还有 {requests.length - 1} 个操作等待确认
          </p>
        )}
      </div>
    </div>
  )
}

export default PermissionDialog

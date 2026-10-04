/**
 * MvpStatusBanner — MVP 状态横幅
 *
 * Sprint 2 B 交付物
 *
 * 消费 A 侧通过 setupGlobalAgentListeners 推送的 AgentEvent：
 *   - mvp_ready       → MVP 生成成功，显示预览入口
 *   - repairing       → 自动修复中
 *
 * 数据来源：agentStreamStateFamily(sessionId).events 中的最近事件
 *   + agent-atoms 已有的 workflowStageAtom
 *
 * 集成方式：
 *   在 WorkspaceShell 中 Header 下方挂载 <MvpStatusBanner />。
 */

import React, { useMemo, useState } from 'react'
import { useExperimentSwitches } from '../hooks/use-experiment-switches'
import { atom, useAtomValue, useSetAtom } from 'jotai'
import type { AgentEvent, WorkflowStage } from '../../shared/types'
import type { AgentStreamState } from '../agent-atoms'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
  currentProjectAtom,
  globalUserErrorAtom,
  workflowStageAtom,
  STAGE_LABEL_MAP,
} from '../agent-atoms'

// =========================================================================
// 模块级常量：nullSessionFallback
//
// 当 activeAgentSessionIdAtom 为 null（会话尚未创建）时使用此稳定的空 atom，
// 避免在 atomFamily 中创建不可回收的 '__unused__' key。
// 同时保证所有 hooks 在每次渲染中以相同顺序调用，不违反 React Hooks 规则。
// =========================================================================

const nullSessionFallback = atom<AgentStreamState>({
  running: false,
  events: [],
  content: '',
})

// =========================================================================
// 内联 SVG 图标
// =========================================================================

const IconCheck: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
)

const IconX: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M18 6 6 18" /><path d="M6 6l12 12" />
  </svg>
)

const IconRotateCw: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
)

const IconAlertTriangle: React.FC<{ size?: number }> = ({ size = 24 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth={2} strokeLinecap="round"
    strokeLinejoin="round" aria-hidden>
    <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
    <path d="M12 9v4" /><path d="M12 17h.01" />
  </svg>
)

// =========================================================================
// 从事件流中提取 MVP 相关 payload
// =========================================================================

interface BannerState {
  visible: boolean
  variant: 'generating' | 'ready' | 'testing' | 'judging' | 'repairing' | 'blocked' | 'none'
  title: string
  detail?: string
  stage: WorkflowStage
}

function deriveBannerState(
  events: AgentEvent[],
  stage: WorkflowStage,
): BannerState {
  // 2026-10-04 web 线残留清理：mvp_ready/repairing 事件已无发射方（web 生成链 10-01
  // 退役），事件腿删除——横幅现在完全由权威阶段驱动（桌面线 stage_changed 同步）。
  void events

  // 基于阶段的 fallback
  switch (stage) {
    case 'sketch_ready':
      return { visible: true, variant: 'ready', title: STAGE_LABEL_MAP[stage], detail: '草图已生成，确认后即可生成完整功能，或继续对话调整方向', stage }
    // 2026-10-04 web 线残留清理：mvp_ready 死事件腿删除后，导出/升级入口改由权威阶段
    // 驱动——ready（旧线终态）与 completed（桌面线 delivered）都应能导出项目。
    case 'ready':
      return { visible: true, variant: 'ready', title: STAGE_LABEL_MAP[stage], detail: '完整功能已生成，可导出项目或继续迭代', stage }
    case 'completed':
      return { visible: true, variant: 'ready', title: '项目已交付', detail: '完整功能已交付，可导出项目或继续迭代', stage }
    case 'generating_mvp':
      return { visible: true, variant: 'generating', title: STAGE_LABEL_MAP[stage], detail: '正在生成完整项目，请稍候…', stage }
    case 'iterating':
      return { visible: true, variant: 'generating', title: STAGE_LABEL_MAP[stage], detail: '正在按你的新想法重新生成，稍候会自动测试并审查…', stage }
    case 'testing':
      return { visible: true, variant: 'testing', title: STAGE_LABEL_MAP[stage], detail: '正在运行功能检查…', stage }
    case 'judge_review':
      return { visible: true, variant: 'judging', title: STAGE_LABEL_MAP[stage], detail: '裁判正在审查功能完整性…', stage }
    case 'repairing':
      return { visible: true, variant: 'repairing', title: STAGE_LABEL_MAP[stage], detail: '正在修复检测到的问题…', stage }
    case 'blocked_for_user_decision':
      return { visible: true, variant: 'blocked', title: STAGE_LABEL_MAP[stage], detail: '需要你做出决定后才能继续', stage }
    default:
      return { visible: false, variant: 'none', title: '', stage }
  }
}

// =========================================================================
// 变体 → 视觉映射
// =========================================================================

const VARIANT_STYLE: Record<BannerState['variant'], { bg: string; border: string; color: string; icon: React.FC<{ size?: number }> | null; animated: boolean }> = {
  generating:   { bg: '#F5F3FF', border: '#DDD6FE', color: '#6D28D9', icon: null, animated: true },
  ready:        { bg: '#ECFDF5', border: '#A7F3D0', color: '#065F46', icon: IconCheck, animated: false },
  testing:      { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', icon: null, animated: true },
  judging:      { bg: '#F5F3FF', border: '#DDD6FE', color: '#6D28D9', icon: null, animated: true },
  repairing:    { bg: '#EFF6FF', border: '#BFDBFE', color: '#1E40AF', icon: IconRotateCw, animated: true },
  blocked:      { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', icon: IconAlertTriangle, animated: false },
  none:         { bg: 'transparent', border: 'transparent', color: 'transparent', icon: null, animated: false },
}

// =========================================================================
// 组件
// =========================================================================

export const MvpStatusBanner: React.FC = () => {
  const sessionId = useAtomValue(activeAgentSessionIdAtom)
  const stage = useAtomValue(workflowStageAtom)
  const project = useAtomValue(currentProjectAtom)
  const setGlobalError = useSetAtom(globalUserErrorAtom)
  // PR-3 导出状态：exporting 禁用按钮；exportedPath 成功后展示位置；取消静默复位（U10 契约）
  const [exporting, setExporting] = useState(false)
  const [exportedPath, setExportedPath] = useState<string | null>(null)
  // Phase 10 落地旅程（2026-09-16）：升级导出——旧导出包→新代码+旧数据+迁移+报告
  const [upgrading, setUpgrading] = useState(false)
  const [upgradeNote, setUpgradeNote] = useState<string | null>(null)
  const experimentSwitches = useExperimentSwitches()

  const handleUpgradeExport = async () => {
    if (!project || upgrading) return
    setUpgrading(true)
    setUpgradeNote(null)
    try {
      const api = window.electronAPI
      if (!api?.project?.upgradeExport) {
        setGlobalError('当前环境不支持升级导出。')
        return
      }
      const result = await api.project.upgradeExport({
        request_id: crypto.randomUUID(),
        project_id: project.project_id,
      })
      if (!result.ok) {
        setGlobalError(result.error?.user_visible_message || result.error?.message || '升级导出失败，请重试。')
        return
      }
      if (result.data.canceled) return // 取消不是错误，静默复位
      const d = result.data
      const driftCount = d.drift ? d.drift.changed + d.drift.missing + d.drift.extra : 0
      const driftNote = d.drift && !d.drift.clean ? `；旧包有手改痕迹 ${driftCount} 处（不合并，详见报告）` : ''
      setUpgradeNote(
        d.migration === 'failed'
          ? `升级包已生成（${d.target ?? ''}）：迁移未过——旧数据已原样携带并备份，明细见包内 upgrade-report.json${driftNote}`
          : d.migration === 'ran'
            ? `升级完成（${d.target ?? ''}）：${d.summary ?? '迁移已执行'}${driftNote}`
            : `升级包已生成（${d.target ?? ''}）：无需迁移，旧数据原样携带${driftNote}`,
      )
    } catch {
      setGlobalError('升级导出失败，请重试。')
    } finally {
      setUpgrading(false)
    }
  }

  const handleExport = async () => {
    if (!project || exporting) return
    setExporting(true)
    try {
      const api = window.electronAPI
      if (!api?.project?.export) {
        setGlobalError('当前环境不支持导出。')
        return
      }
      const result = await api.project.export({
        request_id: crypto.randomUUID(),
        project_id: project.project_id,
      })
      if (!result.ok) {
        // m-16 同款口径：IPC 层失败走 globalUserError，不静默吞
        setGlobalError(result.error?.user_visible_message || result.error?.message || '导出失败，请重试。')
        return
      }
      if (result.data.canceled) return // 取消导出不是错误，静默复位
      setExportedPath(result.data.destination ?? '')
    } catch {
      setGlobalError('导出失败，请重试。')
    } finally {
      setExporting(false)
    }
  }

  // N-001 修复（2026-08-12）：使用模块级 nullSessionFallback 替代 atomFamily('__unused__')，
  // 保证所有 hooks 在每次渲染中以相同顺序调用，不违反 React Hooks 规则。
  const streamState = useAtomValue(
    sessionId ? agentStreamStateFamily(sessionId) : nullSessionFallback,
  )

  const banner = useMemo<BannerState>(() => {
    if (!sessionId) {
      return { visible: false, variant: 'none', title: '', stage }
    }
    const events = streamState?.events ?? []
    return deriveBannerState(events, stage)
  }, [sessionId, streamState?.events, stage])

  if (!banner.visible) return null

  const style = VARIANT_STYLE[banner.variant]
  const Icon = style.icon

  return (
    <div
      role="status"
      aria-live="polite"
      data-ai-id="mvp-status-banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: 'var(--space-3) var(--space-5)',
        margin: '0 var(--tile-gap)',
        background: style.bg,
        border: `1px solid ${style.border}`,
        borderRadius: 'var(--radius-md)',
        transition: 'all var(--transition-base)',
      }}
    >
      {/* 左侧图标 */}
      {Icon ? (
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: style.color,
            flexShrink: 0,
          }}
        >
          <Icon size={18} />
        </span>
      ) : style.animated ? (
        /* 旋转脉冲指示器（generating/testing/judging/repairing） */
        <span
          style={{
            width: 28,
            height: 28,
            borderRadius: 'var(--radius-sm)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: style.color,
            flexShrink: 0,
            animation: 'spin 1.2s linear infinite',
          }}
        >
          <IconRotateCw size={16} />
        </span>
      ) : null}

      {/* 文案 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            fontWeight: 700,
            color: style.color,
            margin: 0,
            lineHeight: 1.4,
          }}
        >
          {banner.title}
        </p>
        {banner.detail && (
          <p
            style={{
              fontSize: 'var(--font-size-xs)',
              color: style.color,
              opacity: 0.75,
              margin: '2px 0 0',
              lineHeight: 1.4,
            }}
          >
            {banner.detail}
          </p>
        )}
      </div>

      {/* 右侧：导出项目按钮（PR-3，仅成果就绪态显示） */}
      {banner.variant === 'ready' &&
        (exportedPath ? (
          <span
            data-ai-id="export-project-done"
            title={exportedPath}
            style={{
              fontSize: 'var(--font-size-xs)',
              color: style.color,
              opacity: 0.85,
              flexShrink: 0,
              maxWidth: 320,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            已导出到 {exportedPath}（线上状态未知）
          </span>
        ) : (
          <button
            type="button"
            data-ai-id="export-project-btn"
            onClick={handleExport}
            disabled={!project || exporting}
            style={{
              flexShrink: 0,
              padding: '4px 12px',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 600,
              color: style.color,
              background: '#fff',
              border: `1px solid ${style.border}`,
              borderRadius: 'var(--radius-md)',
              cursor: exporting || !project ? 'not-allowed' : 'pointer',
              opacity: !project || exporting ? 0.6 : 1,
            }}
          >
            {exporting ? '导出中…' : '导出项目'}
          </button>
        ))}

      {/* Phase 10 落地旅程：升级导出（导出后出现——旧导出包→新版本，数据先备份再迁移） */}
      {(banner.variant === 'ready') && exportedPath && (
        <button
          type="button"
          data-ai-id="upgrade-export-btn"
          onClick={handleUpgradeExport}
          disabled={!project || upgrading}
          title="选择旧的导出包目录，生成升级版：新代码+你的旧数据（先备份）+自动迁移+升级报告"
          style={{
            flexShrink: 0,
            padding: '4px 12px',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            color: style.color,
            background: '#fff',
            border: `1px solid ${style.border}`,
            borderRadius: 'var(--radius-md)',
            cursor: upgrading || !project ? 'not-allowed' : 'pointer',
            opacity: !project || upgrading ? 0.6 : 1,
          }}
        >
          {upgrading ? '升级中…' : '升级导出'}
        </button>
      )}
      {upgradeNote && (
        <span
          data-ai-id="upgrade-export-note"
          title={upgradeNote}
          style={{
            fontSize: 'var(--font-size-xs)',
            color: style.color,
            opacity: 0.85,
            flexShrink: 1,
            maxWidth: 420,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {upgradeNote}
        </span>
      )}

      {/* 右侧 loading dots（generating 等动画状态） */}
      {style.animated && (
        <span style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: 5,
                height: 5,
                borderRadius: '50%',
                background: style.color,
                animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </span>
      )}
    </div>
  )
}

export default MvpStatusBanner

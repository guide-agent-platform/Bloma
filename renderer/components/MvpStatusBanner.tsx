/**
 * MvpStatusBanner — MVP 状态横幅
 *
 * Sprint 2 B 交付物
 *
 * 消费 A 侧通过 setupGlobalAgentListeners 推送的 AgentEvent：
 *   - mvp_ready       → MVP 生成成功，显示预览入口
 *   - judge_result    → 裁判判定结果（通过/建议/退回）
 *   - repairing       → 自动修复中
 *
 * 数据来源：agentStreamStateFamily(sessionId).events 中的最近事件
 *   + agent-atoms 已有的 workflowStageAtom
 *
 * 集成方式：
 *   在 WorkspaceShell 中 Header 下方挂载 <MvpStatusBanner />。
 */

import React, { useMemo } from 'react'
import { atom, useAtomValue } from 'jotai'
import type { AgentEvent, WorkflowStage } from '../../shared/types'
import type { AgentStreamState } from '../agent-atoms'
import {
  activeAgentSessionIdAtom,
  agentStreamStateFamily,
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
  variant: 'generating' | 'ready' | 'testing' | 'judging' | 'judge_pass' | 'judge_suggest' | 'judge_return' | 'repairing' | 'blocked' | 'none'
  title: string
  detail?: string
  stage: WorkflowStage
}

function deriveBannerState(
  events: AgentEvent[],
  stage: WorkflowStage,
): BannerState {
  // 从事件流中提取最近的关键事件
  const latestByType = new Map<string, AgentEvent>()
  for (const e of events) {
    if (['mvp_ready', 'judge_result', 'repairing', 'stage_changed'].includes(e.type)) {
      latestByType.set(e.type, e)
    }
  }

  const mvpReady = latestByType.get('mvp_ready')
  const judgeResult = latestByType.get('judge_result')
  const repairing = latestByType.get('repairing')

  // 正在修复中
  if (
    repairing &&
    latestByType.get('mvp_ready') &&
    new Date(repairing.created_at).getTime() >
      new Date(latestByType.get('mvp_ready')!.created_at).getTime()
  ) {
    return {
      visible: true,
      variant: 'repairing',
      title: '正在尝试自动修复',
      detail: (repairing.payload.user_visible_summary as string) || '运行时检测到错误，正在自动修复…',
      stage,
    }
  }

  // 裁判结果
  if (judgeResult && mvpReady) {
    const verdict = judgeResult.payload.verdict as string | undefined
    const summary = judgeResult.payload.user_visible_summary as string | undefined

    if (verdict === 'return') {
      return {
        visible: true,
        variant: 'judge_return',
        title: '功能还需要完善',
        detail: summary || '裁判审查发现功能未达到要求，需要修改',
        stage,
      }
    }

    if (verdict === 'suggest') {
      return {
        visible: true,
        variant: 'judge_suggest',
        title: '基本可用，建议优化',
        detail: summary || '裁判建议改进部分功能',
        stage,
      }
    }

    // verdict === 'pass'
    return {
      visible: true,
      variant: 'judge_pass',
      title: '功能验收通过',
      detail: summary || 'MVP 已生成并通过检查',
      stage,
    }
  }

  // MVP 已就绪
  if (mvpReady) {
    return {
      visible: true,
      variant: 'ready',
      title: 'MVP 已生成，可以预览',
      detail: (mvpReady.payload.summary as string) || '完整功能已生成，右侧预览区可查看效果',
      stage,
    }
  }

  // 基于阶段的 fallback
  switch (stage) {
    case 'generating_mvp':
      return { visible: true, variant: 'generating', title: STAGE_LABEL_MAP[stage], detail: '正在生成完整项目，请稍候…', stage }
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
  judge_pass:   { bg: '#ECFDF5', border: '#A7F3D0', color: '#065F46', icon: IconCheck, animated: false },
  judge_suggest:{ bg: '#FFFBEB', border: '#FDE68A', color: '#92400E', icon: IconAlertTriangle, animated: false },
  judge_return: { bg: '#FEF2F2', border: '#FECACA', color: '#991B1B', icon: IconX, animated: false },
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

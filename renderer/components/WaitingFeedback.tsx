import React from 'react'

export type WaitLevel = 'normal' | 'long' | 'timeout'

export interface WaitingFeedbackProps {
  elapsedSeconds: number
  actionLabel: string
  onContinueWaiting?: () => void
  /** 查看进度（原“查看已有部分”）：进度数据由父级从事件流/权威阶段归约，此回调只负责展开/收起 */
  onViewProgress?: () => void
  /** 父级是否已展开进度卡（决定按钮文案：查看进度 / 收起进度） */
  viewingProgress?: boolean
  /** 提出新想法：等待中超时才出现；父级负责收起进度卡并聚焦输入框（R-WAIT-04） */
  onSuggestIdea?: () => void
}

/**
 * 等待反馈卡片
 *
 * 三级递进（interaction-spec §6）：
 * - ≤10 秒：显示当前在做什么（R-WAIT-01）
 * - >10 秒：加入安全感说明，并提供"查看进度"（R-WAIT-02）
 * - >120 秒：提供"继续等待 / 查看进度 / 提出新想法"（R-WAIT-03，等待不阻塞继续输入）
 */
export const WaitingFeedback: React.FC<WaitingFeedbackProps> = ({
  elapsedSeconds,
  actionLabel,
  onContinueWaiting,
  onViewProgress,
  viewingProgress = false,
  onSuggestIdea,
}) => {
  const level: WaitLevel = elapsedSeconds > 120 ? 'timeout' : elapsedSeconds > 10 ? 'long' : 'normal'

  const messages: Record<WaitLevel, { title: string; safety?: string }> = {
    normal: { title: `我正在帮你${actionLabel}。` },
    long: { title: `我正在帮你${actionLabel}。`, safety: '可以查看最近进展，也可以继续补充想法。' },
    timeout: { title: `等待时间较长，可以查看最近进展。`, safety: '你随时可以看看当前进行到哪一步。' },
  }

  const { title, safety } = messages[level]

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
        padding: 'var(--space-4)',
        background: 'var(--white)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-md)',
        maxWidth: 420,
        boxShadow: 'var(--shadow-sm)',
        animation: 'tile-enter 0.3s ease both',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <span
          style={{
            width: 20,
            height: 20,
            border: '2px solid var(--color-border)',
            borderTopColor: 'var(--color-quick)',
            borderRadius: '50%',
            display: 'inline-block',
            animation: 'spin 0.8s linear infinite',
            flexShrink: 0,
          }}
        />
        <div>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text)', fontWeight: 500 }}>{title}</p>
          {safety && (
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>{safety}</p>
          )}
        </div>
      </div>

      {(level === 'timeout' || level === 'long') && (onContinueWaiting || onViewProgress || onSuggestIdea) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', paddingLeft: 32 }}>
          {level === 'timeout' && onContinueWaiting && (
            <button
              onClick={onContinueWaiting}
              style={{
                height: 34,
                padding: '0 var(--space-4)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--white)',
                background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
                borderRadius: 'var(--radius-full)',
                boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
                cursor: 'pointer',
              }}
            >
              继续等待
            </button>
          )}
          {onViewProgress && (
            <button
              onClick={onViewProgress}
              style={{
                height: 34,
                padding: '0 var(--space-4)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--color-text)',
                background: 'var(--glass-bg-soft)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
              }}
            >
              {viewingProgress ? '收起进度' : '查看进度'}
            </button>
          )}
          {level === 'timeout' && onSuggestIdea && (
            <button
              onClick={onSuggestIdea}
              style={{
                height: 34,
                padding: '0 var(--space-4)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                color: 'var(--color-text)',
                background: 'var(--glass-bg-soft)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-full)',
                cursor: 'pointer',
              }}
            >
              提出新想法
            </button>
          )}
        </div>
      )}
    </div>
  )
}

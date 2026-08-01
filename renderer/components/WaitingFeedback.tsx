import React from 'react'

export type WaitLevel = 'normal' | 'long' | 'timeout'

export interface WaitingFeedbackProps {
  elapsedSeconds: number
  actionLabel: string
  onContinueWaiting?: () => void
  onViewPartial?: () => void
}

/**
 * 等待反馈卡片
 *
 * 三级递进（interaction-spec §6）：
<<<<<<< HEAD
 * - ≤10 秒：显示当前在做什么（R-WAIT-01）
 * - >10 秒：加入安全感说明（R-WAIT-02）
 * - >120 秒：提供"继续等待"或"查看已有部分"选项（R-WAIT-03）
=======
 * - >5 秒：显示当前在做什么并加入安全感说明
 * - >120 秒：提供"继续等待"或"查看已有部分"选项
 *
 * 注：前 5 秒由 ChatPanel 控制不渲染本组件，避免一进入等待就立刻提示。
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84
 */
export const WaitingFeedback: React.FC<WaitingFeedbackProps> = ({
  elapsedSeconds,
  actionLabel,
  onContinueWaiting,
  onViewPartial,
}) => {
<<<<<<< HEAD
  const level: WaitLevel = elapsedSeconds > 120 ? 'timeout' : elapsedSeconds > 10 ? 'long' : 'normal'
=======
  const level: WaitLevel = elapsedSeconds >= 120 ? 'timeout' : elapsedSeconds >= 5 ? 'long' : 'normal'
>>>>>>> 5a004360480c0c81d2999731a003e93e53bcaa84

  const messages: Record<WaitLevel, { title: string; safety?: string }> = {
    normal: { title: `我正在帮你${actionLabel}。` },
    long: { title: `我正在帮你${actionLabel}。`, safety: '这个过程只发生在安全环境里，不会影响你的电脑文件。' },
    timeout: { title: `这次花的时间比预期更长，我还在处理中。`, safety: '你可以先看看已经生成的部分。' },
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

      {level === 'timeout' && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', paddingLeft: 32 }}>
          {onContinueWaiting && (
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
          {onViewPartial && (
            <button
              onClick={onViewPartial}
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
              看看已有的
            </button>
          )}
        </div>
      )}
    </div>
  )
}

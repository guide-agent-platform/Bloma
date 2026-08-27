import React from 'react'
import { Zap, Gem, ArrowRight } from './icons'

export interface ModeCardProps {
  /** 模式标识 */
  mode: 'quick' | 'longterm'
  /** 卡片标题 */
  title: string
  /** 一句话说明 */
  description: string
  /** 辅助提示（卡片底部 helper 文案） */
  helperText?: string
  /** 角标（如「新手推荐」，纯样式，提升首屏默认认知） */
  badge?: string
  /** 选中回调 */
  onSelect: (mode: 'quick' | 'longterm') => void
  /** 禁用（防止双击重复创建） */
  disabled?: boolean
}

const MODE_LABELS: Record<'quick' | 'longterm', string> = {
  quick: '快速尝鲜',
  longterm: '精细打磨',
}

export const ModeCard: React.FC<ModeCardProps> = ({
  mode,
  title,
  description,
  helperText,
  badge,
  onSelect,
  disabled = false,
}) => {
  const isQuick = mode === 'quick'
  const [hovered, setHovered] = React.useState(false)

  const heroBg = isQuick
    ? 'linear-gradient(135deg, var(--violet-600), var(--violet-400))'
    : 'linear-gradient(135deg, var(--cyan-600), var(--cyan-400))'
  const ctaBg = isQuick
    ? 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'
    : 'linear-gradient(135deg, var(--color-longterm), var(--color-longterm-bright))'
  const ctaShadow = isQuick
    ? '0 6px 16px -4px rgba(124,58,237,0.45)'
    : '0 6px 16px -4px rgba(8,145,178,0.45)'

  return (
    <button
      className="mode-tile tile"
      data-ai-id={isQuick ? 'mode-card-quick' : 'mode-card-longterm'}
      disabled={disabled}
      onClick={() => onSelect(mode)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        textAlign: 'left',
        width: '100%',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transform: hovered ? 'translateY(-4px) scale(1.015)' : 'none',
        boxShadow: hovered ? 'var(--shadow-lg)' : 'var(--shadow-glass)',
        transition: 'transform var(--transition-base), box-shadow var(--transition-base)',
        animation: 'tile-enter 0.55s ease both',
        animationDelay: isQuick ? '0.15s' : '0.25s',
      }}
    >
      {/* 磁贴顶部渐变区 */}
      <div
        style={{
          position: 'relative',
          height: 120,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          padding: 'var(--space-4) var(--space-5)',
          overflow: 'hidden',
          background: heroBg,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: '5px var(--space-3)',
            fontSize: 'var(--font-size-xs)',
            fontWeight: 600,
            borderRadius: 'var(--radius-full)',
            background: 'rgb(255 255 255 / 0.25)',
            color: 'var(--white)',
            backdropFilter: 'blur(6px)',
          }}
        >
          {isQuick ? <Zap size={14} /> : <Gem size={14} />}
          {MODE_LABELS[mode]}
        </span>
        {/* QW#4（ux-r2 I3）：新手推荐角标（纯样式，默认认知引导） */}
        {badge && (
          <span
            data-ai-id={isQuick ? 'mode-card-quick-badge' : undefined}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: '3px var(--space-2)',
              fontSize: 'var(--font-size-xs)',
              fontWeight: 700,
              borderRadius: 'var(--radius-full)',
              background: 'rgb(255 255 255 / 0.95)',
              color: 'var(--violet-700)',
              boxShadow: '0 2px 8px rgb(0 0 0 / 0.18)',
            }}
          >
            {badge}
          </span>
        )}
        {/* 水印大图标 */}
        <span
          aria-hidden
          style={{
            position: 'absolute',
            right: -10,
            bottom: -18,
            color: 'rgb(255 255 255 / 0.28)',
          }}
        >
          {isQuick ? <Zap size={120} /> : <Gem size={120} />}
        </span>
      </div>

      {/* 磁贴内容 */}
      <div style={{ padding: 'var(--space-5)', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <h2
          style={{
            fontSize: 'var(--font-size-xl)',
            fontWeight: 700,
            marginBottom: 'var(--space-2)',
            lineHeight: 'var(--line-height-heading)',
            color: 'var(--color-text)',
          }}
        >
          {title}
        </h2>
        <p
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text-muted)',
            lineHeight: 'var(--line-height-base)',
            marginBottom: 'var(--space-5)',
            flex: 1,
          }}
        >
          {description}
        </p>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            alignSelf: 'flex-start',
            padding: '8px var(--space-4)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 600,
            borderRadius: 'var(--radius-full)',
            color: 'var(--white)',
            background: ctaBg,
            boxShadow: ctaShadow,
          }}
        >
          开始
          <ArrowRight size={16} />
        </span>
        {helperText && (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-3)' }}>
            {helperText}
          </span>
        )}
      </div>
    </button>
  )
}

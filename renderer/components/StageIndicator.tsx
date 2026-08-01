import React from 'react'

export interface StageIndicatorProps {
  label: string
  /** 是否为活动阶段（活动=琥珀色胶囊，空闲=灰色胶囊） */
  active?: boolean
}

export const StageIndicator: React.FC<StageIndicatorProps> = ({ label, active = false }) => {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        padding: '3px var(--space-3)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 500,
        borderRadius: 'var(--radius-full)',
        background: active ? 'var(--color-warning)' : 'var(--gray-200)',
        color: active ? 'var(--white)' : 'var(--gray-600)',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--white)',
          display: 'inline-block',
          animation: active ? 'pulse-stage 1.6s ease-in-out infinite' : 'none',
        }}
      />
      {label}
    </span>
  )
}

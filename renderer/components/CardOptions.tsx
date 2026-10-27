import React from 'react'

export interface CardOption {
  id: string
  label: string
  description?: string
  selectedSuggestionIds?: string[]
}

export interface CardOptionsProps {
  options: CardOption[]
  onSelect: (option: CardOption) => void
  disabled?: boolean
}

/**
 * 卡片选项组件
 *
 * 用于向导 Agent 发出可点击的选项卡片替代用户打字。
 * 单轮最多 4 个选项（含"你帮我决定"）。
 */
export const CardOptions: React.FC<CardOptionsProps> = ({ options, onSelect, disabled = false }) => {
  if (options.length === 0) return null

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', padding: 'var(--space-1) 0' }}>
      {options.map((opt) => (
        <button
          key={opt.id}
          data-ai-id={`card-option-${opt.id}`}
          disabled={disabled}
          onClick={() => onSelect(opt)}
          style={{
            display: 'inline-flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            padding: '9px 12px',
            background: 'var(--white)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            textAlign: 'left',
            maxWidth: '100%',
            transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!disabled) {
              e.currentTarget.style.borderColor = 'var(--color-quick)'
              e.currentTarget.style.boxShadow = 'var(--shadow-md)'
              e.currentTarget.style.transform = 'none'
            }
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = 'var(--color-border)'
            e.currentTarget.style.boxShadow = 'none'
            e.currentTarget.style.transform = 'none'
          }}
        >
          <span style={{ fontWeight: 500 }}>{opt.label}</span>
          {opt.description && (
            <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>
              {opt.description}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}

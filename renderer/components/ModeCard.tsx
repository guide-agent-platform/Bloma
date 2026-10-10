import React from 'react'
import { Zap, Gem, ArrowRight } from './icons'

export interface ModeCardProps {
  mode: 'quick' | 'longterm'
  title: string
  description: string
  helperText?: string
  badge?: string
  onSelect: (mode: 'quick' | 'longterm') => void
  disabled?: boolean
}

export const ModeCard: React.FC<ModeCardProps> = ({ mode, title, description, helperText, badge, onSelect, disabled = false }) => {
  const quick = mode === 'quick'
  return <div role="group" aria-label={`${title}（${quick ? '快速尝鲜' : '精细打磨'}）`} aria-disabled={disabled || undefined} className="idea-mode-card" data-mode={mode} data-ai-id={`mode-card-${mode}`} onClick={() => { if (!disabled) onSelect(mode) }}>
    <span style={{ color:quick ? 'var(--color-quick)' : 'var(--color-longterm)', display:'flex', gap:8, alignItems:'center', fontSize:12 }}>{quick ? <Zap size={17} /> : <Gem size={17} />}{quick ? '快速型' : '长期型'}{badge && <span data-ai-id={quick ? 'mode-card-quick-badge' : undefined}>{badge}</span>}</span>
    <h2>{title}</h2><p>{description}</p>
    <button type="button" aria-label={`开始：${title}`} disabled={disabled} onClick={event => { event.stopPropagation(); if (!disabled) onSelect(mode) }}>开始 <ArrowRight size={14} /></button>
    {helperText && <p>{helperText}</p>}
  </div>
}

import React from 'react'

/**
 * ThinkingIndicator — 窄栏思考呈现（2026-10-04）
 *
 * 设计约束：Bloma 对话区窄，思考呈现**默认永远只占一行**——不照抄 Proma 的
 * 「思考块卡片+摘要行」形式（卡片套卡片在窄栏里厚重）。
 * - waiting：发消息后首个事件到达前的占位（批 A：消掉沉默期无反馈）
 * - live：思考增量到达中，实时走字「◌ 思考中 · Xs」
 * - done：正文/工具开始后冻结为「思考 Xs ▸」，点击展开原文（限高 160 滚动、
 *   小号淡色、无卡片边框——与 NarrationRow 同族）
 * 思考原文只存在于本组件的展开态，不进正文气泡、不进协议历史（JSONL 零落盘）。
 */

export type ThinkingPhase = 'waiting' | 'live' | 'done'

export interface ThinkingIndicatorProps {
  phase: ThinkingPhase
  /** 思考开始时刻（首个 thinking_delta 的 created_at；waiting 时缺省） */
  startedAt?: number
  /** 思考结束时刻（首个正文/工具事件时间；live 时缺省） */
  endedAt?: number
  /** 思考增量全文（展开态展示） */
  text?: string
}

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`
}

export const ThinkingIndicator: React.FC<ThinkingIndicatorProps> = ({ phase, startedAt, endedAt, text }) => {
  const [expanded, setExpanded] = React.useState(false)
  const [now, setNow] = React.useState(() => Date.now())

  React.useEffect(() => {
    if (phase !== 'live') return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phase])

  if (phase === 'waiting') {
    return (
      <div
        data-ai-id="thinking-indicator"
        style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', padding: '2px 0', animation: 'thinking-pulse 1.6s ease-in-out infinite' }}
      >
        ◌ 正在思考…
      </div>
    )
  }

  const durationMs =
    startedAt !== undefined ? (endedAt !== undefined ? endedAt - startedAt : now - startedAt) : 0
  const label = phase === 'live' ? `◌ 思考中 · ${formatSeconds(durationMs)}` : `思考 ${formatSeconds(durationMs)} ${expanded ? '▾' : '▸'}`
  const expandable = phase === 'done' && typeof text === 'string' && text.trim().length > 0

  return (
    <div data-ai-id="thinking-indicator" style={{ padding: '2px 0' }}>
      <div
        data-ai-id="thinking-duration"
        onClick={expandable ? () => setExpanded((previous) => !previous) : undefined}
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          cursor: expandable ? 'pointer' : 'default',
          userSelect: 'none',
          ...(phase === 'live' ? { animation: 'thinking-pulse 1.6s ease-in-out infinite' } : {}),
        }}
      >
        {label}
      </div>
      {expanded && expandable && (
        <div
          data-ai-id="thinking-body"
          style={{
            marginTop: 4,
            maxHeight: 160,
            overflowY: 'auto',
            fontSize: 'var(--font-size-xs)',
            lineHeight: 1.6,
            color: 'var(--color-text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            background: 'var(--color-bg-subtle, rgba(0,0,0,0.03))',
            borderRadius: 'var(--radius-sm, 6px)',
            padding: '6px 8px',
          }}
        >
          {text}
        </div>
      )}
    </div>
  )
}

import React from 'react'
import { useAtomValue } from 'jotai'
import { delegationsFamily, type DelegationView } from '../agent-atoms'
import { DELEGATION_ROLE_LABELS, DELEGATION_STATUS_COLORS, DELEGATION_STATUS_LABELS } from './delegation-labels'

/**
 * DelegationFeed — 委派协作视图（M4-C，方案 §4 组合 B）。
 *
 * ChatPanel 内联委派行胶囊（ToolCallFeed 之后）：父 agent delegate_agent 委派的子会话
 * 以 id/role/status 实时可见（仿 ToolCallBlock 折叠行），子 agent 挂起提问时显示
 * 「待回答」警示。数据源为 delegationsFamily（生命周期事件 + delegate 工具 detail 归约）。
 */

function shortId(id: string): string {
  if (!id) return '—'
  return id.length > 10 ? `…${id.slice(-10)}` : id
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

export const DelegationFeed: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const delegations = useAtomValue(delegationsFamily(sessionId))
  if (delegations.length === 0) return null
  return (
    <div
      data-ai-id="delegation-feed"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', maxWidth: '84%' }}
    >
      {delegations.map((item) => (
        <DelegationRow key={item.delegation_id} item={item} />
      ))}
    </div>
  )
}

export const DelegationRow: React.FC<{ item: DelegationView }> = ({ item }) => {
  const [expanded, setExpanded] = React.useState(false)
  const hasPending = Boolean(item.pending_question)
  const formatActivity = (activityMs: number): string => {
    const seconds = Math.max(0, Math.round((Date.now() - activityMs) / 1000))
    if (seconds < 60) return `${seconds} 秒`
    return `${Math.round(seconds / 60)} 分钟`
  }
  return (
    <div
      data-ai-id="delegation-row"
      role={expanded ? undefined : 'button'}
      onClick={() => setExpanded((previous) => !previous)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: expanded ? 'var(--space-2)' : 0,
        padding: 'var(--space-2) var(--space-3)',
        background: 'var(--glass-bg-soft)',
        border: `1px solid ${hasPending ? 'var(--color-warning)' : 'var(--color-border)'}`,
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-muted)',
        cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            flexShrink: 0,
            background: DELEGATION_STATUS_COLORS[item.status],
            display: 'inline-block',
            animation: item.status === 'running' ? 'pulse-stage 1.6s ease-in-out infinite' : 'none',
          }}
        />
        <span style={{ flexShrink: 0, fontWeight: 600, color: 'var(--color-text)' }}>
          子会话 · {DELEGATION_ROLE_LABELS[item.role] ?? item.role}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
          {truncateText(item.goal, 40)}
        </span>
        {item.status === 'running' && item.heartbeat && (
          <span
            data-ai-id="delegation-heartbeat"
            style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 'var(--space-2)', color: 'var(--color-text-muted)' }}
          >
            <span style={{ color: 'var(--color-quick)' }}>●</span>
            {item.heartbeat.last_tool ? `最近 ${item.heartbeat.last_tool}` : '进行中'}
            {typeof item.heartbeat.last_activity_ms === 'number' && ` · ${formatActivity(item.heartbeat.last_activity_ms)}前活跃`}
          </span>
        )}
        {hasPending && (
          <span style={{ flexShrink: 0, color: 'var(--color-warning)', fontWeight: 600 }}>待回答</span>
        )}
        <span style={{ marginLeft: 'auto', flexShrink: 0 }}>
          {DELEGATION_STATUS_LABELS[item.status]}
        </span>
      </div>
      {expanded && (
        <div data-ai-id="delegation-row-detail" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span>委派 id：{shortId(item.delegation_id)}</span>
          <span>子会话 id：{shortId(item.child_session_id)}</span>
          {item.pending_question && (
            <span style={{ color: 'var(--color-warning)' }}>等待回答：{truncateText(item.pending_question, 80)}</span>
          )}
        </div>
      )}
    </div>
  )
}

export default DelegationFeed

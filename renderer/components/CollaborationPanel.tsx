import React from 'react'
import { X } from './icons'
import { useAtom, useAtomValue } from 'jotai'
import {
  activeAgentSessionIdAtom,
  collaborationPanelExpandedAtom,
  currentProjectAtom,
  delegationsFamily,
  emptyDelegationsFallback,
  type DelegationView,
} from './atoms'
import { DELEGATION_ROLE_LABELS, DELEGATION_STATUS_COLORS, DELEGATION_STATUS_LABELS } from './delegation-labels'

/**
 * CollaborationPanel — 委派协作抽屉（M4-C，方案 §4 组合 A，仿 DocumentPanel）。
 *
 * 顶栏「协作」按钮展开的右抽屉：列出父 loop 委派的子会话（id/role/status 实时 +
 * pending_question 提示 + 可展开历史）。展开态由 `collaborationPanelExpandedAtom` 控制
 * （WorkspaceHeader 切换），未展开时渲染 null，可直接挂在 WorkspaceShell 中自门控。
 */

function shortId(id: string): string {
  if (!id) return '—'
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
}

export const CollaborationPanel: React.FC<{ embedded?: boolean }> = ({ embedded = false }) => {
  const [expanded, setExpanded] = useAtom(collaborationPanelExpandedAtom)
  const project = useAtomValue(currentProjectAtom)
  const activeSessionId = useAtomValue(activeAgentSessionIdAtom)
  const delegations = useAtomValue(
    activeSessionId ? delegationsFamily(activeSessionId) : emptyDelegationsFallback,
  )

  if (!expanded) return null

  return (
    <div
      data-ai-id="collaboration-panel"
      role="complementary"
      aria-label="委派协作"
      style={{
        position: embedded ? 'relative' : 'fixed', top: 0, right: 0, bottom: 0, zIndex: embedded ? undefined : 900,
        width: embedded ? '100%' : 'min(420px, 92vw)', minHeight: 0, height: embedded ? '100%' : undefined,
        display: 'flex', flexDirection: 'column',
        background: 'var(--color-surface)',
        borderLeft: '1px solid var(--color-border)',
        boxShadow: embedded ? 'none' : 'var(--shadow-lg)',
        animation: 'tile-enter 0.2s ease both',
      }}
    >
      {/* 头部 */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--color-border)',
          flexShrink: 0,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <h2 style={{ fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--color-text)', margin: 0 }}>
            委派协作
          </h2>
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', margin: '2px 0 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {project?.name ?? '未命名项目'}
          </p>
        </div>
        <button
          onClick={() => setExpanded(false)}
          aria-label="关闭协作面板"
          data-ai-id="collaboration-panel-close"
          style={{
            fontSize: 'var(--font-size-lg)', lineHeight: 1, color: 'var(--color-text-muted)',
            padding: 'var(--space-2)', cursor: 'pointer', background: 'transparent',
            border: 'none', fontFamily: 'inherit',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* 子会话列表 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-3)' }}>
        {delegations.length === 0 ? (
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', padding: 'var(--space-4) var(--space-2)', lineHeight: 1.6 }}>
            还没有委派子会话。编程主 agent 调用 delegate_agent 并行协作时，这里会实时显示子会话状态。
          </p>
        ) : (
          delegations.map((item) => <DelegationCard key={item.delegation_id} item={item} />)
        )}
      </div>
    </div>
  )
}

const DelegationCard: React.FC<{ item: DelegationView }> = ({ item }) => {
  const [expanded, setExpanded] = React.useState(false)
  const hasPending = Boolean(item.pending_question)
  return (
    <div
      data-ai-id="collaboration-card"
      style={{
        display: 'flex', flexDirection: 'column', gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--glass-bg-soft)',
        border: `1px solid ${hasPending ? 'var(--color-warning)' : 'var(--color-border)'}`,
        marginBottom: 'var(--space-2)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
        <span
          style={{
            flexShrink: 0, fontSize: 10, fontWeight: 600, color: 'var(--color-quick)',
            padding: '2px var(--space-2)', borderRadius: 'var(--radius-full)',
            background: 'var(--color-quick-soft)', whiteSpace: 'nowrap',
          }}
        >
          {DELEGATION_ROLE_LABELS[item.role] ?? item.role}
        </span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text)', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.goal || '（未命名任务）'}
        </span>
        <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 'var(--font-size-xs)', color: DELEGATION_STATUS_COLORS[item.status] ?? 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>
          {DELEGATION_STATUS_LABELS[item.status] ?? item.status}
        </span>
      </div>

      {hasPending && (
        <div data-ai-id="collaboration-pending-question" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-warning)', lineHeight: 1.5 }}>
          待回答：{item.pending_question}
        </div>
      )}

      <button
        data-ai-id="collaboration-card-expand"
        onClick={() => setExpanded((previous) => !previous)}
        style={{
          alignSelf: 'flex-start', fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)',
          background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
        }}
      >
        {expanded ? '收起详情' : '查看详情'}
      </button>

      {expanded && (
        <div data-ai-id="collaboration-card-detail" style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
          <span>委派 id：{item.delegation_id}</span>
          <span>子会话 id：{item.child_session_id}</span>
          <span>目标：{item.goal || '—'}</span>
          {item.pending_question && <span style={{ color: 'var(--color-warning)' }}>待回答问题：{item.pending_question}</span>}
          <span style={{ color: 'var(--color-text-muted)' }}>会话 id（短）：{shortId(item.child_session_id)}</span>
        </div>
      )}
    </div>
  )
}

export default CollaborationPanel

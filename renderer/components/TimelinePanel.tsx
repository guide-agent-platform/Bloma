import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ChevronUp } from './icons'
import { timelineExpandedAtom, snapshotsListAtom, selectedSnapshotAtom } from './atoms'
import type { Snapshot } from './atoms'

export interface TimelinePanelProps {
  /** 回滚确认回调 */
  onRollback?: (snapshot: Snapshot) => void
}

/**
 * 时间轴 — 顶部胶片条（Bento 架构）
 *
 * 由原底部窄条迁移到顶部，改为水平胶片：
 * - 标签 + 版本计数
 * - 水平滚动的快照磁贴（snap-chip）
 * - 展开切换
 * 非当前快照点击 → onRollback。
 */
export const TimelinePanel: React.FC<TimelinePanelProps> = ({ onRollback }) => {
  const [expanded, setExpanded] = useAtom(timelineExpandedAtom)
  const snapshots = useAtomValue(snapshotsListAtom)
  const selectedSnapshot = useAtomValue(selectedSnapshotAtom)

  return (
    <div
      data-ai-id="timeline-expanded-panel"
      className="tile"
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-3)',
        padding: '0 var(--space-4)',
        overflow: 'hidden',
        height: expanded ? 'var(--timeline-height)' : 52,
        transition: 'height var(--transition-slow)',
      }}
    >
      {/* 标签 + 计数 */}
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          color: 'var(--color-text-muted)',
          whiteSpace: 'nowrap',
          flexShrink: 0,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
        }}
      >
        时间轴
        <span
          style={{
            padding: '1px 7px',
            borderRadius: 'var(--radius-full)',
            background: 'var(--color-surface-muted)',
            color: 'var(--color-text)',
            fontWeight: 700,
          }}
        >
          {snapshots.length}
        </span>
      </span>

      {/* 轨道 */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          overflowX: 'auto',
          minWidth: 0,
        }}
      >
        {snapshots.length === 0 ? (
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>
            还没有版本记录。生成草图后，时间轴会自动记录每一个重要版本。
          </span>
        ) : (
          snapshots.map((snap) => {
            const isCurrent = snap.snapshot_id === selectedSnapshot?.snapshot_id
            return (
              <SnapChip
                key={snap.snapshot_id}
                snapshot={snap}
                isCurrent={isCurrent}
                onClick={() => !isCurrent && onRollback?.(snap)}
              />
            )
          })
        )}
      </div>

      {/* 展开/收起 */}
      <button
        onClick={() => setExpanded(!expanded)}
        aria-label={expanded ? '收起时间轴' : '展开时间轴'}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 28,
          height: 28,
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-text-muted)',
          transition: 'all var(--transition-fast)',
          flexShrink: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'var(--color-surface-muted)'
          e.currentTarget.style.color = 'var(--color-text)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--color-text-muted)'
        }}
      >
        <span style={{ display: 'inline-flex', transform: expanded ? 'rotate(180deg)' : 'none', transition: 'transform var(--transition-base)' }}>
          <ChevronUp size={16} />
        </span>
      </button>
    </div>
  )
}

/* =========================================================================
   SnapChip — 快照磁贴
   ========================================================================= */

const SnapChip: React.FC<{
  snapshot: Snapshot
  isCurrent: boolean
  onClick: () => void
}> = ({ snapshot, isCurrent, onClick }) => {
  return (
    <button
      title={isCurrent ? '当前版本' : `回到「${snapshot.name}」`}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        gap: 2,
        padding: '6px var(--space-3)',
        borderRadius: 'var(--radius-md)',
        background: isCurrent
          ? 'linear-gradient(135deg, var(--violet-600), var(--violet-500))'
          : 'var(--glass-bg-soft)',
        border: `1px solid ${isCurrent ? 'transparent' : 'var(--glass-border-subtle)'}`,
        color: isCurrent ? 'var(--white)' : 'var(--color-text)',
        minWidth: 96,
        flexShrink: 0,
        transition: 'all var(--transition-fast)',
        cursor: isCurrent ? 'default' : 'pointer',
        textAlign: 'left',
      }}
      onMouseEnter={(e) => {
        if (!isCurrent) {
          e.currentTarget.style.background = 'var(--glass-bg-strong)'
          e.currentTarget.style.transform = 'translateY(-1px)'
        }
      }}
      onMouseLeave={(e) => {
        if (!isCurrent) {
          e.currentTarget.style.background = 'var(--glass-bg-soft)'
          e.currentTarget.style.transform = 'none'
        }
      }}
    >
      <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
        {snapshot.name}
      </span>
      <span style={{ fontSize: 10, opacity: 0.7 }}>
        {new Date(snapshot.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </button>
  )
}

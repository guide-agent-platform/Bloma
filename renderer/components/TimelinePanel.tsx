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

  // 回滚确认弹窗状态
  const [confirmSnapshot, setConfirmSnapshot] = React.useState<Snapshot | null>(null)

  const handleRollbackClick = (snap: Snapshot) => {
    if (!onRollback) return
    setConfirmSnapshot(snap)
  }

  const handleConfirmRollback = () => {
    if (confirmSnapshot && onRollback) {
      onRollback(confirmSnapshot)
    }
    setConfirmSnapshot(null)
  }

  return (
    <>
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
                showThumbnail={expanded}
                onClick={() => !isCurrent && handleRollbackClick(snap)}
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

    {/* 回滚确认弹窗 */}
    {confirmSnapshot && (
      <RollbackConfirmModal
        snapshot={confirmSnapshot}
        onConfirm={handleConfirmRollback}
        onCancel={() => setConfirmSnapshot(null)}
      />
    )}
    </>
  )
}

/* =========================================================================
   RollbackConfirmModal — 回滚确认弹窗（R-ROLL-02）
   ========================================================================= */

const RollbackConfirmModal: React.FC<{
  snapshot: Snapshot
  onConfirm: () => void
  onCancel: () => void
}> = ({ snapshot, onConfirm, onCancel }) => {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="回滚确认"
      data-ai-id="rollback-confirm-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div style={{
        background: 'var(--white)',
        borderRadius: 'var(--radius-md)',
        padding: 'var(--space-6)',
        maxWidth: 400,
        width: '90%',
        boxShadow: 'var(--shadow-lg)',
        animation: 'tile-enter 0.2s ease both',
      }}>
        <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, marginBottom: 'var(--space-2)', color: 'var(--color-text)' }}>
          回到「{snapshot.name}」？
        </p>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-5)', lineHeight: 'var(--line-height-base)' }}>
          回到这个版本之后，{snapshot.name} 之后的版本仍然保留在时间轴上，你可以随时再切换回来。
        </p>
        <div style={{ display: 'flex', gap: 'var(--space-3)', justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={{
            height: 36, padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)', fontWeight: 600,
            color: 'var(--color-text)', background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}>
            取消
          </button>
          <button onClick={onConfirm} style={{
            height: 36, padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--white)',
            background: 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))',
            borderRadius: 'var(--radius-sm)',
            boxShadow: '0 4px 12px -2px rgba(124,58,237,0.4)',
            cursor: 'pointer',
          }}>
            确认回到这里
          </button>
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   SnapChip — 快照磁贴
   ========================================================================= */

const SnapChip: React.FC<{
  snapshot: Snapshot
  isCurrent: boolean
  showThumbnail: boolean
  onClick: () => void
}> = ({ snapshot, isCurrent, showThumbnail, onClick }) => {
  return (
    <button
      title={isCurrent ? '当前版本' : `回到「${snapshot.name}」`}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: showThumbnail ? 'row' : 'column',
        justifyContent: 'center',
        alignItems: showThumbnail ? 'center' : 'stretch',
        gap: showThumbnail ? 'var(--space-2)' : 2,
        padding: showThumbnail ? '4px var(--space-3)' : '6px var(--space-3)',
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
      {showThumbnail && <SnapshotThumb snapshot={snapshot} />}
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600 }}>
          {snapshot.name}
        </span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>
          {new Date(snapshot.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
    </button>
  )
}

/* =========================================================================
   SnapshotThumb — 快照真实截图缩略图（U9）
   渲染进程受 CSP `img-src 'self' data: blob:` 约束，无法直接加载磁盘 file:// 截图；
   由主进程读文件转 base64 data URL 回传，这里懒加载并按需展示。
   ========================================================================= */

const SnapshotThumb: React.FC<{ snapshot: Snapshot }> = ({ snapshot }) => {
  const [dataUrl, setDataUrl] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    const api = window.electronAPI
    if (!api?.snapshots?.screenshot) return
    void api.snapshots
      .screenshot({
        request_id: crypto.randomUUID(),
        project_id: snapshot.project_id,
        snapshot_id: snapshot.snapshot_id,
      })
      .then((result) => {
        if (!cancelled && result?.ok && result.data?.data_url) setDataUrl(result.data.data_url)
      })
      .catch(() => {
        // 读图失败：保持占位色块
      })
    return () => {
      cancelled = true
    }
  }, [snapshot.project_id, snapshot.snapshot_id])

  if (dataUrl) {
    return (
      <img
        src={dataUrl}
        alt=""
        style={{
          width: 84,
          height: 48,
          objectFit: 'cover',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--color-surface-muted)',
          flexShrink: 0,
        }}
      />
    )
  }

  return (
    <span
      aria-hidden
      style={{
        width: 84,
        height: 48,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--color-surface-muted)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 10,
        color: 'var(--color-text-muted)',
        flexShrink: 0,
      }}
    >
      快照
    </span>
  )
}

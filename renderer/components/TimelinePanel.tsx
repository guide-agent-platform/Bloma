import React from 'react'
import { useAtom, useAtomValue } from 'jotai'
import { ChevronUp } from './icons'
import { timelineExpandedAtom, snapshotsListAtom, selectedSnapshotAtom } from './atoms'
import type { Snapshot, SnapshotDocumentEntry } from './atoms'

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

  // T7 文档版本化：回看某快照冻结的文档（「当时的想法」）
  const [documentsSnapshot, setDocumentsSnapshot] = React.useState<Snapshot | null>(null)

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
                onViewDocuments={() => setDocumentsSnapshot(snap)}
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

    {/* T7：回看该版本冻结的文档（「当时的想法」） */}
    {documentsSnapshot && (
      <SnapshotDocumentsModal
        snapshot={documentsSnapshot}
        onClose={() => setDocumentsSnapshot(null)}
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
          回到这个版本之后，{snapshot.name} 之后的版本仍然保留在版本记录上，你可以随时再切换回来。
        </p>
        {/* Phase 7 U3 I5（2026-09-10）：data/ 边界句按真实能力写——沙箱内数据随版本回滚
            是 Bloma 的真实能力（恢复原语先清空再复制）；导出部署后的数据不归 Bloma 管。 */}
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-5)', lineHeight: 'var(--line-height-base)', background: 'var(--color-surface-muted)', padding: 'var(--space-3)', borderRadius: 'var(--radius-sm)' }}>
          恢复会把应用和它在 Bloma 内保存的数据一起回到那一版；导出部署后在别处产生的数据不受影响。
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
  /** T7：回看该版本冻结的文档（「当时的想法」），与回滚互不冲突 */
  onViewDocuments: () => void
}> = ({ snapshot, isCurrent, showThumbnail, onClick, onViewDocuments }) => {
  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-flex',
        borderRadius: 'var(--radius-md)',
        flexShrink: 0,
      }}
    >
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
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
          {snapshot.name}
          {/* Phase 7 U3 I6：恢复产生的版本带指针链徽标（「从该版恢复」——区分原生新版本与
              恢复点，用户答得清「这版是哪来的」） */}
          {snapshot.derived_from ? (
            <span
              data-ai-id={`snap-derived-${snapshot.snapshot_id.slice(0, 8)}`}
              title={`从 ${snapshot.derived_from.slice(0, 8)} 恢复而来`}
              style={{
                fontSize: 9,
                padding: '0 4px',
                borderRadius: 999,
                background: isCurrent ? 'rgba(255,255,255,0.25)' : 'var(--color-surface-muted)',
                color: isCurrent ? 'var(--white)' : 'var(--color-text-muted)',
                fontWeight: 500,
              }}
            >
              恢复
            </span>
          ) : null}
        </span>
        <span style={{ fontSize: 10, opacity: 0.7 }}>
          {new Date(snapshot.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </span>
      </span>
    </button>

    {/* T7：回看该版本冻结的文档（「当时的想法」）。stopPropagation 避免触发回滚。 */}
    <button
      type="button"
      title="回看当时的想法（该版本冻结的文档）"
      aria-label="回看当时的想法"
      onClick={(e) => {
        e.stopPropagation()
        onViewDocuments()
      }}
      style={{
        position: 'absolute',
        top: 3,
        right: 3,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 20,
        height: 20,
        borderRadius: 'var(--radius-full)',
        background: isCurrent ? 'rgba(255,255,255,0.28)' : 'var(--color-surface-muted)',
        color: isCurrent ? 'var(--white)' : 'var(--color-text-muted)',
        border: 'none',
        fontSize: 10,
        lineHeight: 1,
        cursor: 'pointer',
        boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
        transition: 'all var(--transition-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = isCurrent ? 'rgba(255,255,255,0.45)' : 'var(--glass-bg-strong)'
        e.currentTarget.style.color = isCurrent ? 'var(--white)' : 'var(--color-text)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = isCurrent ? 'rgba(255,255,255,0.28)' : 'var(--color-surface-muted)'
        e.currentTarget.style.color = isCurrent ? 'var(--white)' : 'var(--color-text-muted)'
      }}
    >
      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
    </button>
    </span>
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

/* =========================================================================
   SnapshotDocumentsModal — T7 回看某快照冻结的文档（「当时的想法」）
   存量快照（T7 前归档）没有冻结文档：frozen=false 如实提示缺失，不补造。
   ========================================================================= */

const DOC_TYPE_LABELS: Record<SnapshotDocumentEntry['type'], string> = {
  prd: 'PRD 产品需求',
  user_story: '用户故事',
  plantuml: '架构图',
  gwt_feature: 'GWT 测试',
  test_report: '测试报告',
  changelog: '变更日志',
  decisions: '决策记录',
  plan: '技术合同',
  loop_log: 'Loop 过程记录',
}

const SnapshotDocumentsModal: React.FC<{
  snapshot: Snapshot
  onClose: () => void
}> = ({ snapshot, onClose }) => {
  const [state, setState] = React.useState<
    | { status: 'loading' | 'empty' | 'error'; documents: SnapshotDocumentEntry[]; error?: string }
    | { status: 'ready'; documents: SnapshotDocumentEntry[] }
  >({ status: 'loading', documents: [] })
  const [selected, setSelected] = React.useState<SnapshotDocumentEntry | null>(null)
  const [content, setContent] = React.useState<{ loading: boolean; text: string; error?: string }>({ loading: false, text: '' })

  // 快照切换时重置选中文档（2026-08-27 线上案例：selected 残留旧快照的 document_id，
  // 带着新 snapshot_id 去读 → DOCUMENT_NOT_FOUND 主进程噪音 ×N）
  React.useEffect(() => {
    setSelected(null)
  }, [snapshot.snapshot_id])

  React.useEffect(() => {
    let cancelled = false
    const api = window.electronAPI
    if (!api?.snapshots?.documentList) {
      setState({ status: 'error', documents: [], error: '当前环境不支持回看文档。' })
      return
    }
    void api.snapshots
      .documentList({
        request_id: crypto.randomUUID(),
        project_id: snapshot.project_id,
        snapshot_id: snapshot.snapshot_id,
      })
      .then((result) => {
        if (cancelled) return
        if (!result?.ok) {
          setState({ status: 'error', documents: [], error: result?.error?.message ?? '读取失败。' })
          return
        }
        if (result.data.frozen === false || result.data.documents.length === 0) {
          setState({ status: 'empty', documents: [] })
          return
        }
        setState({ status: 'ready', documents: result.data.documents })
        setSelected(result.data.documents[0] ?? null)
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', documents: [], error: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [snapshot.project_id, snapshot.snapshot_id])

  // 选中文档变化 → 读取冻结内容
  React.useEffect(() => {
    if (!selected || state.status !== 'ready') {
      setContent({ loading: false, text: '' })
      return
    }
    let cancelled = false
    const api = window.electronAPI
    if (!api?.snapshots?.documentRead) {
      setContent({ loading: false, text: '', error: '当前环境不支持读取文档。' })
      return
    }
    setContent({ loading: true, text: '' })
    void api.snapshots
      .documentRead({
        request_id: crypto.randomUUID(),
        project_id: snapshot.project_id,
        snapshot_id: snapshot.snapshot_id,
        document_id: selected.document_id,
      })
      .then((result) => {
        if (cancelled) return
        if (result?.ok) {
          setContent({ loading: false, text: result.data.content })
        } else {
          setContent({ loading: false, text: '', error: result?.error?.message ?? '读取失败。' })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setContent({ loading: false, text: '', error: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
    }
  }, [selected, snapshot.project_id, snapshot.snapshot_id, state.status])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`回看「${snapshot.name}」的文档`}
      data-ai-id="snapshot-documents-modal"
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div style={{
        background: 'var(--white)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-lg)',
        animation: 'tile-enter 0.2s ease both',
        display: 'flex',
        flexDirection: 'column',
        maxWidth: 760,
        width: '90%',
        maxHeight: '78vh',
      }}>
        {/* 头部 */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--space-5) var(--space-6)',
          borderBottom: '1px solid var(--color-border)',
        }}>
          <div>
            <p style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, color: 'var(--color-text)' }}>
              「{snapshot.name}」当时的想法
            </p>
            <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 2 }}>
              {new Date(snapshot.created_at).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 冻结的文档（与代码快照对齐）
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="关闭"
            style={{
              width: 28, height: 28,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-muted)',
              cursor: 'pointer',
              transition: 'all var(--transition-fast)',
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
            ✕
          </button>
        </div>

        {/* 主体 */}
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-5) var(--space-6)', minHeight: 200 }}>
          {state.status === 'loading' && (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
              正在读取该版本冻结的文档…
            </p>
          )}

          {state.status === 'empty' && (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)', lineHeight: 'var(--line-height-base)' }}>
              这个版本没有冻结当时的文档（早期版本只保存了代码快照），无法回看当时的想法。已如实标注，不补造内容。
            </p>
          )}

          {state.status === 'error' && (
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger, #dc2626)', lineHeight: 'var(--line-height-base)' }}>
              读取失败：{state.error}
            </p>
          )}

          {state.status === 'ready' && (
            <div style={{ display: 'flex', gap: 'var(--space-4)', minHeight: 0 }}>
              {/* 文档列表 */}
              <div style={{
                width: 220, flexShrink: 0,
                display: 'flex', flexDirection: 'column', gap: 'var(--space-1)',
              }}>
                {state.documents.map((doc) => {
                  const active = selected?.document_id === doc.document_id
                  return (
                    <button
                      key={doc.document_id}
                      onClick={() => setSelected(doc)}
                      style={{
                        textAlign: 'left',
                        padding: 'var(--space-2) var(--space-3)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 'var(--font-size-sm)',
                        fontWeight: active ? 600 : 500,
                        color: active ? 'var(--white)' : 'var(--color-text)',
                        background: active
                          ? 'linear-gradient(135deg, var(--violet-600), var(--violet-500))'
                          : 'transparent',
                        cursor: 'pointer',
                        transition: 'all var(--transition-fast)',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = 'var(--color-surface-muted)'
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.background = 'transparent'
                        }
                      }}
                    >
                      {DOC_TYPE_LABELS[doc.type] ?? doc.type}
                      <span style={{ display: 'block', fontSize: 11, opacity: 0.7, marginTop: 1 }}>
                        {doc.file}
                      </span>
                    </button>
                  )
                })}
              </div>

              {/* 内容 */}
              <div style={{
                flex: 1, minWidth: 0,
                background: 'var(--color-surface-muted)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-md)',
                padding: 'var(--space-4)',
                overflow: 'auto',
                maxHeight: '52vh',
              }}>
                {content.loading && (
                  <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>读取内容…</p>
                )}
                {!content.loading && content.error && (
                  <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-danger, #dc2626)' }}>
                    {content.error}
                  </p>
                )}
                {!content.loading && !content.error && (
                  <pre style={{
                    margin: 0,
                    fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, monospace)',
                    fontSize: 'var(--font-size-xs)',
                    lineHeight: 'var(--line-height-base)',
                    color: 'var(--color-text)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}>
                    {content.text}
                  </pre>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 底部 */}
        <div style={{
          display: 'flex', justifyContent: 'flex-end',
          padding: 'var(--space-4) var(--space-6)',
          borderTop: '1px solid var(--color-border)',
        }}>
          <button onClick={onClose} style={{
            height: 36, padding: '0 var(--space-5)',
            fontSize: 'var(--font-size-sm)', fontWeight: 600,
            color: 'var(--color-text)', background: 'var(--color-surface-muted)',
            border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
          }}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}

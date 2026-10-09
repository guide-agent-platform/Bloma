import React from 'react'
import { useAtomValue } from 'jotai'
import type { AttachmentInfo } from '../../shared/attachment-types'
import { composerScopeAtom } from '../composer-state'
import { useAttachmentReuse } from '../hooks/use-attachment-reuse'

export const HistoryAttachments: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const scope = useAtomValue(composerScopeAtom)
  const reuse = useAttachmentReuse()
  const [items, setItems] = React.useState<AttachmentInfo[]>([])
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  React.useEffect(() => {
    let disposed = false
    void window.electronAPI?.composer.history({ request_id: crypto.randomUUID(), project_id: scope.project_id, session_id: scope.session_id }).then(result => {
      if (disposed) return
      if (result.ok) setItems(result.data); else setError(result.error.message)
    }).catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true }
  }, [scope.project_id, scope.session_id])
  return <section role="region" aria-label="历史材料" style={{ padding: 8, marginBottom: 6, border: '1px solid var(--color-border)', borderRadius: 10 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}><span>本会话的材料快照</span><button className="composer-add-button" aria-label="关闭历史材料" onClick={onClose}>×</button></div>
    {error && <p role="alert">{error}</p>}
    {!error && items.length === 0 && <span>暂时没有历史材料</span>}
    <div className="composer-attachment-row">{items.map(info => <button className="attachment-pill" key={info.attachment_id} disabled={busy} onClick={() => {
      setBusy(true)
      void reuse(info).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false))
    }}>{info.kind === 'text' ? '📄' : '🖼️'} {info.name} · {info.sha256.slice(0, 6)}</button>)}</div>
  </section>
}

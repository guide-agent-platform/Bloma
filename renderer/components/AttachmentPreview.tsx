import React from 'react'
import type { AttachmentInfo, AttachmentPreview } from '../../shared/attachment-types'
import { useAttachmentReuse } from '../hooks/use-attachment-reuse'

export const AttachmentPreviewDialog: React.FC<{ info: AttachmentInfo; onClose: () => void }> = ({ info, onClose }) => {
  const reuse = useAttachmentReuse()
  const [reusing, setReusing] = React.useState(false)
  const [preview, setPreview] = React.useState<AttachmentPreview>()
  const [error, setError] = React.useState('')
  const [line, setLine] = React.useState(1)
  React.useEffect(() => {
    let disposed = false
    void window.electronAPI?.composer.preview({ request_id: crypto.randomUUID(), ...info }).then(result => {
      if (disposed) return
      if (result.ok) setPreview(result.data); else setError(result.error.message)
    }).catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true }
  }, [info.attachment_id])
  const read = async (start: number) => {
    try {
      const result = await window.electronAPI?.composer.read({ request_id: crypto.randomUUID(), ...info, start_line: start, limit: 200 })
      if (result?.ok) { setPreview({ info, page: result.data }); setLine(start); setError('') }
      else setError(result && !result.ok ? result.error.message : '读取接口不可用')
    } catch (reason) { setError(String(reason)) }
  }
  return <div style={{ position: 'fixed', inset: 0, zIndex: 1200, background: 'rgba(0,0,0,0.35)', display: 'grid', placeItems: 'center' }}>
    <section role="dialog" aria-modal="true" aria-label={`材料预览：${info.name}`} style={{ background: 'var(--color-surface, white)', color: 'var(--color-text)', borderRadius: 12, padding: 20, width: 'min(850px, 85vw)', maxHeight: '85vh', overflow: 'auto' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between' }}><strong>{info.name}</strong><button onClick={onClose}>关闭预览</button></header>
      <p style={{ fontSize: 12 }}>只读快照 · {(info.bytes / 1024).toFixed(1)} KiB · {info.sha256.slice(0, 12)}</p>
      <button className="attachment-pill" disabled={reusing} onClick={() => {
        setReusing(true)
        void reuse(info).then(onClose).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setReusing(false))
      }}>添加到当前草稿</button>
      {error && <p role="alert">{error}</p>}
      {preview?.dataUrl && <img src={preview.dataUrl} alt={info.name} style={{ maxWidth: '100%', maxHeight: '60vh' }} />}
      {preview?.page && <>
        <p>已展示第 {preview.page.start_line}–{preview.page.end_line} 行 / 共 {preview.page.total_lines} 行{preview.page.truncated ? '（未展示全文）' : ''}</p>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '55vh', overflow: 'auto', padding: 12, background: 'var(--glass-bg-soft)' }}>{preview.page.text}</pre>
        <label>起始行 <input type="number" min={1} max={preview.page.total_lines} value={line} onChange={event => setLine(Number(event.target.value))} /></label>
        <button onClick={() => void read(line)}>读取该页</button>
        {preview.page.next_line && <button onClick={() => void read(preview.page!.next_line!)}>下一页</button>}
      </>}
    </section>
  </div>
}
export const MessageAttachments: React.FC<{ attachments?: AttachmentInfo[] }> = ({ attachments }) => {
  const [selected, setSelected] = React.useState<AttachmentInfo>()
  return <>
    <div className="message-materials">{attachments?.map(info => <button className="attachment-pill" title={`${info.name} · ${info.sha256.slice(0, 12)}`} key={info.attachment_id} onClick={() => setSelected(info)}>{info.kind === 'text' ? '📄' : '🖼️'} {info.name} · {(info.bytes / 1024).toFixed(1)} KiB</button>)}</div>
    {selected && <AttachmentPreviewDialog info={selected} onClose={() => setSelected(undefined)} />}
  </>
}

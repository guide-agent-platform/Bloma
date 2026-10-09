import React from 'react'
import type { ChatSubmitInput, SendReceipt } from '../../shared/attachment-types'
import { MessageAttachments } from './AttachmentPreview'

export const MessageReceipts: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const [records, setRecords] = React.useState<Array<{ input: ChatSubmitInput; receipt: SendReceipt }>>([])
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState<string>()
  const operations = React.useRef(new Map<string, { id: string; generation: number }>())
  React.useEffect(() => {
    let disposed = false
    const api = window.electronAPI?.composer
    if (!api?.receipts) return
    const refresh = async () => {
      try {
        const result = await api.receipts({ request_id: crypto.randomUUID(), session_id: sessionId })
        if (!disposed && result.ok) {
          setRecords(result.data)
          for (const { receipt } of result.data) {
            const operation = operations.current.get(receipt.client_message_id)
            if (operation && (receipt.run_generation ?? 1) > operation.generation) operations.current.delete(receipt.client_message_id)
          }
        }
      } catch { /* The composer retains send snapshots when IPC is unavailable. */ }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => { disposed = true; clearInterval(timer); setRecords([]) }
  }, [sessionId])
  const resolve = async (input: ChatSubmitInput, receipt: SendReceipt, action: 'resume' | 'cancel') => {
    const api = window.electronAPI?.composer
    if (!api?.recover || busy) return
    setBusy(receipt.client_message_id); setError('')
    const operation = operations.current.get(receipt.client_message_id) ?? { id: crypto.randomUUID(), generation: receipt.run_generation ?? 1 }
    operations.current.set(receipt.client_message_id, operation)
    try {
      const result = await api.recover({ request_id: crypto.randomUUID(), project_id: input.project_id, session_id: sessionId, client_message_id: receipt.client_message_id, operation_id: operation.id, action })
      if (!result.ok) throw new Error(result.error.message)
      operations.current.delete(receipt.client_message_id)
      setRecords(previous => previous.map(item => item.receipt.client_message_id === receipt.client_message_id ? { ...item, receipt: result.data } : item))
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(undefined) }
  }
  return <>{error && <p role="alert">{error}</p>}{records.filter(item => ['queued', 'needs_recovery', 'failed', 'cancelled'].includes(item.receipt.status)).map(({ input, receipt }) => <div
    key={receipt.client_message_id} data-ai-id={receipt.status === 'queued' ? 'queued-message' : 'message-receipt'}
    role="status" style={{ fontSize: 12, color: receipt.status === 'failed' ? 'var(--color-danger)' : 'var(--color-text-muted)', padding: 8, border: '1px solid var(--color-border)', borderRadius: 8 }}>
    {receipt.status === 'queued' ? '已排队' : receipt.status === 'needs_recovery' ? '已接收，等待你选择是否继续' : receipt.status === 'cancelled' ? '已取消执行' : '已接收，执行失败'}：{input.content || `${input.attachment_refs.length} 个材料`}
    {receipt.error && <p>{receipt.error}</p>}
    <MessageAttachments attachments={receipt.attachments} />
    {receipt.recovery_may_repeat && <p>此前可能已部分执行；继续会按当前项目状态重新开始这条消息，已发生的改动会保留。</p>}
    {['needs_recovery', 'failed', 'cancelled'].includes(receipt.status) && <button className="attachment-pill" disabled={Boolean(busy)} onClick={() => void resolve(input, receipt, 'resume')}>继续执行</button>}
    {receipt.status !== 'cancelled' && <button className="attachment-pill" disabled={Boolean(busy)} onClick={() => void resolve(input, receipt, 'cancel')}>不再执行</button>}
  </div>)}</>
}

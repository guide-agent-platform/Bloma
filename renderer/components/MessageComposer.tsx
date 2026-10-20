import React from 'react'
import { useAtomValue } from 'jotai'
import { activeAgentSessionIdAtom, agentMessagesFamily } from '../agent-atoms'
import { hasUsableChannelsAtom, chatInputFocusSignalAtom, chatInputHintAtom } from './atoms-sprint2'
import { useComposer, type ComposerSend } from '../hooks/use-composer'
import { VoiceInput } from './speech/VoiceInput'
import { VoiceRecordingBar } from './speech/VoiceRecordingBar'
import { useVoiceRecorder } from './speech/useVoiceRecorder'
import { ArrowUp, IconStop, Paperclip, History, FileText, X } from './icons'
import { AttachmentPreviewDialog } from './AttachmentPreview'
import { HistoryAttachments } from './HistoryAttachments'
import type { AttachmentInfo } from '../../shared/attachment-types'
import '../styles/chat.css'

export const MessageComposer: React.FC<{
  onSendMessage?: ComposerSend
  onMessageSent?: () => void
  busy: boolean
  onStopGeneration?: () => void
  onOpenSettings?: () => void
  usage?: string
  placeholder?: string
}> = ({ onSendMessage, onMessageSent, busy, onStopGeneration, onOpenSettings, usage, placeholder }) => {
  const composer = useComposer(onSendMessage, onMessageSent)
  const activeSession = useAtomValue(activeAgentSessionIdAtom)
  const messages = useAtomValue(agentMessagesFamily(activeSession ?? ''))
  const [legacyQueue, setLegacyQueue] = React.useState<string[]>([])
  React.useEffect(() => {
    const texts = new Set(messages.filter(message => message.role === 'user').map(message => message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')))
    setLegacyQueue(previous => previous.filter(text => !texts.has(text)))
  }, [messages])
  const hasChannels = useAtomValue(hasUsableChannelsAtom)
  const focus = useAtomValue(chatInputFocusSignalAtom)
  const hint = useAtomValue(chatInputHintAtom)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const [selectedPreview, setSelectedPreview] = React.useState<AttachmentInfo>()
  const [historyOpen, setHistoryOpen] = React.useState(false)
  React.useEffect(() => { setHistoryOpen(false); setSelectedPreview(undefined) }, [activeSession])
  const voice = useVoiceRecorder(text => composer.changeText(composer.draft.text ? `${composer.draft.text} ${text}` : text))
  const resizeInput = React.useCallback(() => {
    const input = inputRef.current
    if (!input) return
    input.style.height = '36px'
    input.style.height = `${Math.min(100, Math.max(36, input.scrollHeight))}px`
  }, [])
  React.useLayoutEffect(resizeInput, [resizeInput, composer.draft.text, voice.phase])
  React.useEffect(() => {
    const frame = inputRef.current?.parentElement
    if (!frame || typeof ResizeObserver === 'undefined') return
    let previousWidth = frame.getBoundingClientRect().width
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width !== undefined && width !== previousWidth) { previousWidth = width; resizeInput() }
    })
    observer.observe(frame)
    return () => observer.disconnect()
  }, [resizeInput, voice.phase])
  React.useEffect(() => { if (focus) inputRef.current?.focus() }, [focus])
  const previousVoice = React.useRef(voice.phase)
  React.useEffect(() => {
    if (previousVoice.current === 'transcribing' && voice.phase === 'idle') inputRef.current?.focus()
    previousVoice.current = voice.phase
  }, [voice.phase])
  const canSend = composer.ready && !composer.sending && !composer.importing && !composer.importFailure && Boolean(composer.draft.text.trim() || composer.images.length || composer.draft.pending_send)
  const submit = () => {
    if (!canSend) return
    if (hasChannels === false) { onOpenSettings?.(); return }
    if (busy && !window.electronAPI?.composer) setLegacyQueue(previous => [...previous, composer.draft.text.trim()])
    void composer.send()
  }
  return <div className="message-composer" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={event => { if (event.dataTransfer.files.length) { event.preventDefault(); void composer.importFiles(Array.from(event.dataTransfer.files)) } }}>
    {selectedPreview && <AttachmentPreviewDialog info={selectedPreview} onClose={() => setSelectedPreview(undefined)} />}
    {historyOpen && <HistoryAttachments onClose={() => setHistoryOpen(false)} />}
    {legacyQueue.map((text, index) => <p data-ai-id="queued-message" key={`${index}-${text}`} style={{ opacity: 0.55 }}>排队中：{text}</p>)}
    {(composer.images.length > 0 || composer.error) && <div className="composer-attachment-row">
      {composer.images.map((image, index) => <span className="attachment-pill" key={image.id} data-ai-id="paste-image-chip">
        {image.dataUrl ? <img data-ai-id="paste-image-thumb" src={image.dataUrl} alt={`粘贴图片 ${index + 1}`} style={{ width: 24, height: 24, objectFit: 'cover' }} /> : <span>{image.info?.kind === 'text' ? <FileText size={14} /> : '预览加载中'}</span>}
        <button className="attachment-label" title={image.info?.sha256} disabled={!image.info} onClick={() => image.info && setSelectedPreview(image.info)}>{image.name}{!image.info && index + 1}{image.info ? ` · ${(image.info.bytes / 1024).toFixed(1)} KiB` : ''}{image.info && composer.images.filter(item => item.name === image.name).length > 1 ? ` · ${image.info.sha256.slice(0, 6)}` : ''}</button>
        <button className="attachment-remove" aria-label={`移除${image.info?.kind === 'text' ? '文件' : '图片'} ${index + 1}`} onClick={() => composer.remove(image.id)}><X size={12} /></button>
      </span>)}
      {composer.error && <span role="alert" data-ai-id="paste-image-error" style={{ color: 'var(--color-danger)', fontSize: 12 }}>{composer.error}</span>}
      {composer.importFailure && <button onClick={composer.dismissImportFailure}>移除失败项，保留已有内容</button>}
    </div>}
    {composer.draft.pending_send && !composer.sending && <p role="status" style={{ fontSize: 12 }}>待确认消息已保留，发送会重试该消息；当前新输入会继续保留。</p>}
    {composer.importing > 0 && <p role="status">正在保存图片…</p>}
    <div className="composer-input-frame">
      <input ref={fileRef} type="file" multiple aria-label="选择附件文件" style={{ display: 'none' }} onChange={event => { void composer.importFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
      <button className="composer-add-button" aria-label="添加附件" title="选择图片或 UTF-8 文本、代码、CSV、JSON 文件" onClick={() => fileRef.current?.click()}><Paperclip /></button>
      <button className="composer-add-button" aria-label="历史材料" title="引用本会话的材料快照" onClick={() => setHistoryOpen(previous => !previous)}><History /></button>
      {voice.phase === 'recording' ? <VoiceRecordingBar voice={voice} maxSeconds={60} /> : <textarea
        ref={inputRef} aria-label="消息输入" value={composer.draft.text} rows={1}
        placeholder={hint ?? (busy ? '正在制作，可以继续补充…' : hasChannels === false ? '还没有连接 AI 模型，先去设置页连接' : placeholder ?? '描述你的想法…')}
        onChange={event => composer.changeText(event.target.value)}
        onPaste={event => {
          const items = event.clipboardData?.items
          if (!items || !Array.from(items).some(item => item.kind === 'file')) return
          event.preventDefault()
          void composer.importItems(items)
        }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit() } }}
        style={{ flex: 1, height: 36, resize: 'none', fontFamily: 'inherit', fontSize: 'var(--font-size-sm)', background: 'transparent', color: 'var(--color-text)', border: 'none', outline: 'none' }}
      />}
      <VoiceInput voice={voice} />
      {voice.phase !== 'recording' && (busy
        ? <button aria-label="停止本轮制作" title="停止本轮制作（已确认的需求与已交付版本会保留）" onClick={onStopGeneration} style={{ borderRadius: 9, width: 32, height: 32, padding:0, border: 0, background: 'var(--color-danger)', color: 'white' }}><IconStop size={16} /></button>
        : <button aria-label="发送消息" disabled={!canSend} onClick={submit} style={{ borderRadius: 9, width: 32, height: 32, padding:0, border: 0, background: canSend ? 'var(--theatre-accent, var(--color-quick))' : 'var(--color-surface-muted)', color: canSend ? 'var(--theatre-on-accent, white)' : 'var(--color-text-muted)' }}><ArrowUp size={17} /></button>)}
    </div>
    <p className="composer-hint">{composer.sending ? '正在确认接收…' : '按 Enter 发送，按 Shift + Enter 换行'}</p>
    {usage && <p data-ai-id="session-usage-hint" style={{ fontSize: 12, color: 'var(--color-text-muted)', textAlign: 'center', margin: 0 }}>{usage}</p>}
  </div>
}

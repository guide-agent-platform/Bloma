import React from 'react'
import { useAtomValue } from 'jotai'
import { CardOptions } from './CardOptions'
import type { CardOption } from './CardOptions'
import { WaitingFeedback } from './WaitingFeedback'
import { ArrowUp, MessageSquare } from './icons'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  agentStreamStateFamily,
  hasActiveStreamAtom,
  globalUserErrorAtom,
  projectModeAtom,
} from './atoms'
import type { AgentMessage, ProjectMode } from './atoms'

export interface ChatPanelProps {
  /** 向导 Agent 发出的卡片选项（由上层从 AgentEvent 中解析） */
  cardOptions?: CardOption[]
  /** 用户选择卡片选项 */
  onCardOptionSelect?: (option: CardOption) => void
  /** 用户提交文本消息 */
  onSendMessage?: (content: string) => void
  /** 是否正在等待 Agent 响应 */
  isWaiting?: boolean
  /** 等待开始时间（用于计算已等待秒数） */
  waitStartTime?: number
  /** 当前等待阶段的操作描述 */
  waitActionLabel?: string
  /** 超时-继续等待 */
  onContinueWaiting?: () => void
  /** 超时-查看已有 */
  onViewPartial?: () => void
}

const glassTile: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100%',
  overflow: 'hidden',
  background: 'var(--glass-bg)',
  backdropFilter: 'blur(var(--glass-blur))',
  WebkitBackdropFilter: 'blur(var(--glass-blur))',
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--radius-tile)',
  boxShadow: 'var(--shadow-glass)',
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  cardOptions,
  onCardOptionSelect,
  onSendMessage,
  isWaiting = false,
  waitStartTime,
  waitActionLabel = '生成可运行版本',
  onContinueWaiting,
  onViewPartial,
}) => {
  const activeSessionId = useAtomValue(activeAgentSessionIdAtom)
  const mode = useAtomValue(projectModeAtom)
  const hasActiveStream = useAtomValue(hasActiveStreamAtom)
  const globalError = useAtomValue(globalUserErrorAtom)

  const messagesAtom = activeSessionId ? agentMessagesFamily(activeSessionId) : null
  const messages = useAtomValue(messagesAtom ?? agentMessagesFamily('__unused__'))
  const streamStateAtom = activeSessionId ? agentStreamStateFamily(activeSessionId) : null
  const streamState = useAtomValue(streamStateAtom ?? agentStreamStateFamily('__unused__'))

  const [inputValue, setInputValue] = React.useState('')
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  const streamingContent = hasActiveStream && streamState ? streamState.content : ''

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, cardOptions])

  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!isWaiting || !waitStartTime) {
      setElapsed(0)
      return
    }
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - waitStartTime) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [isWaiting, waitStartTime])

  const handleSubmit = () => {
    const trimmed = inputValue.trim()
    if (!trimmed || isWaiting) return
    onSendMessage?.(trimmed)
    setInputValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const canSend = !isWaiting && inputValue.trim().length > 0

  return (
    <div data-ai-id="chat-panel" style={glassTile}>
      {/* 磁贴头 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-4) var(--space-5)',
          flexShrink: 0,
          borderBottom: '1px solid var(--color-border)',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--color-text)' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--color-quick)', display: 'inline-block' }} />
          对话
        </span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)' }}>Enter 发送</span>
      </div>

      {/* 消息列表 */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 'var(--space-4) var(--space-5)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
          minHeight: 0,
        }}
      >
        {/* 空状态 */}
        {messages.length === 0 && !streamingContent && !isWaiting && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 'var(--space-6)' }}>
            <div>
              <span
                aria-hidden
                style={{
                  width: 52,
                  height: 52,
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--white)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 'var(--space-3)',
                  color: 'var(--color-quick)',
                  boxShadow: 'var(--shadow-sm)',
                }}
              >
                <MessageSquare size={24} />
              </span>
              <p style={{ fontSize: 'var(--font-size-md)', fontWeight: 600, marginBottom: 'var(--space-1)', color: 'var(--color-text)' }}>
                告诉我你想做什么
              </p>
              <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--color-text-muted)' }}>
                用日常语言描述你的想法，我会帮你一步步做出来。
              </p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} mode={mode} />
        ))}

        {streamingContent && (
          <MessageBubble
            message={{ role: 'assistant', content: [{ type: 'text', text: streamingContent }], timestamp: Date.now() }}
            mode={mode}
            isStreaming
          />
        )}

        {isWaiting && (
          <WaitingFeedback
            elapsedSeconds={elapsed}
            actionLabel={waitActionLabel}
            onContinueWaiting={onContinueWaiting}
            onViewPartial={onViewPartial}
          />
        )}

        {globalError && (
          <div
            role="alert"
            style={{
              padding: 'var(--space-3) var(--space-4)',
              background: 'var(--color-danger-soft)',
              border: '1px solid var(--color-danger)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--font-size-sm)',
              color: 'var(--color-danger)',
            }}
          >
            {globalError}
          </div>
        )}

        {cardOptions && cardOptions.length > 0 && onCardOptionSelect && (
          <CardOptions options={cardOptions} onSelect={onCardOptionSelect} disabled={isWaiting} />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区（胶囊） */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', flexShrink: 0, borderTop: '1px solid var(--color-border)' }}>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-2)',
            alignItems: 'flex-end',
            background: 'var(--glass-bg-soft)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-full)',
            padding: 'var(--space-1) var(--space-1) var(--space-1) var(--space-4)',
            transition: 'border-color var(--transition-fast), box-shadow var(--transition-fast)',
          }}
        >
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isWaiting}
            placeholder={isWaiting ? '正在处理中…' : '描述你的想法…'}
            rows={1}
            style={{
              flex: 1,
              height: 36,
              padding: 'var(--space-2) 0',
              fontSize: 'var(--font-size-sm)',
              fontFamily: 'inherit',
              color: 'var(--color-text)',
              background: 'transparent',
              border: 'none',
              outline: 'none',
              resize: 'none',
              lineHeight: 1.5,
              maxHeight: 120,
            }}
          />
          <button
            onClick={handleSubmit}
            disabled={!canSend}
            aria-label="发送消息"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 36,
              height: 36,
              borderRadius: 'var(--radius-full)',
              flexShrink: 0,
              background: canSend
                ? 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'
                : 'var(--gray-200)',
              color: canSend ? 'var(--white)' : 'var(--gray-400)',
              boxShadow: canSend ? '0 4px 12px -2px rgba(124,58,237,0.45)' : 'none',
              transition: 'all var(--transition-fast)',
              cursor: canSend ? 'pointer' : 'not-allowed',
            }}
          >
            <ArrowUp size={17} />
          </button>
        </div>
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-2)', textAlign: 'center' }}>
          Enter 发送 · Shift+Enter 换行
        </p>
      </div>
    </div>
  )
}

/* =========================================================================
   MessageBubble
   ========================================================================= */

interface MessageBubbleProps {
  message: AgentMessage
  mode: ProjectMode | null
  isStreaming?: boolean
}

const userBubbleBg = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? 'linear-gradient(135deg, var(--color-longterm), var(--color-longterm-bright))'
    : 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'

const userBubbleShadow = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? '0 4px 12px -3px rgba(14,116,144,0.35)'
    : '0 4px 12px -3px rgba(124,58,237,0.35)'

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, mode, isStreaming = false }) => {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')

  if (!text && !isStreaming) return null

  if (isSystem) {
    return (
      <div
        style={{
          alignSelf: 'center',
          padding: 'var(--space-2) var(--space-4)',
          background: 'var(--glass-bg-soft)',
          border: '1px dashed var(--color-border)',
          borderRadius: 'var(--radius-full)',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          maxWidth: '90%',
          textAlign: 'center',
          animation: 'tile-enter 0.3s ease both',
        }}
      >
        {text}
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        maxWidth: '84%',
        alignSelf: isUser ? 'flex-end' : 'flex-start',
        animation: 'tile-enter 0.3s ease both',
      }}
    >
      <div
        style={{
          maxWidth: '100%',
          padding: 'var(--space-3) var(--space-4)',
          borderRadius: 'var(--radius-md)',
          fontSize: 'var(--font-size-sm)',
          lineHeight: 'var(--line-height-base)',
          color: isUser ? 'var(--white)' : 'var(--color-text)',
          background: isUser ? userBubbleBg(mode) : 'var(--white)',
          border: isUser ? 'none' : '1px solid var(--color-border)',
          boxShadow: isUser ? userBubbleShadow(mode) : 'var(--shadow-sm)',
          borderBottomRightRadius: isUser ? 'var(--radius-sm)' : undefined,
          borderBottomLeftRadius: !isUser ? 'var(--radius-sm)' : undefined,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text || (isStreaming ? '…' : '')}
      </div>
      <span
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          marginTop: 2,
          padding: '0 var(--space-1)',
        }}
      >
        {isUser ? '你' : '向导'} · {new Date(message.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
      </span>
    </div>
  )
}

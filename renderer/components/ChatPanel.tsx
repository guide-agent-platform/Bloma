import React from 'react'
import { atom, useAtomValue } from 'jotai'
import { CardOptions } from './CardOptions'
import type { CardOption } from './CardOptions'
import { WaitingFeedback } from './WaitingFeedback'
import { ToolBlocksReplay, ToolCallFeed } from './ToolCallBlock'
import { DelegationFeed } from './DelegationFeed'
import { Markdown } from './Markdown'
import { ArrowUp, MessageSquare, IconStop } from './icons'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  agentStreamStateFamily,
  hasActiveStreamAtom,
  globalUserErrorAtom,
  projectModeAtom,
  workflowStageAtom,
} from './atoms'
import type { AgentMessage, AgentStreamState, ProjectMode } from './atoms'

export interface ChatPanelProps {
  /** 向导 Agent 发出的卡片选项（由上层从 AgentEvent 中解析） */
  cardOptions?: CardOption[]
  /** 决策卡标题（U7：让渡偏差描述 / 澄清方向等） */
  decisionTitle?: string
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
  /** 回访恢复：加载历史消息期间显示骨架占位（sitemap §2.6） */
  isHistoryLoading?: boolean
  /** 停止当前生成（U4：Agent 流式生成中点击停止） */
  onStopGeneration?: () => void
}

// 模块级常量：当 activeAgentSessionIdAtom 为 null 时的稳定 fallback atom，
// 避免在 atomFamily 中创建不可回收的 '__unused__' key。
const nullMessagesFallback = atom<AgentMessage[]>([])
const nullStreamFallback = atom<AgentStreamState>({
  running: false,
  events: [],
  content: '',
})

/** 生成类阶段 → WaitingFeedback 的「正在做什么」话术（按权威阶段展示，不再一刀切「生成可运行版本」）。 */
const STAGE_ACTION_LABELS: Record<string, string> = {
  generating_sketch: '生成草图',
  generating_mvp: '生成可运行版本',
  testing: '测试生成的版本',
  judge_review: '审查生成的版本',
  repairing: '自动修复问题',
  iterating: '修改应用',
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
  decisionTitle,
  onCardOptionSelect,
  onSendMessage,
  isWaiting = false,
  waitStartTime,
  waitActionLabel = '生成可运行版本',
  onContinueWaiting,
  onViewPartial,
  isHistoryLoading = false,
  onStopGeneration,
}) => {
  const activeSessionId = useAtomValue(activeAgentSessionIdAtom)
  const mode = useAtomValue(projectModeAtom)
  const hasActiveStream = useAtomValue(hasActiveStreamAtom)
  const globalError = useAtomValue(globalUserErrorAtom)
  const workflowStage = useAtomValue(workflowStageAtom)

  /** 忙碌 = 外部等待或本地流式运行中。输入框保持可编辑（草稿），只禁发，不再整体锁死。 */
  const busy = isWaiting || hasActiveStream

  const messages = useAtomValue(
    activeSessionId ? agentMessagesFamily(activeSessionId) : nullMessagesFallback,
  )
  const streamState = useAtomValue(
    activeSessionId ? agentStreamStateFamily(activeSessionId) : nullStreamFallback,
  )

  const [inputValue, setInputValue] = React.useState('')
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  const streamingContent = hasActiveStream && streamState ? streamState.content : ''

  // 历史回放关联表：tool_use_id → 工具名（loop 落盘的 user 轮 tool_result 只有 id，回放时回填名字）
  const toolNamesById = React.useMemo(() => {
    const map: Record<string, string> = {}
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool_use' && block.id && block.name) map[block.id] = block.name
      }
    }
    return map
  }, [messages])

  React.useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, streamingContent, cardOptions])

  // 本地流计时兜底：App 未传 waitStartTime 时以流启动时刻起算，保证 WaitingFeedback
  // 三级递进在纯流式等待下也生效（此前挂在恒 false 的 isWaiting 上，组件从未显示过）。
  const [streamStart, setStreamStart] = React.useState<number | undefined>()
  React.useEffect(() => {
    if (hasActiveStream) setStreamStart((previous) => previous ?? Date.now())
    else setStreamStart(undefined)
  }, [hasActiveStream])
  const effectiveWaitStart = waitStartTime ?? streamStart

  const [elapsed, setElapsed] = React.useState(0)
  React.useEffect(() => {
    if (!busy || !effectiveWaitStart) {
      setElapsed(0)
      return
    }
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - effectiveWaitStart) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [busy, effectiveWaitStart])

  const busyActionLabel = STAGE_ACTION_LABELS[workflowStage] ?? waitActionLabel

  const handleSubmit = () => {
    const trimmed = inputValue.trim()
    if (!trimmed || busy) return
    onSendMessage?.(trimmed)
    setInputValue('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const canSend = !busy && inputValue.trim().length > 0

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
        {isHistoryLoading ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-4)',
                  borderRadius: 'var(--radius-md)',
                  animation: `shimmer 1.5s ease-in-out ${i * 0.15}s infinite`,
                  background: 'linear-gradient(90deg, var(--glass-bg-soft) 25%, var(--glass-bg) 50%, var(--glass-bg-soft) 75%)',
                  backgroundSize: '200% 100%',
                }}
              >
                <div style={{ width: '35%', height: 12, borderRadius: 4, background: 'var(--gray-200)' }} />
                <div style={{ width: '70%', height: 12, borderRadius: 4, background: 'var(--gray-200)' }} />
                <div style={{ width: '50%', height: 10, borderRadius: 4, background: 'var(--gray-200)' }} />
              </div>
            ))}
          </div>
        ) : (
          <>
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
              <MessageBubble key={i} message={msg} mode={mode} toolNamesById={toolNamesById} />
            ))}

            {/* Agent Loop 实时工具流（tool_call_started/completed 事件推导的折叠行） */}
            {hasActiveStream && streamState && <ToolCallFeed events={streamState.events} />}

            {/* Agent Loop 委派协作流（delegate_agent 委派的子会话行胶囊，M4-C） */}
            {activeSessionId && <DelegationFeed sessionId={activeSessionId} />}

            {streamingContent && (
              <MessageBubble
                message={{ role: 'assistant', content: [{ type: 'text', text: streamingContent }], timestamp: Date.now() }}
                mode={mode}
                isStreaming
              />
            )}

            {busy && elapsed > 5 && (
              <WaitingFeedback
                elapsedSeconds={elapsed}
                actionLabel={busyActionLabel}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
                {decisionTitle && (
                  <p
                    style={{
                      margin: 0,
                      fontSize: 'var(--font-size-xs)',
                      lineHeight: 1.5,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {decisionTitle}
                  </p>
                )}
                <CardOptions options={cardOptions} onSelect={onCardOptionSelect} disabled={busy} />
              </div>
            )}
          </>
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
            placeholder={busy ? '生成中…可以先把想法打出来，结束后发送' : '描述你的想法…'}
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
          {hasActiveStream ? (
            <button
              onClick={onStopGeneration}
              aria-label="停止生成"
              title="停止生成"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 36,
                height: 36,
                borderRadius: 'var(--radius-full)',
                flexShrink: 0,
                background: 'var(--color-danger)',
                color: 'var(--white)',
                boxShadow: '0 4px 12px -2px rgba(220,38,38,0.45)',
                transition: 'all var(--transition-fast)',
                cursor: 'pointer',
              }}
            >
              <IconStop size={16} />
            </button>
          ) : (
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
          )}
        </div>
        <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-2)', textAlign: 'center' }}>
          按 Enter 发送，按 Shift + Enter 换行
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
  /** tool_use_id → 工具名（回放 tool_result 行用） */
  toolNamesById?: Record<string, string>
}

const userBubbleBg = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? 'linear-gradient(135deg, var(--color-longterm), var(--color-longterm-bright))'
    : 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'

const userBubbleShadow = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? '0 4px 12px -3px rgba(14,116,144,0.35)'
    : '0 4px 12px -3px rgba(124,58,237,0.35)'

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, mode, isStreaming = false, toolNamesById }) => {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')

  // Agent Loop 落盘的轮次：assistant 轮带 tool_use、user 轮只带 tool_result（无文本）
  const hasToolBlocks = message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')

  if (!text && !hasToolBlocks && !isStreaming) return null

  // 纯工具轮（无文本）：居中工具行胶囊，不占用对话气泡（陷阱 26 家族：不污染纯文本流）
  if (!text && hasToolBlocks) {
    return <ToolBlocksReplay blocks={message.content} toolNamesById={toolNamesById} />
  }

  if (isSystem) {
    // [decision] 是内部决策簿记（用户面在文档面板的 decisions.md），不进聊天流
    if (text.startsWith('[decision]')) return null
    // [reconcile] / [decision-card] / [channel-switch] 是机器前缀，剥掉后展示人话
    const display = text.replace(/^\[(?:reconcile|decision-card|channel-switch)\]\s*/, '')
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
        {display}
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
          // user 气泡纯文本保换行；assistant 气泡走 Markdown 渲染（块级元素，pre-wrap 会叠加间距）
          whiteSpace: isUser ? 'pre-wrap' : undefined,
          wordBreak: 'break-word',
        }}
      >
        {/* assistant 旁白/完成总结渲染 Markdown（模型输出天然带 md）；user 输入保持纯文本语义 */}
        {isUser || !text ? text || (isStreaming ? '…' : '') : <Markdown text={text} />}
      </div>
      {hasToolBlocks && <ToolBlocksReplay blocks={message.content} toolNamesById={toolNamesById} />}
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

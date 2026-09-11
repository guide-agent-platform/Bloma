import React from 'react'
import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai'
import { CardOptions } from './CardOptions'
import type { CardOption } from './CardOptions'
import { WaitingFeedback } from './WaitingFeedback'
import { ToolCallRow, deriveToolCallRecords, safeJsonPreview } from './ToolCallBlock'
import { DelegationRow } from './DelegationFeed'
import { ProgressCard, buildProgressLines, countDoneSteps, mapStageToRunSteps } from './ProgressCard'
import type { DelegationView } from '../agent-atoms'
import { ProcessBlockGroup, type ProcessItem } from './ProcessBlockGroup'
import { Markdown } from './Markdown'
import { ArrowUp, MessageSquare, IconAlertTriangle, IconStop } from './icons'
import {
  activeAgentSessionIdAtom,
  agentMessagesFamily,
  agentStreamStateFamily,
  hasActiveStreamAtom,
  globalUserErrorAtom,
  projectModeAtom,
  workflowStageAtom,
  sessionUsageFamily,
  delegationsFamily,
  steerStatusFamily,
} from './atoms'
import type { AgentEvent, AgentMessage, AgentStreamState, PastedImageRef, ProjectMode, SteerStatusChip } from './atoms'
import { collapseRepetitiveText, stripToolMarkupText } from '../stream-collapse'
import { hasUsableChannelsAtom, chatInputDraftAtom, chatInputFocusSignalAtom, chatInputHintAtom } from './atoms-sprint2'
import { extractPastedImages, extFromMime, toBase64DataUrl } from '../lib/paste-extract'

export interface ChatPanelProps {
  /** 向导 Agent 发出的卡片选项（由上层从 AgentEvent 中解析） */
  cardOptions?: CardOption[]
  /** 决策卡标题（U7：让渡偏差描述 / 澄清方向等） */
  decisionTitle?: string
  /** 决策卡正文（2026-08-29：审查卡的具体问题清单） */
  decisionBody?: string
  /** 用户选择卡片选项 */
  onCardOptionSelect?: (option: CardOption) => void
  /** 用户提交文本消息；粘贴图片时附带短引用数组（clipboard-paste P1，2026-08-29） */
  onSendMessage?: (content: string, images?: PastedImageRef[]) => void
  /** 是否正在等待 Agent 响应 */
  isWaiting?: boolean
  /** 等待开始时间（用于计算已等待秒数） */
  waitStartTime?: number
  /** 当前等待阶段的操作描述 */
  waitActionLabel?: string
  /** 超时-继续等待 */
  onContinueWaiting?: () => void
  /** 回访恢复：加载历史消息期间显示骨架占位（sitemap §2.6） */
  isHistoryLoading?: boolean
  /** 停止当前生成（U4：Agent 流式生成中点击停止） */
  onStopGeneration?: () => void
  /** 零渠道引导卡直达按钮（QW#2 二期 P1-①②）：切到设置页，宁可给按钮不给说明书 */
  onOpenSettings?: () => void
  /** P0-2 fork（2026-09-08）：user 消息「从这里重新来」回调（消息含 timestamp/可能含 id） */
  onForkFromMessage?: (message: AgentMessage) => void
}

// 模块级常量：当 activeAgentSessionIdAtom 为 null 时的稳定 fallback atom，
// 避免在 atomFamily 中创建不可回收的 '__unused__' key。
const nullMessagesFallback = atom<AgentMessage[]>([])
const nullStreamFallback = atom<AgentStreamState>({
  running: false,
  events: [],
  content: '',
  thinking: '',
})
const nullDelegationsFallback = atom<DelegationView[]>([])

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
  decisionBody,
  onCardOptionSelect,
  onSendMessage,
  isWaiting = false,
  waitStartTime,
  waitActionLabel = '生成可运行版本',
  onContinueWaiting,
  isHistoryLoading = false,
  onStopGeneration,
  onOpenSettings,
  onForkFromMessage,
}) => {
  const activeSessionId = useAtomValue(activeAgentSessionIdAtom)
  const sessionUsage = useAtomValue(sessionUsageFamily(activeSessionId ?? ''))
  const mode = useAtomValue(projectModeAtom)
  const hasActiveStream = useAtomValue(hasActiveStreamAtom)
  const globalError = useAtomValue(globalUserErrorAtom)
  const workflowStage = useAtomValue(workflowStageAtom)

  /** 忙碌 = 外部等待或本地流式运行中。输入框保持可编辑（草稿），只禁发，不再整体锁死。 */
  const busy = isWaiting || hasActiveStream

  // 进度卡（想法 B，2026-09-08）：点击「查看进度」后从权威阶段与事件流归约过程；会话结束自动收起
  const delegations = useAtomValue(activeSessionId ? delegationsFamily(activeSessionId) : nullDelegationsFallback)
  const [viewingProgress, setViewingProgress] = React.useState(false)
  // 提出新想法引导提示（2026-09-08）：超时态点击按钮后聚焦输入框并提示可排队提交
  const [ideaHint, setIdeaHint] = React.useState(false)
  React.useEffect(() => {
    if (!busy) {
      setViewingProgress(false)
      setIdeaHint(false)
    }
  }, [busy])

  // 提出新想法：收起进度卡 + 聚焦输入框 + 显示排队引导（R-WAIT-04：等待不阻塞继续输入）
  const handleSuggestIdea = React.useCallback(() => {
    setViewingProgress(false)
    setIdeaHint(true)
    inputRef.current?.focus()
  }, [])

  const messages = useAtomValue(
    activeSessionId ? agentMessagesFamily(activeSessionId) : nullMessagesFallback,
  )
  const streamState = useAtomValue(
    activeSessionId ? agentStreamStateFamily(activeSessionId) : nullStreamFallback,
  )

  // WC-P2（2026-08-29）：草稿 atom 化——零渠道提交被拦截直达设置页后，返回工作区输入仍在
  const [inputValue, setInputValue] = useAtom(chatInputDraftAtom)
  const hasChannels = useAtomValue(hasUsableChannelsAtom)
  // clipboard-paste P1（2026-08-29）：待发送粘贴图（短引用 + 内存 dataURL 预览）与降级错误
  const [pendingImages, setPendingImages] = React.useState<Array<PastedImageRef & { dataUrl: string }>>([])
  const [pasteError, setPasteError] = React.useState<string | null>(null)
  const messagesEndRef = React.useRef<HTMLDivElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  // 输入框聚焦信号 + 提示（2026-09-11 三按钮改版）：修改确认卡点「提出意见」后递增，
  // 这里监听并聚焦输入框（「链接到输入框，让用户输入修改需求」）。
  const chatFocusSignal = useAtomValue(chatInputFocusSignalAtom)
  const chatInputHint = useAtomValue(chatInputHintAtom)
  const setChatInputHint = useSetAtom(chatInputHintAtom)
  React.useEffect(() => {
    if (chatFocusSignal > 0) inputRef.current?.focus()
  }, [chatFocusSignal])

  // 过程文本不依赖 running 门控（2026-09-11）：只要本会话有累积内容/思考就展示过程记录卡片——
  // 否则「running 已复位但终态消息尚未落列」的窗口会整卡消失（真机反馈「生成中没收到卡片」）
  const streamingContent = streamState ? streamState.content : ''
  // 思考分离（2026-09-11）：流式思考文本单独渲染为折叠块，不与旁白正文混排
  const streamingThinking = streamState ? streamState.thinking : ''

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
  }, [messages, streamingContent, streamingThinking, cardOptions])

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

  // message-queue UI 收尾（ux-chatpanel-review P1-①，2026-08-28）：busy 时提交的消息由后端
  // 排队兜底，但派发前不在 messages 流里——本地回显灰化「排队中」气泡，确认消息没丢。
  // 出列以「消息真实进流」为派发完成信号；不用 busy→false 兜底清空——run 间隙抖动会
  // 误清尚未派发的气泡（多厂商审查 aliyun fail 点，2026-08-28 加固）。
  const [pendingQueue, setPendingQueue] = React.useState<string[]>([])
  const dispatchedTexts = React.useMemo(() => {
    const set = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'user') continue
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      if (text) set.add(text)
    }
    return set
  }, [messages])
  React.useEffect(() => {
    if (dispatchedTexts.size === 0) return
    setPendingQueue((queue) => queue.filter((t) => !dispatchedTexts.has(t)))
  }, [dispatchedTexts])

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    // clipboard-paste P1（2026-08-29）：粘贴图提取→IPC 存盘→chip；纯文本零干扰（不 preventDefault）
    const result = await extractPastedImages(e.clipboardData?.items ?? null)
    if (!result.shouldPrevent) return
    e.preventDefault()
    if (result.rejected.length > 0) {
      setPasteError(result.rejected[0].reason)
    }
    const api = window.electronAPI
    for (const image of result.images) {
      try {
        const res = await api?.pastedImage?.save({
          request_id: crypto.randomUUID(),
          session_id: activeSessionId ?? 'unattached',
          base64: image.base64,
          ext: extFromMime(image.media_type),
        })
        if (res?.ok && res.data) {
          setPendingImages((prev) => [
            ...prev,
            { imageId: res.data.imageId, media_type: res.data.media_type, dataUrl: toBase64DataUrl(image.base64, image.media_type) },
          ])
        } else {
          setPasteError(res && !res.ok ? '图片保存失败，已改用纯文本发送' : '图片保存失败，已改用纯文本发送')
        }
      } catch {
        setPasteError('图片保存失败，已改用纯文本发送')
      }
    }
  }

  const handleSubmit = () => {
    const trimmed = inputValue.trim()
    if (!trimmed) return
    // WC-P2（2026-08-29）：零渠道提交不裸报错——拦截发送（无渠道 run 必失败），
    // 直达设置页；草稿保留（atom 化），连接成功返回工作区后输入仍在。
    if (hasChannels === false) {
      onOpenSettings?.()
      return
    }
    // message-queue（2026-08-27）：生成期间也允许提交——后端排队兜底（queued:true），
    // 消息不丢、run 完成后自动派发。busy 时发送按钮区被停止按钮替换，靠 Enter 提交。
    if (busy) setPendingQueue((q) => [...q, trimmed])
    // clipboard-paste P1：带图时第二参传短引用数组；无图保持单参调用形态（不传 undefined 占位，
    // 旧 mock/子类对签名兼容性零感知）。发送后清 chip（纯文本路径零变化）。
    const imageRefs: PastedImageRef[] | undefined = pendingImages.length
      ? pendingImages.map(({ imageId, media_type }) => ({ imageId, media_type }))
      : undefined
    if (imageRefs) onSendMessage?.(trimmed, imageRefs)
    else onSendMessage?.(trimmed)
    setPendingImages([])
    setPasteError(null)
    setInputValue('')
    setIdeaHint(false)
    // 「提出意见」提示语用后即清（发送即消费）
    setChatInputHint(null)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const canSend = !busy && inputValue.trim().length > 0

  const handleForkFromMessage = React.useCallback(
    (message: AgentMessage) => {
      onForkFromMessage?.(message)
    },
    [onForkFromMessage],
  )

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
            {messages.length === 0 && !streamingContent && !streamingThinking && !isWaiting && (
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

            {/* 历史回放：相邻的工具轮消息合并成同一个「执行过程」折叠组（对齐 Proma turn 分组） */}
            <HistoryMessages messages={messages} mode={mode} toolNamesById={toolNamesById} onOpenSettings={onOpenSettings} onForkFromMessage={handleForkFromMessage} />

            {/* message-queue UI 收尾（P1-①）：排队中的消息灰化回显，确认不丢 */}
            {pendingQueue.map((text, i) => (
              <div
                key={`queued-${i}-${text}`}
                data-ai-id="queued-message"
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  opacity: 0.55,
                  padding: '0 var(--space-2)',
                }}
              >
                <span
                  style={{
                    fontSize: 'var(--font-size-xs)',
                    color: 'var(--color-text-muted)',
                    border: '1px solid var(--color-border)',
                    borderRadius: '999px',
                    padding: '0 var(--space-2)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  排队中
                </span>
                <span
                  style={{
                    maxWidth: '70%',
                    background: 'var(--color-surface-muted, rgba(127,127,127,0.12))',
                    borderRadius: 'var(--radius-md, 10px)',
                    padding: 'var(--space-2) var(--space-3)',
                    fontSize: 'var(--font-size-sm)',
                    color: 'var(--color-text)',
                    wordBreak: 'break-word',
                  }}
                >
                  {text}
                </span>
              </div>
            ))}

            {/* Agent Loop 执行过程折叠组（工具调用 + 委派，流式展开/结束自动收起） */}
            {streamState && activeSessionId && (
              <LiveProcessGroup events={streamState.events} sessionId={activeSessionId} isStreaming={hasActiveStream} />
            )}

            {/* 生成中的旁白/思考也收进过程记录卡片（默认收起，只留一行「生成中…」）
              ——现场不展示专业性过程文本，可手动展开查看 */}
            {(streamingContent || streamingThinking) && (
              <LiveProcessRecord text={streamingContent} thinkingText={streamingThinking} />
            )}

            {busy && elapsed > 5 && (
              <WaitingFeedback
                elapsedSeconds={elapsed}
                actionLabel={busyActionLabel}
                onContinueWaiting={() => {
                  // 「继续等待」重置计时回到非超时态：同步收起进度卡，避免停在无按钮状态
                  setViewingProgress(false)
                  onContinueWaiting?.()
                }}
                onViewProgress={() => setViewingProgress((previous) => !previous)}
                viewingProgress={viewingProgress}
                onSuggestIdea={handleSuggestIdea}
              />
            )}

            {viewingProgress && busy && streamState && activeSessionId && (
              <ProgressCard
                stageLabel={busyActionLabel}
                steps={mapStageToRunSteps(workflowStage) ?? []}
                lines={buildProgressLines(streamState.events, delegations)}
                doneSteps={countDoneSteps(streamState.events, delegations)}
                onClose={() => setViewingProgress(false)}
                onSuggestIdea={handleSuggestIdea}
                onStopGeneration={onStopGeneration}
              />
            )}

            {ideaHint && busy && (
              <div
                data-ai-id="idea-hint"
                role="note"
                style={{
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-muted)',
                  padding: 'var(--space-3) var(--space-4)',
                  background: 'var(--glass-bg-soft)',
                  border: '1px dashed var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  maxWidth: 420,
                }}
              >
                ✍️ 有新想法？直接写在下面按 Enter 发送，会排队等这一轮完成后一起处理。
              </div>
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
                {decisionBody && (
                  <div
                    data-ai-id="decision-card-body"
                    style={{
                      margin: 0,
                      padding: '8px 12px',
                      fontSize: 'var(--font-size-xs)',
                      lineHeight: 1.6,
                      color: 'var(--color-text-secondary, #5b6472)',
                      background: 'var(--color-bg-subtle, #f6f8fb)',
                      borderRadius: 'var(--radius-sm)',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      maxHeight: 180,
                      overflowY: 'auto',
                    }}
                  >
                    {decisionBody}
                  </div>
                )}
                <CardOptions options={cardOptions} onSelect={onCardOptionSelect} disabled={busy} />
              </div>
            )}
          </>
        )}

        {activeSessionId && <SteerStatusBar sessionId={activeSessionId} onStopGeneration={onStopGeneration} />}

        <div ref={messagesEndRef} />
      </div>

      {/* 输入区（胶囊） */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', flexShrink: 0, borderTop: '1px solid var(--color-border)' }}>
        {/* clipboard-paste P1（2026-08-29）：待发送图片 chip 行——缩略预览（内存 dataURL）+ 移除；存图失败降级提示 */}
        {(pendingImages.length > 0 || pasteError) && (
          <div
            style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center', marginBottom: 'var(--space-2)' }}
          >
            {pendingImages.map((img, i) => (
              <span
                key={img.imageId}
                data-ai-id="paste-image-chip"
                title={`图片 ${i + 1}（${img.media_type}）`}
                style={{
                  position: 'relative',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 'var(--space-1)',
                  padding: 'var(--space-1) var(--space-2) var(--space-1) var(--space-1)',
                  borderRadius: 'var(--radius-full)',
                  border: '1px solid var(--color-border)',
                  background: 'var(--glass-bg-soft)',
                  fontSize: 'var(--font-size-xs)',
                  color: 'var(--color-text-muted)',
                }}
              >
                <img
                  data-ai-id="paste-image-thumb"
                  src={img.dataUrl}
                  alt={`粘贴图片 ${i + 1}`}
                  style={{ width: 24, height: 24, borderRadius: 'var(--radius-full)', objectFit: 'cover' }}
                />
                图片{i + 1}
                <button
                  onClick={() => setPendingImages((prev) => prev.filter((p) => p.imageId !== img.imageId))}
                  aria-label={`移除图片 ${i + 1}`}
                  style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--color-text-muted)', padding: '0 2px' }}
                >
                  ×
                </button>
              </span>
            ))}
            {pasteError && (
              <span data-ai-id="paste-image-error" style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-danger)' }}>
                {pasteError}
              </span>
            )}
          </div>
        )}
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
            onPaste={handlePaste}
            placeholder={
              chatInputHint ??
              (busy
                ? '生成中…可以继续输入，会自动排队处理'
                : hasChannels === false
                  ? '还没有连接 AI 模型——发送任意内容，直达设置页完成连接'
                  : '描述你的想法…')
            }
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
              aria-label="停止本轮制作"
              title="停止本轮制作（已确认的需求与已交付版本会保留）"
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
        {sessionUsage && (
          <p
            data-ai-id="session-usage-hint"
            style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', textAlign: 'center', margin: '0 auto' }}
          >
            {`本会话已用 ≈${(sessionUsage.inputTokens + sessionUsage.outputTokens).toLocaleString()} tokens${sessionUsage.turnsWithUsage === 0 ? '（估算）' : ''}`}
          </p>
        )}
      </div>
    </div>
  )
}

/* =========================================================================
   执行过程折叠组 — 辅助组件与归一化
   ========================================================================= */

/** 旁白行：折叠组内的过程说明文本（弱化显示）。 */
const NarrationRow: React.FC<{ text: string }> = ({ text }) => (
  <div
    data-ai-id="process-narration"
    style={{
      fontSize: 'var(--font-size-xs)',
      lineHeight: 1.6,
      color: 'var(--color-text-muted)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}
  >
    {collapseRepetitiveText(stripToolMarkupText(text))}
  </div>
)

/** 实时流：从事件流（工具） + 委派视图归约出过程项。 */
const LiveProcessGroup: React.FC<{ events: AgentEvent[]; sessionId: string; isStreaming: boolean }> = ({ events, sessionId, isStreaming }) => {
  const delegations = useAtomValue(delegationsFamily(sessionId))
  const items = React.useMemo<ProcessItem[]>(() => {
    const toolItems: ProcessItem[] = deriveToolCallRecords(events).map((record) => ({
      kind: 'tool',
      key: record.key,
      tool: record.tool,
      inputSummary: record.inputSummary,
      outputSummary: record.outputSummary,
      status: record.status,
      durationMs: record.durationMs,
    }))
    const delegationItems: ProcessItem[] = delegations.map((item) => ({
      kind: 'delegation',
      key: item.delegation_id,
      item,
    }))
    return [...toolItems, ...delegationItems]
  }, [events, delegations])

  if (items.length === 0) return null
  return (
    <ProcessBlockGroup
      items={items}
      isStreaming={isStreaming}
      renderItem={(item) =>
        item.kind === 'tool' ? (
          <ToolCallRow
            tool={item.tool}
            inputSummary={item.inputSummary}
            outputSummary={item.outputSummary}
            status={item.status}
            durationMs={item.durationMs}
          />
        ) : item.kind === 'delegation' ? (
          <DelegationRow item={item.item} />
        ) : (
          <NarrationRow text={item.text} />
        )
      }
    />
  )
}

/** 历史回放：把单条消息的 tool_use / tool_result / 旁白 text 归约成过程项。 */
function deriveMessageProcessItems(message: AgentMessage, toolNamesById: Record<string, string>): ProcessItem[] {
  const items: ProcessItem[] = []
  const narration = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  if (narration.trim()) {
    items.push({ kind: 'narration', key: 'narration', text: narration })
  }
  message.content.forEach((block, index) => {
    if (block.type === 'tool_use') {
      items.push({
        kind: 'tool',
        key: `use-${block.id ?? index}`,
        tool: block.name ?? '',
        inputSummary: safeJsonPreview(block.input),
        status: 'ok',
        replay: true,
      })
    }
    if (block.type === 'tool_result') {
      items.push({
        kind: 'tool',
        key: `result-${block.tool_use_id ?? index}`,
        tool: toolNamesById[block.tool_use_id ?? ''] ?? 'tool_result',
        inputSummary: typeof block.content === 'string' ? block.content : '',
        status: block.is_error ? 'error' : 'ok',
        replay: true,
      })
    }
  })
  return items
}

/** 渲染单个过程项（tool / delegation / narration 行）。 */
function renderProcessItem(item: ProcessItem): React.ReactNode {
  if (item.kind === 'tool') {
    return (
      <ToolCallRow
        tool={item.tool}
        inputSummary={item.inputSummary}
        outputSummary={item.outputSummary}
        status={item.status}
        durationMs={item.durationMs}
        replay
      />
    )
  }
  if (item.kind === 'delegation') return <DelegationRow item={item.item} />
  return <NarrationRow text={item.text} />
}

/**
 * 历史回放：把相邻的工具轮消息（一次 Agent Loop 的 assistant(tool_use) + user(tool_result)）
 * 合并成一个「执行过程」折叠组（对齐 Proma 的 turn 分组），不再每条消息拆一个折叠组。
 * 用户输入 / 纯文本正文 / system 消息保持独立渲染。
 */
const HistoryMessages: React.FC<{
  messages: AgentMessage[]
  mode: ProjectMode | null
  toolNamesById: Record<string, string>
  onOpenSettings?: () => void
  onForkFromMessage?: (message: AgentMessage) => void
}> = ({ messages, mode, toolNamesById, onOpenSettings, onForkFromMessage }) => {
  const nodes: React.ReactNode[] = []
  let buffer: AgentMessage[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    const buffered = buffer
    buffer = []
    const processItems = buffered.flatMap((message) => deriveMessageProcessItems(message, toolNamesById))
    if (processItems.length === 0) {
      // 无有效过程项 → 退回逐条渲染（MessageBubble 内部兜底）
      buffered.forEach((message, index) => {
        nodes.push(
          <MessageBubble key={`fallback-${index}`} message={message} mode={mode} toolNamesById={toolNamesById} onOpenSettings={onOpenSettings} onForkFromMessage={onForkFromMessage} />,
        )
      })
      return
    }
    nodes.push(
      <ProcessBlockGroup
        key={`process-${nodes.length}`}
        items={processItems}
        isStreaming={false}
        renderItem={renderProcessItem}
      />,
    )
  }
  messages.forEach((message, index) => {
    const isUserInput =
      message.role === 'user' && message.content.some((block) => block.type === 'text' && !!block.text?.trim())
    const hasTool = message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
    if (!isUserInput && hasTool) {
      buffer.push(message)
      return
    }
    flush()
    nodes.push(
      <MessageBubble key={index} message={message} mode={mode} toolNamesById={toolNamesById} onOpenSettings={onOpenSettings} onForkFromMessage={onForkFromMessage} />,
    )
  })
  flush()
  return <>{nodes}</>
}

/* =========================================================================
   SteerStatusBar（I3 转向生效确认链，P7-7，2026-09-11）
   ========================================================================= */

interface SteerStatusBarProps {
  sessionId: string
  /** 高档「停止本轮制作」回调（App 层接 agent:stop；复用 I4 停止承接话术） */
  onStopGeneration?: () => void
}

/** 状态文案与配色（「这轮会做吗」的答案——与主进程账本状态一致，不由对话层宣布）。 */
const STEER_STATUS_VIEW: Record<SteerStatusChip['status'], { label: string; dot: string; bg: string }> = {
  received: { label: '已收到·将纳入本轮', dot: '#3b82f6', bg: '#eff6ff' },
  pending_impact: { label: '待你确认', dot: '#f59e0b', bg: '#fffbeb' },
  merged_this_run: { label: '已纳入本轮', dot: '#10b981', bg: '#ecfdf5' },
  deferred_next_run: { label: '留待下一轮', dot: '#94a3b8', bg: '#f8fafc' },
  rejected: { label: '未采用', dot: '#9ca3af', bg: '#f3f4f6' },
}

const steerSummary = (content: string): string => (content.length > 40 ? `${content.slice(0, 40)}…` : content)

const SteerActionButton: React.FC<{ label: string; primary?: boolean; disabled?: boolean; onClick: () => void; 'data-ai-id'?: string }> = ({ label, primary, disabled, onClick, ...rest }) => (
  <button
    type="button"
    {...rest}
    disabled={disabled}
    onClick={onClick}
    style={{
      padding: '4px 10px',
      fontSize: 'var(--font-size-xs)',
      borderRadius: 'var(--radius-sm)',
      border: '1px solid ' + (primary ? 'var(--color-quick, #7c3aed)' : 'var(--color-border)'),
      background: primary ? 'var(--color-quick, #7c3aed)' : 'var(--white)',
      color: primary ? '#fff' : 'var(--color-text)',
      cursor: disabled ? 'default' : 'pointer',
      opacity: disabled ? 0.6 : 1,
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </button>
)

/** 聊天流内嵌轻量状态条：用户生成中补充的每条 steer 一行，随主进程状态机如实翻转。
 *  中档三选[本轮就改/本轮完成后再改/不改了]；高档 v0 建议「停止本轮」承接（§8 拍板），
 *  保留「仍要本轮注入」降档出口。仅 BLOMA_STEER_CONFIRM=on 时主进程发 steer_status
 *  事件驱动本组件——off 时 chips 恒空零渲染（字节级现状）。 */
const SteerStatusBar: React.FC<SteerStatusBarProps> = ({ sessionId, onStopGeneration }) => {
  const chips = useAtomValue(steerStatusFamily(sessionId))
  const [resolving, setResolving] = React.useState<string | null>(null)

  // 刷新/重挂后回填：主进程账本是权威答案源（steer_status 事件只推增量），
  // 挂载时查询一次恢复状态条（同 steer_id 以主进程状态覆盖，upsert 语义在 set 内保证）。
  React.useEffect(() => {
    const api = window.electronAPI?.agent
    if (!api?.steerQuery) return
    void api.steerQuery({ request_id: crypto.randomUUID(), session_id: sessionId }).then((result) => {
      if (!result?.ok || result.data.items.length === 0) return
      const store = window.__jotai_store__
      if (!store) return
      store.set(steerStatusFamily(sessionId), (previous) => {
        const byId = new Map(previous.map((chip) => [chip.steerId, chip]))
        for (const item of result.data.items) {
          const existing = byId.get(item.steer_id)
          // 主进程状态为准回填；本地更新的 updatedAt 不回退
          if (!existing || existing.updatedAt <= item.updated_at) {
            byId.set(item.steer_id, {
              steerId: item.steer_id,
              content: item.content,
              impact: item.impact,
              status: item.status,
              updatedAt: item.updated_at,
            })
          }
        }
        return [...byId.values()].sort((a, b) => a.updatedAt - b.updatedAt)
      })
    })
  }, [sessionId])

  const resolve = React.useCallback((steerId: string, action: 'inject_now' | 'defer' | 'reject') => {
    const api = window.electronAPI?.agent
    if (!api?.steerResolve) return
    setResolving(steerId)
    void api.steerResolve({ request_id: crypto.randomUUID(), session_id: sessionId, steer_id: steerId, action })
      .then(() => setResolving(null))
      .catch(() => setResolving(null)) // 状态推进由 steer_status 事件驱动；失败静默不重试（按钮可重点）
  }, [sessionId])

  if (chips.length === 0) return null
  return (
    <div
      data-ai-id="steer-status-bar"
      role="status"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flexShrink: 0 }}
    >
      {chips.map((chip) => {
        const view = STEER_STATUS_VIEW[chip.status] ?? STEER_STATUS_VIEW.rejected
        const pending = chip.status === 'pending_impact'
        const busy = resolving === chip.steerId
        return (
          <div
            key={chip.steerId}
            data-ai-id="steer-status-chip"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
              background: view.bg,
              border: '1px solid var(--color-border)',
              fontSize: 'var(--font-size-xs)',
              color: 'var(--color-text)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: view.dot, flexShrink: 0 }} />
              <span style={{ fontWeight: 600 }}>{view.label}</span>
              <span style={{ color: 'var(--color-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {steerSummary(chip.content)}
              </span>
            </div>
            {pending && chip.impact === 'medium' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>这条补充会改动功能或流程，这轮要怎么处理？</span>
                <SteerActionButton data-ai-id="steer-inject-now" primary label={busy ? '处理中…' : '本轮就改'} disabled={busy} onClick={() => resolve(chip.steerId, 'inject_now')} />
                <SteerActionButton data-ai-id="steer-defer" label="本轮完成后再改" disabled={busy} onClick={() => resolve(chip.steerId, 'defer')} />
                <SteerActionButton data-ai-id="steer-reject" label="不改了" disabled={busy} onClick={() => resolve(chip.steerId, 'reject')} />
              </div>
            )}
            {pending && chip.impact === 'high' && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                <span style={{ color: 'var(--color-text-muted)' }}>这个修改涉及核心目标或数据结构，建议停止本轮后按新需求重新安排。</span>
                {onStopGeneration && (
                  <SteerActionButton data-ai-id="steer-stop-run" primary label="停止本轮制作" onClick={onStopGeneration} />
                )}
                <SteerActionButton data-ai-id="steer-force-inject" label={busy ? '处理中…' : '仍要本轮注入'} disabled={busy} onClick={() => resolve(chip.steerId, 'inject_now')} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

/* =========================================================================
   MessageBubble
   ========================================================================= */

/* =========================================================================
   ThinkingBlock — 思考过程折叠块（2026-09-11 交付话术改造）
   Proma ContentBlock ThinkingBlock 口径：默认折叠、虚线边框、「思考过程」标签；
   流式中显示脉冲点；展开/收起可往复。与回复气泡视觉区分（虚线 + 淡底 + 小字号）。
   ========================================================================= */
const ThinkingBlock: React.FC<{ text: string; streaming?: boolean }> = ({ text, streaming = false }) => {
  const [expanded, setExpanded] = React.useState(false)
  if (!text.trim()) return null
  return (
    <div
      data-ai-id="thinking-block"
      style={{
        width: '100%',
        margin: '0 0 var(--space-2)',
        border: '1px dashed var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--glass-bg-soft)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        title={expanded ? '收起思考过程' : '展开思考过程'}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '4px 10px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          textAlign: 'left',
        }}
      >
        <span>{expanded ? '▾' : '▸'}</span>
        <span>思考过程{streaming ? '…' : ''}</span>
        {streaming && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: 'var(--color-quick, #7c3aed)',
              animation: 'pulse 1.2s ease-in-out infinite',
            }}
          />
        )}
        {!streaming && !expanded && <span style={{ opacity: 0.7 }}>已收起</span>}
      </button>
      {expanded && (
        <div
          style={{
            maxHeight: 220,
            overflowY: 'auto',
            padding: '2px 10px 8px',
            fontSize: 'var(--font-size-xs)',
            lineHeight: 1.6,
            color: 'var(--color-text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {collapseRepetitiveText(stripToolMarkupText(text))}
        </div>
      )}
    </div>
  )
}

/* =========================================================================
   ProcessRecordBubble — 过程记录卡片（2026-09-11）
   流水线 run 沉淀的旁白/思考（如「需求已确认，正在内审这份 PRD」）折叠于此，
   与回复气泡视觉区分：虚线边框 + 淡底 + 小字号；展开/收起可往复。
   ========================================================================= */
const ProcessRecordBubble: React.FC<{
  thinkingText: string
  text: string
  expanded: boolean
  onToggle: () => void
  /** 生成中：头部显示脉冲点 + 「生成中…」（内容随流式更新，仍可展开） */
  streaming?: boolean
}> = ({ thinkingText, text, expanded, onToggle, streaming = false }) => (
  <div
    data-ai-id="process-record"
    style={{
      alignSelf: 'flex-start',
      maxWidth: '84%',
      border: '1px dashed var(--color-border)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--glass-bg-soft)',
      overflow: 'hidden',
      animation: 'tile-enter 0.3s ease both',
    }}
  >
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      title={expanded ? '收起过程记录' : '展开过程记录'}      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        padding: '6px var(--space-4)',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 'var(--font-size-xs)',
        color: 'var(--color-text-muted)',
        textAlign: 'left',
      }}
    >
      <span>{expanded ? '▾' : '▸'}</span>
      <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>过程记录</span>
      {streaming && (
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: 'var(--color-quick, #7c3aed)',
            animation: 'pulse 1.2s ease-in-out infinite',
          }}
        />
      )}
      <span style={{ marginLeft: 'auto', opacity: 0.7 }}>{streaming ? '生成中…' : expanded ? '点击收起' : '点击展开'}</span>
    </button>
    {expanded && (
      <div style={{ padding: '0 var(--space-4) var(--space-3)', borderTop: '1px dashed var(--color-border)' }}>
        {thinkingText && (
          <div style={{ marginTop: 'var(--space-2)' }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', opacity: 0.85, marginBottom: 4 }}>
              思考过程
            </div>
            <div
              style={{
                fontSize: 'var(--font-size-xs)',
                lineHeight: 1.6,
                color: 'var(--color-text-muted)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {collapseRepetitiveText(stripToolMarkupText(thinkingText))}
            </div>
          </div>
        )}
        {text && (
          <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--font-size-xs)', lineHeight: 1.6, color: 'var(--color-text-muted)' }}>
            <Markdown text={stripToolMarkupText(text)} />
          </div>
        )}
      </div>
    )}
  </div>
)

/** 生成中的过程记录（自持展开态）：内容随流式更新，默认收起，可随时展开查看。 */
const LiveProcessRecord: React.FC<{ text: string; thinkingText: string }> = ({ text, thinkingText }) => {
  const [expanded, setExpanded] = React.useState(false)
  return (
    <ProcessRecordBubble
      thinkingText={thinkingText}
      text={text}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      streaming
    />
  )
}

interface MessageBubbleProps {
  message: AgentMessage
  mode: ProjectMode | null
  isStreaming?: boolean
  /** tool_use_id → 工具名（回放 tool_result 行用） */
  toolNamesById?: Record<string, string>
  /** 零渠道引导卡直达按钮回调（QW#2 二期） */
  onOpenSettings?: () => void
  /** P0-2 fork（2026-09-08）：user 气泡「从这里重新来」入口——父层接 IPC + 会话续接 */
  onForkFromMessage?: (message: AgentMessage) => void
}

const userBubbleBg = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? 'linear-gradient(135deg, var(--color-longterm), var(--color-longterm-bright))'
    : 'linear-gradient(135deg, var(--color-quick), var(--color-quick-bright))'

const userBubbleShadow = (mode: ProjectMode | null): string =>
  mode === 'longterm'
    ? '0 4px 12px -3px rgba(14,116,144,0.35)'
    : '0 4px 12px -3px rgba(124,58,237,0.35)'

const MessageBubble: React.FC<MessageBubbleProps> = ({ message, mode, isStreaming = false, toolNamesById, onOpenSettings, onForkFromMessage }) => {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  // 过程记录（2026-09-11）：流水线 run 沉淀的旁白/思考，或交付时的过程沉淀。
  // 渲染为可往复折叠的「过程记录」卡片（与回复气泡视觉区分）；展开后仍可收起。
  const [recordExpanded, setRecordExpanded] = React.useState(false)

  const rawText = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('')
  // 退行重复折叠（2026-09-04「查。」墙案）：显示层折叠，落盘/回放数据保留原始；
  // system 前缀行（[decision]/[queue-dropped] 等按前缀分流）不折叠
  // 显示层清洗（2026-09-11）：DSML 等工具协议残片先进折叠（防 React-Markdown 剥 HTML 后渲染成空），再退行折叠
  const text = isSystem ? rawText : collapseRepetitiveText(stripToolMarkupText(rawText))

  // 思考分离（2026-09-11）：thinking 块单独折叠展示，不与旁白正文混排
  const thinkingText = message.content
    .filter((block) => block.type === 'thinking')
    .map((block) => (typeof block.thinking === 'string' ? block.thinking : ''))
    .filter(Boolean)
    .join('\n\n')
  const isProcessRecord = !isUser && !isSystem && message.process_record === true

  // Agent Loop 落盘的轮次：assistant 轮带 tool_use、user 轮只带 tool_result（无文本）
  const hasToolBlocks = message.content.some((block) => block.type === 'tool_use' || block.type === 'tool_result')
  // clipboard-paste P1（2026-08-29）：粘贴图片块——气泡内 chip 标注（缩略图回放 P2）
  const imageBlocks = message.content.filter((block) => block.type === 'image')

  if (!text && !hasToolBlocks && imageBlocks.length === 0 && !thinkingText && !isStreaming) return null

  // 过程记录卡片（与回复气泡视觉区分：虚线边框 + 淡底 + 小字号；展开/收起可往复）
  if (isProcessRecord) {
    return (
      <ProcessRecordBubble
        thinkingText={thinkingText}
        text={text}
        expanded={recordExpanded}
        onToggle={() => setRecordExpanded((v) => !v)}
      />
    )
  }

  // 含工具块的消息（assistant 的 tool_use / user 的 tool_result + 旁白）：
  // 折叠进「执行过程」组，不占正文气泡（陷阱 26 家族：不污染纯文本流）
  if (hasToolBlocks) {
    const processItems = deriveMessageProcessItems(message, toolNamesById ?? {})
    if (processItems.length === 0) return null
    return (
      <ProcessBlockGroup
        items={processItems}
        isStreaming={false}
        renderItem={(item) =>
          item.kind === 'tool' ? (
            <ToolCallRow
              tool={item.tool}
              inputSummary={item.inputSummary}
              outputSummary={item.outputSummary}
              status={item.status}
              durationMs={item.durationMs}
              replay
            />
          ) : item.kind === 'delegation' ? (
            <DelegationRow item={item.item} />
          ) : (
            <NarrationRow text={item.text} />
          )
        }
      />
    )
  }

  if (isSystem) {
    // [decision] 是内部决策簿记（用户面在文档面板的 decisions.md），不进聊天流
    if (text.startsWith('[decision]')) return null
    // [queue-dropped]（onDropped 气泡，r79）：安全网放弃派发 → 红泡告知发送失败
    if (text.startsWith('[queue-dropped]')) {
      return (
        <div
          data-ai-id="queue-dropped"
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            padding: 'var(--space-2) var(--space-4)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--font-size-sm)',
            fontWeight: 500,
            color: '#991B1B',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
          }}
        >
          <IconAlertTriangle size={14} />
          {text.replace(/^\[queue-dropped\]\s*/, '')}
        </div>
      )
    }
    // [welcome-hint] 零渠道引导（QW#2 二期 P1-①，2026-08-28）：专属醒目卡片——正常字号 +
    // 品牌色左边框 + 内嵌直达按钮。不再与 [channel-switch] 等机器簿记共用弱样式胶囊
    //（首跑最关键的第一条提示曾是全场视觉最弱元素，font-size-xs + text-muted）。
    const welcomeDone = text.startsWith('[welcome-hint:done]')
    if (text.startsWith('[welcome-hint]') || welcomeDone) {
      // done 变体（P2-④）：绿色左边框、不带直达按钮——反馈语义不再指路
      const hint = text.replace(/^\[welcome-hint(?::done)?\]\s*/, '')
      return (
        <div
          style={{
            alignSelf: 'center',
            maxWidth: '92%',
            width: 'fit-content',
            padding: 'var(--space-4)',
            background: 'var(--glass-bg-soft)',
            borderLeft: welcomeDone ? '3px solid #10b981' : '3px solid var(--color-quick, #7c3aed)',
            borderRadius: 'var(--radius-md)',
            fontSize: 'var(--font-size-sm)',
            color: 'var(--color-text)',
            animation: 'tile-enter 0.3s ease both',
          }}
        >
          <div>{hint}</div>
          {onOpenSettings && !welcomeDone && (
            <button
              type="button"
              onClick={onOpenSettings}
              style={{
                marginTop: 'var(--space-3)',
                padding: 'var(--space-2) var(--space-4)',
                background: 'linear-gradient(135deg, var(--color-quick, #7c3aed), var(--color-quick-bright, #9f67ff))',
                color: 'var(--white, #fff)',
                border: 'none',
                borderRadius: 'var(--radius-full)',
                fontSize: 'var(--font-size-sm)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ⚙️ 去连接 AI 模型
            </button>
          )}
          <p style={{ fontSize: 'var(--font-size-xs)', color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
            也可以随时点右上角 ⚙️
          </p>
        </div>
      )
    }
    // [reconcile] / [decision-card] / [channel-switch] / [steer-deferred] 是机器前缀，剥掉后展示人话
    const display = text.replace(/^\[(?:reconcile|decision-card|channel-switch|steer-deferred)\]\s*/, '')
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
        {/* 思考过程折叠块（2026-09-11）：不与旁白正文混排，默认收起 */}
        {!isUser && thinkingText && <ThinkingBlock text={thinkingText} streaming={isStreaming} />}
        {/* assistant 旁白/完成总结渲染 Markdown（模型输出天然带 md）；user 输入保持纯文本语义 */}
        {isUser || !text ? text || (isStreaming ? '…' : '') : <Markdown text={text} />}
        {imageBlocks.length > 0 && (
          <span
            data-ai-id="message-image-chip"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginLeft: 'var(--space-2)',
              padding: '1px 8px',
              borderRadius: 'var(--radius-full)',
              background: 'rgba(255,255,255,0.25)',
              fontSize: 'var(--font-size-xs)',
            }}
          >
            🖼️ 图片 ×{imageBlocks.length}
          </span>
        )}
        {/* F4（r82）：复制入口——0 基础对照 Claude/GPT 基线；clipboard 可选链防御（非安全上下文降级） */}
        {text && (
          <button
            onClick={() => {
              void navigator.clipboard?.writeText(text).catch(() => undefined)
            }}
            aria-label="复制"
            title="复制"
            style={{
              marginTop: 'var(--space-2)',
              alignSelf: 'flex-end',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              fontSize: 'var(--font-size-xs)',
              color: isUser ? 'rgba(255,255,255,0.8)' : 'var(--color-text-muted)',
              padding: '2px 6px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            复制
          </button>
        )}
      </div>
      {/* P0-2 fork（2026-09-08）：user 气泡的「从这里重新来」入口——走错方向时从这条
          user 消息重开（复制此前对话到新会话，原会话保留）；走历史回放也可见 */}
      {isUser && text && onForkFromMessage && (
        <button
          type="button"
          onClick={() => onForkFromMessage(message)}
          aria-label="从这里重新来"
          title="把对话回退到这条消息，从这里继续（原对话保留）"
          style={{
            marginTop: 'var(--space-1)',
            alignSelf: 'flex-end',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'var(--font-size-xs)',
            color: isUser ? 'rgba(255,255,255,0.75)' : 'var(--color-text-muted)',
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            opacity: 0.75,
          }}
        >
          ↪ 从这里重新来
        </button>
      )}
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

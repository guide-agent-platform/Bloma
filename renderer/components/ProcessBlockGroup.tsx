import React from 'react'
import type { ToolCallStatus } from './ToolCallBlock'
import type { DelegationView } from '../agent-atoms'
import { ArrowRight } from './icons'

/**
 * ProcessBlockGroup — 对话流「执行过程」折叠组
 *
 * 移植自 Proma 母体 apps/electron/src/renderer/components/agent/ProcessBlockGroup.tsx，
 * 适配 Bloma 的内联样式 + CSS 变量 + Jotai（不引入 Tailwind / lucide-react）。
 *
 * 职责：把一次回复里的「过程噪音」（工具调用、委派子会话、旁白等）收进一个
 * 可滚动、可展开/收起的小框，只保留正式答复作为正文气泡。
 *
 * 折叠行为（照抄 Proma）：
 * - 流式中：默认展开，自动跟底滚动（viewport maxHeight 320px）。
 * - 流式结束：900ms 后 3s 倒计时，倒计时结束自动收起（除非用户手动切换过）。
 * - 历史回放（初始非流式）：默认收起。
 */

const VIEWPORT_HEIGHT = 320
const COLLAPSE_DURATION_MS = 500
const AUTO_COLLAPSE_SOUND_DELAY_MS = 900
const AUTO_COLLAPSE_COUNTDOWN_SECONDS = 3
const FOLLOW_BOTTOM_THRESHOLD = 24

export type ProcessItem =
  | {
      kind: 'tool'
      key: string
      tool: string
      inputSummary?: string
      outputSummary?: string
      status: ToolCallStatus
      durationMs?: number
      replay?: boolean
    }
  | { kind: 'delegation'; key: string; item: DelegationView }
  | { kind: 'narration'; key: string; text: string }

export function buildProcessGroupSummary(items: ProcessItem[]): string {
  let steps = 0
  for (const item of items) {
    if (item.kind === 'tool' || item.kind === 'delegation') steps += 1
  }
  return `已完成 ${steps} 步`
}

export interface ProcessBlockGroupProps {
  items: ProcessItem[]
  isStreaming: boolean
  renderItem: (item: ProcessItem) => React.ReactNode
  summary?: string
}

type DisplayMode = 'collapsed' | 'expanded'

function isViewportAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_BOTTOM_THRESHOLD
}

export const ProcessBlockGroup: React.FC<ProcessBlockGroupProps> = ({ items, isStreaming, renderItem, summary }) => {
  const initialMode: DisplayMode = !isStreaming ? 'collapsed' : 'expanded'
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>(initialMode)
  const [shouldRenderContent, setShouldRenderContent] = React.useState(initialMode !== 'collapsed')
  const [collapseCountdown, setCollapseCountdown] = React.useState<number | null>(null)
  const userToggledRef = React.useRef(false)
  const followLatestRef = React.useRef(true)
  const smoothScrollTargetRef = React.useRef<number | null>(null)
  const scrollFrameRef = React.useRef<number | null>(null)
  const wasStreamingRef = React.useRef(!!isStreaming)
  const autoCollapseTimersRef = React.useRef<number[]>([])
  const contentRef = React.useRef<HTMLDivElement>(null)
  const contentInnerRef = React.useRef<HTMLDivElement>(null)
  const collapseFrameRef = React.useRef<number | null>(null)
  const [measuredHeight, setMeasuredHeight] = React.useState<number | undefined>(undefined)

  const isContentExpanded = displayMode === 'expanded'

  const clearAutoCollapseTimers = React.useCallback(() => {
    for (const timer of autoCollapseTimersRef.current) window.clearTimeout(timer)
    autoCollapseTimersRef.current = []
  }, [])

  React.useEffect(() => {
    clearAutoCollapseTimers()

    if (isStreaming) {
      setCollapseCountdown(null)
      if (!wasStreamingRef.current) {
        userToggledRef.current = false
        followLatestRef.current = true
        smoothScrollTargetRef.current = null
        if (scrollFrameRef.current !== null) {
          cancelAnimationFrame(scrollFrameRef.current)
          scrollFrameRef.current = null
        }
      }
      if (!userToggledRef.current) setDisplayMode('expanded')
      wasStreamingRef.current = true
      return
    }

    const shouldAutoCollapseAfterCompletion = wasStreamingRef.current && !userToggledRef.current
    wasStreamingRef.current = false

    if (!shouldAutoCollapseAfterCompletion) {
      if (!userToggledRef.current) setDisplayMode('collapsed')
      return
    }

    const soundDelayTimer = window.setTimeout(() => {
      setCollapseCountdown(AUTO_COLLAPSE_COUNTDOWN_SECONDS)
      for (let second = AUTO_COLLAPSE_COUNTDOWN_SECONDS - 1; second >= 1; second--) {
        const elapsed = (AUTO_COLLAPSE_COUNTDOWN_SECONDS - second) * 1000
        autoCollapseTimersRef.current.push(window.setTimeout(() => setCollapseCountdown(second), elapsed))
      }
      autoCollapseTimersRef.current.push(
        window.setTimeout(() => {
          setCollapseCountdown(null)
          setDisplayMode('collapsed')
        }, AUTO_COLLAPSE_COUNTDOWN_SECONDS * 1000),
      )
    }, AUTO_COLLAPSE_SOUND_DELAY_MS)
    autoCollapseTimersRef.current.push(soundDelayTimer)

    return clearAutoCollapseTimers
  }, [clearAutoCollapseTimers, isStreaming])

  const scrollToLatest = React.useCallback(() => {
    if (!followLatestRef.current) return
    const viewport = contentRef.current
    if (!viewport) return

    smoothScrollTargetRef.current = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    if (scrollFrameRef.current !== null) return

    const advanceScroll = (): void => {
      const target = smoothScrollTargetRef.current
      const activeViewport = contentRef.current
      if (!followLatestRef.current || target == null || !activeViewport) {
        scrollFrameRef.current = null
        return
      }
      const distance = target - activeViewport.scrollTop
      if (Math.abs(distance) <= 1) {
        activeViewport.scrollTop = target
        smoothScrollTargetRef.current = null
        scrollFrameRef.current = null
        return
      }
      const nextTop = distance > 72 ? target - 48 : activeViewport.scrollTop + distance * 0.32
      activeViewport.scrollTop = nextTop
      scrollFrameRef.current = requestAnimationFrame(advanceScroll)
    }

    scrollFrameRef.current = requestAnimationFrame(advanceScroll)
  }, [])

  React.useLayoutEffect(() => {
    if (!isStreaming) return
    const content = contentInnerRef.current
    if (!content) return

    const frame = requestAnimationFrame(scrollToLatest)
    const observer = new ResizeObserver(scrollToLatest)
    observer.observe(content)
    return () => {
      cancelAnimationFrame(frame)
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current)
        scrollFrameRef.current = null
      }
      observer.disconnect()
    }
  }, [isStreaming, scrollToLatest])

  React.useLayoutEffect(() => {
    if (isStreaming) scrollToLatest()
  }, [items, isStreaming, scrollToLatest])

  const handleScroll = React.useCallback(
    (event: React.UIEvent<HTMLDivElement>): void => {
      if (!isViewportAtBottom(event.currentTarget)) return
      followLatestRef.current = true
      scrollToLatest()
    },
    [scrollToLatest],
  )

  const handleScrollIntent = React.useCallback((): void => {
    smoothScrollTargetRef.current = null
    followLatestRef.current = false
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current)
      scrollFrameRef.current = null
    }
  }, [])

  React.useEffect(() => {
    if (isContentExpanded) {
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
      setShouldRenderContent(true)
      setMeasuredHeight(undefined)
      return
    }

    const el = contentRef.current
    if (el) {
      const h = el.clientHeight
      setMeasuredHeight(h)
      collapseFrameRef.current = requestAnimationFrame(() => {
        collapseFrameRef.current = null
        setMeasuredHeight(0)
      })
    }

    const timer = window.setTimeout(() => setShouldRenderContent(false), COLLAPSE_DURATION_MS)
    return () => {
      window.clearTimeout(timer)
      if (collapseFrameRef.current !== null) {
        cancelAnimationFrame(collapseFrameRef.current)
        collapseFrameRef.current = null
      }
    }
  }, [isContentExpanded])

  const effectiveSummary = summary ?? buildProcessGroupSummary(items)

  return (
    <div data-ai-id="process-block-group" style={{ display: 'flex', flexDirection: 'column' }}>
      <button
        type="button"
        data-ai-id="process-block-group-toggle"
        onClick={() => {
          userToggledRef.current = true
          clearAutoCollapseTimers()
          setCollapseCountdown(null)
          setDisplayMode((previous) => (previous === 'collapsed' ? 'expanded' : 'collapsed'))
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          padding: 'var(--space-2) var(--space-3)',
          background: 'var(--glass-bg-soft)',
          border: '1px solid var(--color-border)',
          borderRadius: 'var(--radius-full)',
          fontSize: 'var(--font-size-xs)',
          color: 'var(--color-text-muted)',
          cursor: 'pointer',
          maxWidth: 'fit-content',
          transition: 'opacity var(--transition-fast)',
          textAlign: 'left',
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = '0.75')}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = '1')}
      >
        <ArrowRight
          size={13}
          style={{
            flexShrink: 0,
            transition: 'transform var(--transition-fast)',
            transform: isContentExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
          }}
        />
        <span style={{ color: 'var(--color-text)', fontWeight: 500 }}>{effectiveSummary}</span>
        {collapseCountdown !== null && (
          <span style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-muted)' }}>
            （{collapseCountdown}）
          </span>
        )}
      </button>

      {shouldRenderContent && (
        <div
          ref={contentRef}
          onScroll={handleScroll}
          onPointerDown={handleScrollIntent}
          onWheel={handleScrollIntent}
          onTouchStart={handleScrollIntent}
          style={{
            overflow: 'hidden',
            maxHeight: isContentExpanded ? `${VIEWPORT_HEIGHT}px` : undefined,
            height: measuredHeight !== undefined ? `${measuredHeight}px` : 'auto',
            opacity: isContentExpanded ? 1 : 0,
            transition: measuredHeight !== undefined
              ? `height ${COLLAPSE_DURATION_MS}ms ease-in-out, opacity ${COLLAPSE_DURATION_MS}ms ease-in-out`
              : `opacity ${COLLAPSE_DURATION_MS}ms ease-in-out`,
            overflowY: isContentExpanded && measuredHeight === undefined ? 'auto' : 'hidden',
          }}
        >
          <div
            ref={contentInnerRef}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              paddingTop: 'var(--space-2)',
            }}
          >
            {items.map((item) => (
              <React.Fragment key={item.key}>{renderItem(item)}</React.Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default ProcessBlockGroup

import { useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

export const CONVERSATION_WIDTH_KEY = 'bloma.workspace.conversation-width.v1'
const DEFAULT_WIDTH = 370
const MIN_WIDTH = 280
const MAX_WIDTH = 600
const PREVIEW_MIN_WIDTH = 340
const DIVIDER_WIDTH = 18

function readPreferredWidth(): number {
  try {
    const value = Number(localStorage.getItem(CONVERSATION_WIDTH_KEY))
    if (Number.isFinite(value) && value >= MIN_WIDTH && value <= MAX_WIDTH) return value
  } catch { /* Storage can be unavailable; resizing still works for this visit. */ }
  return DEFAULT_WIDTH
}

/** A display preference, independent of project/session data. Narrow windows retain the preferred width. */
export function useConversationWidth() {
  const containerRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; width: number } | null>(null)
  const [preferred, setPreferred] = useState(readPreferredWidth)
  const [available, setAvailable] = useState(0)
  const [resizing, setResizing] = useState(false)
  const maximum = available > 0 ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - PREVIEW_MIN_WIDTH - DIVIDER_WIDTH)) : MAX_WIDTH
  const width = Math.min(preferred, maximum)
  const latest = useRef(preferred)
  const change = (value: number) => {
    latest.current = Math.round(Math.max(MIN_WIDTH, Math.min(maximum, value)))
    setPreferred(latest.current)
  }
  const persist = () => {
    try { localStorage.setItem(CONVERSATION_WIDTH_KEY, String(latest.current)) } catch { /* Keep the in-memory preference. */ }
  }
  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return
    const measure = () => {
      const style = getComputedStyle(container)
      const measured = container.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0')
      if (measured > 0) setAvailable(measured)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(entries => {
        const measured = entries[0]?.contentRect.width
        if (measured && measured > 0) setAvailable(measured)
      })
      observer.observe(container)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  const finish = () => {
    if (!drag.current) return
    drag.current = null
    setResizing(false)
    persist()
  }
  return {
    containerRef, width, resizing,
    separatorProps: {
      'aria-valuemin': MIN_WIDTH,
      'aria-valuemax': Math.round(maximum),
      'aria-valuenow': width,
      'aria-valuetext': `${width} 像素`,
      onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = { x: event.clientX, width }
        setResizing(true)
        event.currentTarget.setPointerCapture?.(event.pointerId)
      },
      onPointerMove: (event: PointerEvent<HTMLButtonElement>) => {
        if (drag.current) change(drag.current.width + event.clientX - drag.current.x)
      },
      onPointerUp: finish,
      onPointerCancel: finish,
      onLostPointerCapture: finish,
      onDoubleClick: () => { change(DEFAULT_WIDTH); persist() },
      onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
        const value = event.key === 'ArrowLeft' ? width - 20 : event.key === 'ArrowRight' ? width + 20
          : event.key === 'Home' ? MIN_WIDTH : event.key === 'End' ? maximum : undefined
        if (value === undefined) return
        event.preventDefault()
        change(value)
        persist()
      },
    },
  }
}

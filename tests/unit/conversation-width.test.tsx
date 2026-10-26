// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_WIDTH_KEY, useConversationWidth } from '../../renderer/hooks/use-conversation-width'

function Fixture({ side = 'left' }: { side?: 'left' | 'right' }) {
  const { containerRef, width, separatorProps } = useConversationWidth(side)
  return <div ref={containerRef}><button role="separator" aria-label="调整会话栏宽度" {...separatorProps} /><output>{width}</output></div>
}
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

describe('conversation width preference', () => {
  it('right pane starts at 300px and grows when its left edge moves left', () => {
    localStorage.setItem(CONVERSATION_WIDTH_KEY, 'invalid-width')
    render(<Fixture side="right" />)
    const separator = screen.getByRole('separator')
    expect(separator.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.keyDown(separator, { key: 'ArrowLeft' })
    expect(separator.getAttribute('aria-valuenow')).toBe('320')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator.getAttribute('aria-valuenow')).toBe('300')
    fireEvent.doubleClick(separator)
    expect(localStorage.getItem(CONVERSATION_WIDTH_KEY)).toBe('300')
  })
  it('keyboard changes persist across remount and double click restores the default', () => {
    const view = render(<Fixture />)
    const separator = screen.getByRole('separator')
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(separator.getAttribute('aria-valuenow')).toBe('390')
    expect(localStorage.getItem(CONVERSATION_WIDTH_KEY)).toBe('390')
    view.unmount()
    render(<Fixture />)
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('390')
    fireEvent.doubleClick(screen.getByRole('separator'))
    expect(localStorage.getItem(CONVERSATION_WIDTH_KEY)).toBe('370')
  })

  it('constrains the displayed width to keep the preview usable without destroying a wider-window preference', () => {
    localStorage.setItem(CONVERSATION_WIDTH_KEY, '550')
    let resize!: ResizeObserverCallback
    vi.stubGlobal('ResizeObserver', class { constructor(callback: ResizeObserverCallback) { resize = callback } observe() {} disconnect() {} })
    render(<Fixture />)
    act(() => resize([{ contentRect: { width: 800 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('442')
    expect(localStorage.getItem(CONVERSATION_WIDTH_KEY)).toBe('550')
    act(() => resize([{ contentRect: { width: 1100 } } as ResizeObserverEntry], {} as ResizeObserver))
    expect(screen.getByRole('separator').getAttribute('aria-valuenow')).toBe('550')
  })

  it('invalid storage falls back safely and Home/End respect accessible bounds', () => {
    localStorage.setItem(CONVERSATION_WIDTH_KEY, 'not-a-width')
    render(<Fixture />)
    const separator = screen.getByRole('separator')
    expect(separator.getAttribute('aria-valuenow')).toBe('370')
    fireEvent.keyDown(separator, { key: 'Home' })
    expect(separator.getAttribute('aria-valuenow')).toBe('280')
    fireEvent.keyDown(separator, { key: 'End' })
    expect(separator.getAttribute('aria-valuenow')).toBe('600')
  })
})

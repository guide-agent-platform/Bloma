// @vitest-environment jsdom
import React from 'react'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioCompanion, StudioFumoNote, StudioFumoAvatar } from '../../renderer/components/StudioCompanion'

const animate = vi.fn(() => ({ cancel: vi.fn() }))
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  animate.mockClear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate })
})
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
})
const pose = () => document.querySelector('[data-ai-id="studio-companion"]')!.getAttribute('data-pose')
const tick = (duration: number) => act(() => vi.advanceTimersByTime(duration))

describe('adult studio companion reactions', () => {
  it('one ordinary click responds with a wave and returns to the default pose', () => {
    render(<StudioCompanion />)
    fireEvent.click(screen.getByRole('button', { name: '和向导打个招呼' }))
    expect(pose()).toBe('wave')
    expect(screen.getByRole('status').textContent).toBe('嗯？叫我？')
    tick(1800)
    expect(pose()).toBe('neutral')
  })
  it('five quick clicks cause blush and a raised fist; further clicks do not prolong it forever', () => {
    render(<StudioCompanion />)
    const button = screen.getByRole('button', { name: '和向导打个招呼' })
    for (let i = 0; i < 5; i++) fireEvent.click(button)
    expect(pose()).toBe('blush')
    expect(screen.getByRole('status').textContent).toContain('不许再戳')
    tick(3000); fireEvent.click(button); tick(600)
    expect(pose()).toBe('neutral')
  })
  it('spaced clicks never accumulate into anger and unmount cancels the reaction timer', () => {
    const view = render(<StudioCompanion />)
    const button = screen.getByRole('button', { name: '和向导打个招呼' })
    for (let i = 0; i < 6; i++) { fireEvent.click(button); expect(pose()).toBe('wave'); tick(2000) }
    fireEvent.click(button); view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('sidebar plush responds to a poke then recovers, while the chat avatar remains decorative', () => {
    const view = render(<><StudioFumoNote /><StudioFumoAvatar /></>)
    expect(view.container.querySelectorAll('img')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '摸摸布偶' }))
    expect(screen.getByText('……摸到了。')).toBeTruthy()
    expect(animate).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('.studio-fumo-avatar')?.closest('button')).toBeNull()
    tick(1800)
    expect(screen.queryByText('……摸到了。')).toBeNull()
    view.unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('restarts the visual pulse without moving or replacing the clickable target', () => {
    render(<StudioCompanion />)
    const button = screen.getByRole('button', { name: '和向导打个招呼' })
    fireEvent.click(button)
    const previous = animate.mock.results[0]!.value
    fireEvent.click(button)
    expect(previous.cancel).toHaveBeenCalledTimes(1)
    expect(animate).toHaveBeenCalledTimes(2)
    expect(screen.getByRole('button', { name: '和向导打个招呼' })).toBe(button)
  })
  it('reduced motion keeps pose and text feedback without spring movement', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    render(<><StudioCompanion /><StudioFumoNote /></>)
    fireEvent.click(screen.getByRole('button', { name: '和向导打个招呼' }))
    fireEvent.click(screen.getByRole('button', { name: '摸摸布偶' }))
    expect(pose()).toBe('wave')
    expect(screen.getByText('……摸到了。')).toBeTruthy()
    expect(animate).not.toHaveBeenCalled()
  })
})

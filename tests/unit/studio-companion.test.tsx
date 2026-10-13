// @vitest-environment jsdom
import React from 'react'
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StudioCompanion, StudioFumoNote, StudioFumoAvatar } from '../../renderer/components/StudioCompanion'

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }))
afterEach(() => { cleanup(); vi.useRealTimers() })
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
  it('retains the plush as static artwork without clickable actions or reaction timers', () => {
    const view = render(<><StudioFumoNote /><StudioFumoAvatar /></>)
    expect(view.container.querySelectorAll('img')).toHaveLength(2)
    expect(screen.queryByRole('button')).toBeNull()
    fireEvent.click(view.container.querySelector('img')!)
    expect(vi.getTimerCount()).toBe(0)
  })
})

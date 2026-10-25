// @vitest-environment jsdom
import React from 'react'
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SketchViewport } from '../../renderer/components/SketchViewport'
import { stripSketchReviewChrome } from '../../shared/sketch-viewport'

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(664)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(424)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

function report(frame: HTMLIFrameElement, width: number, height: number, source: MessageEventSource | null = frame.contentWindow) {
  const post = vi.spyOn(frame.contentWindow!, 'postMessage')
  fireEvent.load(frame)
  const request = post.mock.calls.at(-1)![0] as { token: string }
  act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { type: 'bloma-viewport-size', token: request.token, width, height } })))
}

it('fits the full tall document, rejects other senders and malformed dimensions, and preserves the opaque sandbox', () => {
  render(<SketchViewport src="bloma-file://p/00_UX/confirmed.html" readOnly />)
  const frame = document.querySelector('iframe')!
  expect(frame.src).toContain('bloma-viewport=1')
  expect(frame.src).toContain('bloma-readonly=1')
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts')
  fireEvent.click(screen.getByRole('button', { name: '完整画布' }))
  report(frame, 1280, 2400, window)
  expect(frame.style.height).toBe('800px')
  report(frame, Infinity, 2400)
  expect(frame.style.height).toBe('800px')
  report(frame, 1280, 2400)
  expect(frame.style.height).toBe('2400px')
  expect(screen.getByText('17%')).toBeTruthy()
})

it('manual zoom and returning to fit keep the same live iframe and reset canvas scroll', () => {
  render(<SketchViewport html="<!doctype html><p>底部内容</p>" />)
  const frame = document.querySelector('iframe')!
  report(frame, 1280, 2400)
  fireEvent.click(screen.getByRole('button', { name: '原尺寸' }))
  expect(screen.getByText('100%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '缩小草图' }))
  expect(screen.getByText('80%')).toBeTruthy()
  const surface = document.querySelector('.sketch-surface')!
  surface.scrollTop = 500
  fireEvent.click(screen.getByRole('button', { name: '完整画布' }))
  expect(screen.getByText('17%')).toBeTruthy()
  expect(surface.scrollTop).toBe(0)
  expect(document.querySelector('iframe')).toBe(frame)
})

it('a different sketch resets dimensions and zoom, while correction mode uses its original viewport', () => {
  const { rerender } = render(<SketchViewport html="<p>第一版</p>" />)
  report(document.querySelector('iframe')!, 1600, 3000)
  fireEvent.click(screen.getByRole('button', { name: '原尺寸' }))
  rerender(<SketchViewport html="<p>第二版</p>" />)
  expect(document.querySelector('iframe')!.style.height).toBe('800px')
  expect(screen.getByText('50%')).toBeTruthy()
  rerender(<SketchViewport html="<p>第二版</p>" natural />)
  expect(screen.getByText('100%')).toBeTruthy()
  expect((screen.getByRole('button', { name: '完整画布' }) as HTMLButtonElement).disabled).toBe(true)
})

it('keeps the whole design by default and offers window-width rendering only on explicit selection', () => {
  render(<SketchViewport html="<p>正常字号的课程笔记</p>" />)
  const frame = document.querySelector('iframe')!
  expect(frame.style.width).toBe('1280px'); expect(screen.getByText('50%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '适应窗口' }))
  expect(frame.style.width).toBe('640px'); expect(frame.style.height).toBe('400px')
  report(frame, 1280, 2400)
  expect(frame.style.height).toBe('400px'); expect(screen.getByText('100%')).toBeTruthy()
  expect(screen.getByRole('button', { name: '适应窗口' }).getAttribute('aria-pressed')).toBe('true')
})

it('removes only platform correction chrome in read-only reviews, leaving the saved document and product markup intact', () => {
  const original = '<html><body><h1>课程笔记</h1><script>product()</script><style id="bloma-sketch-corrector-style">chrome</style><script id="bloma-sketch-corrector">review()</script></body></html>'
  const clean = stripSketchReviewChrome(original)
  expect(clean).toContain('<h1>课程笔记</h1>'); expect(clean).toContain('product()')
  expect(clean).not.toContain('review()'); expect(clean).not.toContain('corrector-style')
  expect(original).toContain('review()')
})

it('enables click interception only after the user explicitly starts marking', () => {
  render(<SketchViewport src="bloma-file://p/00_UX/ux-sketch.html" />)
  const frame = document.querySelector('iframe')!
  expect(frame.src).toContain('bloma-readonly=1')
  fireEvent.click(screen.getByRole('button', { name: '标记修改' }))
  expect(frame.src).toContain('bloma-readonly=0')
  fireEvent.click(screen.getByRole('button', { name: '退出标记' }))
  expect(frame.src).toContain('bloma-readonly=1')
})

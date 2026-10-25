// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SketchCharacterReminder } from '../../renderer/components/SketchCharacterReminder'
import { SketchViewport } from '../../renderer/components/SketchViewport'
import { PREVIEW_POINTER_EVENT } from '../../shared/sketch-viewport'
let callbacks: Map<number, FrameRequestCallback>, sequence: number
beforeEach(() => {
  sessionStorage.clear(); callbacks = new Map(); sequence = 0
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callbacks.set(++sequence, fn); return sequence })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => callbacks.delete(id))
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 350, 420)] as unknown as DOMRectList)
})
afterEach(() => { cleanup(); document.querySelectorAll('[data-preview-fixture]').forEach(node => node.remove()); vi.restoreAllMocks(); vi.unstubAllGlobals(); sessionStorage.clear() })
const flush = () => act(() => { const pending = [...callbacks.values()]; callbacks.clear(); pending.forEach(fn => fn(0)) })
function fixture() {
  const target = document.createElement('div'); target.dataset.previewFixture = 'true'; document.body.appendChild(target)
  target.getBoundingClientRect = () => new DOMRect(500, 100, 600, 600)
  const view = render(<SketchCharacterReminder cue={crypto.randomUUID()} previewRef={{ current: target }} />)
  fireEvent.load(document.querySelector('[data-guide-body]')!)
  fireEvent.load(document.querySelector('[data-guide-arm-layer]')!)
  return { target, view, arm: document.querySelector('[data-guide-arm]')!, body: document.querySelector('[data-guide-body]')!, actor: document.querySelector('.guide-emergence-actor')! }
}
it('moves a separately painted arm behind a complete torso, coalesces frames, pauses and restores the neutral pose', () => {
  const { target, arm, body, actor, view } = fixture(), neutral = arm.getAttribute('transform'), original = body.outerHTML
  fireEvent.pointerMove(target, { clientX: 700, clientY: 150 }); fireEvent.pointerMove(target, { clientX: 710, clientY: 160 })
  expect(callbacks.size).toBe(1); flush(); const upper = arm.getAttribute('transform')
  expect(upper).not.toBe(neutral); expect(actor.getAttribute('data-tracking')).toBe('true')
  fireEvent.pointerMove(target, { clientX: 1050, clientY: 650 }); flush(); expect(arm.getAttribute('transform')).not.toBe(upper)
  expect(body.outerHTML).toBe(original); expect(body.getAttribute('clip-path')).toBeNull()
  expect(document.querySelector('[data-guide-composite]')?.lastElementChild).toBe(body)
  fireEvent.click(screen.getByRole('button', { name: '暂停跟随' })); expect(actor.getAttribute('data-tracking')).toBe('false')
  fireEvent.pointerMove(target, { clientX: 700, clientY: 600 }); flush(); expect(arm.getAttribute('transform')).toBe(neutral)
  fireEvent.click(screen.getByRole('button', { name: '开启跟随' })); fireEvent.pointerMove(target, { clientX: 700, clientY: 600 }); flush()
  fireEvent.pointerMove(document.body, { clientX: 100, clientY: 100 }); flush(); expect(arm.getAttribute('transform')).toBe(neutral)
  view.unmount(); expect(callbacks.size).toBe(0)
})
it('respects reduced motion and retains a complete static character', () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes('prefers-reduced-motion'), addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const { target, arm, body } = fixture(), neutral = arm.getAttribute('transform')
  expect((screen.getByRole('button', { name: '静态引导' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.pointerMove(target, { clientX: 700, clientY: 600 }); flush(); expect(arm.getAttribute('transform')).toBe(neutral)
  expect(body.getAttribute('clip-path')).toBeNull()
})
it('keeps an intact reference while layers load and falls back on an asset error', () => {
  render(<SketchCharacterReminder cue={crypto.randomUUID()} />)
  expect(document.querySelector('[data-guide-reference]')?.getAttribute('opacity')).toBe('1')
  expect(document.querySelector('[data-guide-composite]')?.getAttribute('opacity')).toBe('0')
  fireEvent.error(document.querySelector('[data-guide-arm-layer]')!)
  expect((screen.getByRole('button', { name: '静态引导' }) as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('[data-guide-reference]')?.getAttribute('opacity')).toBe('1')
})
it('relays only the current iframe/token and bounded coordinates, including scaled previews', () => {
  render(<SketchViewport html="<p>预览</p>" />)
  const frame = document.querySelector('iframe')!, post = vi.spyOn(frame.contentWindow!, 'postMessage'), listener = vi.fn()
  frame.getBoundingClientRect = () => new DOMRect(600, 100, 640, 400)
  fireEvent.load(frame); const token = (post.mock.calls.at(-1)![0] as { token: string }).token
  window.addEventListener(PREVIEW_POINTER_EVENT, listener)
  const relay = (source: MessageEventSource | null, input: Record<string, unknown>) => act(() => window.dispatchEvent(new MessageEvent('message', { source, data: { type: PREVIEW_POINTER_EVENT, token, x: .25, y: .75, inside: true, ...input } })))
  relay(window, {}); relay(frame.contentWindow, { token: 'foreign' }); relay(frame.contentWindow, { x: Infinity }); relay(frame.contentWindow, { x: 2 })
  expect(listener).not.toHaveBeenCalled(); relay(frame.contentWindow, {})
  expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ clientX: 760, clientY: 400, inside: true })
  window.removeEventListener(PREVIEW_POINTER_EVENT, listener)
})
